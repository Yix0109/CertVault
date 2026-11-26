// CertVault 服务器版（NAS / Docker / 局域网单机部署）
// ---------------------------------------------------------------------------
// 契约来源：docs/接口契约-服务器版.md（唯一事实来源；禁止在实现里自行改名、改路径、改错误码）
// 零第三方依赖：只用 node:http / node:fs / node:path / node:crypto / node:url / node:os
// 数据目录与桌面版「数据\」完全同构，可直接把桌面版的数据文件夹拷进 $CV_DATA
//
// 关键实现要点：
//   1. 原子写：先写 <file>.tmp 再 rename，失败清理 tmp，避免留下半截 JSON；
//   2. 串行写队列：所有写请求在进程内单条 Promise 队列里执行，避免两个客户端交错写坏文件；
//   3. 口令用 scrypt（salt 随账号存 users.json），token = base64url(payload) + '.' + HMAC-SHA256(secret)；
//   4. 认证双通道：Authorization: Bearer 优先，Cookie cv_token 兜底（同一服务常被局域网 IP 与域名两个 origin 访问）；
//   5. 错误体统一 {error:{code,message}}，message 必须是中文可读。
//
// 运行：node server/server.js
//   （server/package.json 标记 type=commonjs，避免被仓库根 package.json 的 type=module 影响；
//     容器里 /srv/server.js 没有 package.json 时默认也是 CommonJS，两边都能跑。）
'use strict';

// 时区必须在任何 Date 使用之前设置：备份文件名、截图文件名都用本地时间
process.env.TZ = process.env.CV_TZ || process.env.TZ || 'Asia/Shanghai';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const APP_NAME = 'CertVault';
const APP_VERSION = '1.0.0';
const DATA_ROOT = path.resolve(process.env.CV_DATA || '/data');
const LISTEN_PORT = Number(process.env.CV_PORT || 8080);
const LISTEN_HOST = process.env.CV_HOST || '0.0.0.0';

const DATA_DIR = path.join(DATA_ROOT, 'data');
const IMAGES_DIR = path.join(DATA_ROOT, 'images');
const BACKUP_DIR = path.join(DATA_ROOT, 'backup');
const RECORDS_FILE = path.join(DATA_DIR, 'certvault.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
const LOCK_FILE = path.join(DATA_DIR, '.lock');
const USERS_FILE = path.join(DATA_ROOT, 'users.json');
const CONFIG_FILE = path.join(DATA_ROOT, 'config.json');
const REVOKED_FILE = path.join(DATA_DIR, 'revoked.json'); // 已登出/空闲超时 token 的持久化吊销表

// 与桌面版 app/store.js 的 DEFAULT_SETTINGS 保持完全一致
const DEFAULT_SETTINGS = {
  version: 1,
  trayMinimize: true,
  autostart: false,
  popupIntervalHours: 12,
  backupBeforeDanger: true,
  lastPopupAt: null,
  lastOpen: null,
};

const DAY_SECONDS = 24 * 60 * 60;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;      // 单张截图 8MB 上限
const MAX_IMAGES_PER_RECORD = 8;              // 单条记录最多 8 张截图
const MAX_JSON_BYTES = 2 * 1024 * 1024;       // 普通 JSON 请求体上限
const MAX_RECORDS_BYTES = 32 * 1024 * 1024;   // 台账整体覆盖写上限（记录多、截图元数据多时体积大）
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;    // 截图上传请求体上限（8 张 × 8MB 再留余量）
const BACKUP_KEEP = 10;                       // 备份只留最近 10 份
const BACKUP_RE = /^\d{8}-\d{6}-[A-Za-z0-9_-]+\.json$/;
// 契约 §12 固定的审计动作集合（服务端自记 + 客户端可上报的都必须在集合内）
const AUDIT_ACTIONS = [
  'login', 'login_failed', 'logout',
  'record_add', 'record_edit', 'record_delete', 'record_import', 'record_export',
  'image_add', 'image_delete', 'settings_update', 'backup_create',
  'user_register', 'user_approve', 'user_reject', 'user_role', 'user_status', 'user_reset_password',
  'password_change',
];
const AUDIT_ACTION_SET = new Set(AUDIT_ACTIONS);
// 非管理员允许自助上报的动作（身份取 token，避免普通账号伪造审批类留痕）
const AUDIT_CLIENT_ACTIONS = new Set(['record_export', 'record_import', 'password_change']);

const AUDIT_KEEP = 5000;                      // 审计日志最多保留 5000 条（多用户后放宽）
const AUDIT_PAGE = 200;                       // GET /api/audit 默认返回最近 200 条
const LOCK_STALE_MS = 4 * 60 * 60 * 1000;     // 占用标记超过 4 小时视为陈旧
const DEFAULT_SESSION_TTL = 7 * DAY_SECONDS;  // 登录默认 7 天
const DEFAULT_MAX_TTL = 3650 * DAY_SECONDS;   // 「永久」= 3650 天
const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };
const ROLE_LABEL = { viewer: '查看', editor: '编辑', admin: '管理员' };
const STARTED_AT = Date.now();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
};

// ---------------------------------------------------------------------------
// 通用工具：日志、时间、格式、目录、原子读写
// ---------------------------------------------------------------------------
function log(message) {
  console.log('[' + new Date().toISOString() + '] ' + message);
}

function isoNow() {
  return new Date().toISOString();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 本地时间戳 yyyyMMdd-HHmmss（备份文件名 / 截图文件名，与桌面版一致）
function stampCompact(date) {
  const d = date || new Date();
  return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

// 短随机串（十六进制），截图文件名用
function randToken(len) {
  const need = Math.max(1, Math.min(32, Number(len) || 4));
  return crypto.randomBytes(16).toString('hex').slice(0, need);
}

// 人类可读体积（中文错误消息里用）
function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function ensureDirs() {
  for (const dir of [DATA_ROOT, DATA_DIR, IMAGES_DIR, BACKUP_DIR]) fs.mkdirSync(dir, { recursive: true });
}

function statOrNull(file) {
  try { return fs.statSync(file); } catch (err) { return null; }
}

function readJsonFile(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
  const clean = String(text).replace(/^\uFEFF/, '');
  try {
    return JSON.parse(clean);
  } catch (err) {
    throw new Error(path.basename(file) + ' 内容不是合法 JSON，文件可能已损坏（可从 backup 目录恢复）');
  }
}

// 原子写：tmp + rename；失败清理 tmp
function writeFileAtomic(file, data) {
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (ignored) { /* tmp 可能没写出来，忽略 */ }
    throw err;
  }
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2));
}

// 进程内串行写队列：所有写盘任务排队执行，保证不会交错
let writeChain = Promise.resolve();
function serialWrite(task) {
  const run = writeChain.then(task);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

// 统一错误：错误码固定集合（unauthorized/forbidden/not_found/conflict/payload_too_large/bad_request/internal）
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const STATUS_OF_CODE = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  bad_request: 400,
  internal: 500,
};

function apiError(code, message, status) {
  return new ApiError(status || STATUS_OF_CODE[code] || 500, code, message || '请求处理失败');
}

// ---------------------------------------------------------------------------
// 配置与账号（$CV_DATA/config.json、$CV_DATA/users.json）
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  user: 'admin',
  passHash: '',
  salt: '',
  createdAt: null,
  secret: '',
  sessionTtlSeconds: DEFAULT_SESSION_TTL,
  maxTtlSeconds: DEFAULT_MAX_TTL,
  idleTimeoutSeconds: 0,
};

let CONFIG = null; // 运行期配置（含 HMAC secret），启动时由 bootstrap() 装载

function loadConfig() {
  const parsed = readJsonFile(CONFIG_FILE, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return Object.assign({}, DEFAULT_CONFIG, parsed);
}

function saveConfig(config) {
  writeJsonAtomic(CONFIG_FILE, config);
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (ignored) { /* Windows 不支持 chmod，忽略 */ }
}

function readUsersDb() {
  const parsed = readJsonFile(USERS_FILE, null);
  if (!parsed) return { version: 1, users: [] };
  const users = Array.isArray(parsed) ? parsed : parsed.users;
  return { version: 1, users: Array.isArray(users) ? users : [] };
}

// 对外输出的账号（绝不带 passHash / salt）
function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role,
    status: user.status,
    device: user.device || '',
    ip: user.ip || '',
    createdAt: user.createdAt || null,
    approvedAt: user.approvedAt || null,
    approvedBy: user.approvedBy || null,
    lastLoginAt: user.lastLoginAt || null,
    loginCount: Number(user.loginCount) || 0,
    reason: user.reason == null ? null : user.reason,
  };
}

function findUserByName(users, name) {
  const key = String(name == null ? '' : name).trim().toLowerCase();
  if (!key) return null;
  for (const user of users) {
    if (String(user.username || '').toLowerCase() === key) return user;
  }
  return null;
}

function countActiveAdmins(users) {
  return users.filter((u) => u && u.role === 'admin' && u.status === 'active').length;
}

function makeUserRecord(input) {
  return {
    id: 'u_' + crypto.randomBytes(6).toString('hex'),
    username: input.username,
    displayName: input.displayName || input.username,
    passHash: input.passHash,
    salt: input.salt,
    tokenVersion: 1,
    role: input.role || 'viewer',
    status: input.status || 'pending',
    device: input.device || '',
    ip: input.ip || '',
    createdAt: isoNow(),
    approvedAt: input.approvedAt || null,
    approvedBy: input.approvedBy || null,
    reason: null,
    lastLoginAt: null,
    loginCount: 0,
  };
}

// ---------------------------------------------------------------------------
// 口令（scrypt）与 token（base64url payload + HMAC-SHA256）
// ---------------------------------------------------------------------------
const SCRYPT_KEYLEN = 64;

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(String(password), useSalt, SCRYPT_KEYLEN);
  return { salt: useSalt, passHash: 'scrypt$' + key.toString('hex') };
}

function verifyPassword(password, salt, passHash) {
  const hex = String(passHash || '').replace(/^scrypt\$/, '');
  if (!hex || !salt) return false;
  let expect;
  try { expect = Buffer.from(hex, 'hex'); } catch (err) { return false; }
  if (!expect.length) return false;
  let actual;
  try { actual = crypto.scryptSync(String(password), String(salt), expect.length); } catch (err) { return false; }
  return actual.length === expect.length && crypto.timingSafeEqual(actual, expect);
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(text) {
  const raw = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const pad = raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4));
  return Buffer.from(raw + pad, 'base64').toString('utf8');
}

function signToken(payload) {
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(crypto.createHmac('sha256', CONFIG.secret).update(body).digest());
  return body + '.' + signature;
}

// 校验 token：签名 + 结构；过期 / 吊销 / 账号状态 / tokenVersion 由 authenticate() 判定
function verifyToken(token) {
  const text = String(token || '').trim();
  const dot = text.indexOf('.');
  if (dot <= 0 || dot === text.length - 1) return null;
  const body = text.slice(0, dot);
  const signature = text.slice(dot + 1);
  const expect = base64url(crypto.createHmac('sha256', CONFIG.secret).update(body).digest());
  const a = Buffer.from(signature);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(base64urlDecode(body)); } catch (err) { return null; }
  if (!payload || typeof payload !== 'object') return null;
  return payload;
}

// 会话时长夹紧：缺省取 config.sessionTtlSeconds，上限 config.maxTtlSeconds
function clampTtl(want) {
  const max = Number(CONFIG.maxTtlSeconds) > 0 ? Number(CONFIG.maxTtlSeconds) : DEFAULT_MAX_TTL;
  let ttl = Number(want);
  if (!Number.isFinite(ttl) || ttl <= 0) ttl = Number(CONFIG.sessionTtlSeconds) || DEFAULT_SESSION_TTL;
  return Math.max(60, Math.min(Math.floor(ttl), max));
}

// 签发 token：payload = {u:用户 id, n:用户名, role, iat, exp, jti, tv:tokenVersion}
// tv 用于「重置密码后立刻吊销该用户全部旧 token」；role 以 users.json 为准（token 里的 role 只作展示）
function issueToken(user, ttlSeconds) {
  const ttl = clampTtl(ttlSeconds);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    u: user.id,
    n: user.username,
    role: user.role,
    iat: now,
    exp: now + ttl,
    jti: crypto.randomBytes(9).toString('base64url'),
    tv: Number(user.tokenVersion) || 1,
  };
  return {
    token: signToken(payload),
    payload: payload,
    ttlSeconds: ttl,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

// 首次启动 bootstrap：没有 users.json 时用 CV_USER / CV_PASS 建首个管理员；CV_PASS 为空拒绝启动（契约 §11.2）
function bootstrap() {
  ensureDirs();
  loadRevokedJti(); // 先载入持久化吊销表：重启前已登出的 token 必须继续 401
  let config = loadConfig();
  let usersDb = readUsersDb();

  if (!config) {
    config = Object.assign({}, DEFAULT_CONFIG, { createdAt: isoNow(), secret: crypto.randomBytes(32).toString('hex') });
  }
  if (!config.secret) config.secret = crypto.randomBytes(32).toString('hex');

  if (!usersDb.users.length) {
    const envUser = String(process.env.CV_USER || 'admin').trim() || 'admin';
    const envPass = String(process.env.CV_PASS || '');
    const username = config.user || envUser;
    let passHash = config.passHash || '';
    let salt = config.salt || '';
    if (envPass) {
      const hashed = hashPassword(envPass);
      passHash = hashed.passHash;
      salt = hashed.salt;
    } else if (!passHash) {
      console.error('【CertVault】首次启动必须设置环境变量 CV_PASS（首个管理员密码），否则服务会处于任何人都能登录的状态，已拒绝启动。');
      process.exit(1);
    }
    const admin = makeUserRecord({
      username: username,
      passHash: passHash,
      salt: salt,
      role: 'admin',
      status: 'active',
      device: '服务器',
    });
    admin.approvedAt = admin.createdAt;
    admin.approvedBy = 'system';
    usersDb = { version: 1, users: [admin] };
    writeJsonAtomic(USERS_FILE, usersDb);
    config.user = username;
    config.passHash = passHash;
    config.salt = salt;
    log('已创建首个管理员账号：' + username);
  } else if (!config.passHash) {
    // 老数据目录升级：把 users.json 里的管理员口令快照回填到 config.json（契约 §2 要求这三个字段）
    const admin = usersDb.users.find((u) => u && u.role === 'admin') || usersDb.users[0];
    if (admin) {
      config.user = admin.username;
      config.passHash = admin.passHash || '';
      config.salt = admin.salt || '';
    }
  }

  saveConfig(config);
  CONFIG = config;
}

// ---------------------------------------------------------------------------
// 认证：Bearer 优先，Cookie 兜底
// ---------------------------------------------------------------------------
// 已登出 / 已空闲超时的 jti：Map(jti → exp 秒)，持久化到 data/revoked.json，
// 服务重启后旧 Bearer 仍然 401（P1②；仅进程内 Set 的话重启即失效）
const revokedJti = new Map();
const lastSeenAt = new Map(); // jti → 最近访问毫秒（空闲超时判断）
const MAX_TRACKED_SESSIONS = 5000;
const REVOKED_KEEP = 10000; // 兜底上限：正常情况下按 exp 清理

function pruneRevokedJti() {
  const now = Math.floor(Date.now() / 1000);
  for (const [jti, exp] of revokedJti) {
    if (!(Number(exp) > now)) revokedJti.delete(jti);
  }
  while (revokedJti.size > REVOKED_KEEP) {
    const oldest = revokedJti.keys().next().value;
    if (oldest === undefined) break;
    revokedJti.delete(oldest);
  }
}

// 启动时载入吊销表；损坏时改名 .bad-<ts> 保留现场后按空表继续，绝不因此拒绝启动（P1② 兼容要求）
function loadRevokedJti() {
  revokedJti.clear();
  let parsed;
  try {
    parsed = readJsonFile(REVOKED_FILE, null);
  } catch (err) {
    const badFile = REVOKED_FILE + '.bad-' + Date.now();
    try { fs.renameSync(REVOKED_FILE, badFile); } catch (ignored) { /* 改名失败也继续启动 */ }
    console.error('【CertVault】吊销表损坏，已忽略并改名为 ' + path.basename(badFile) + '：' + (err && err.message ? err.message : err));
    return;
  }
  if (!parsed) return;
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.revoked) ? parsed.revoked : []);
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const jti = String(item.jti || '').trim();
    const exp = Number(item.exp) || 0;
    if (jti && exp > Math.floor(Date.now() / 1000)) revokedJti.set(jti, exp);
  }
  pruneRevokedJti();
}

// 同步原子写：调用点（logout / 超时）都发生在请求处理里，落盘完成后再响应
function persistRevokedJti() {
  pruneRevokedJti();
  const list = [];
  for (const [jti, exp] of revokedJti) list.push({ jti: jti, exp: exp });
  writeJsonAtomic(REVOKED_FILE, { version: 1, revoked: list });
}

function revokeJti(jti, exp) {
  const key = String(jti || '');
  if (!key) return;
  const expAt = Number(exp) > 0 ? Number(exp) : Math.floor(Date.now() / 1000) + DEFAULT_SESSION_TTL;
  revokedJti.set(key, expAt);
  try {
    persistRevokedJti();
  } catch (err) {
    // 磁盘异常时本次运行内仍然生效，不能因为落盘失败把已登出的 token 放回来
    console.error('【CertVault】写吊销表失败（本次运行内仍生效）：' + (err && err.message ? err.message : err));
  }
}

// 客户端 IP：默认只认 TCP 来源地址，绝不信任可伪造的 X-Forwarded-For（P1①）；
// 仅当显式 CV_TRUST_PROXY=1（前面确实有反向代理）时才解析 XFF，取最右一跳（离本机最近的那一项）。
const TRUST_PROXY = String(process.env.CV_TRUST_PROXY || '').trim() === '1';

function normalizeIp(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end > 0) text = text.slice(1, end); // [IPv6]:port → IPv6
  } else {
    const v4Port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(text);
    if (v4Port) text = v4Port[1]; // 1.2.3.4:5678 → 1.2.3.4
  }
  text = text.replace(/%.*$/, '').replace(/^::ffff:/i, ''); // 去掉 IPv6 zone id 与 IPv4-mapped 前缀
  const isV4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(text) && text.split('.').every((n) => Number(n) <= 255);
  const isV6 = /^[0-9a-fA-F:]+$/.test(text) && text.indexOf(':') >= 0 && text.split(':').length <= 9;
  return isV4 || isV6 ? text.toLowerCase() : '';
}

function clientIp(req) {
  const socketIp = normalizeIp(req.socket && req.socket.remoteAddress);
  if (!TRUST_PROXY) return socketIp || '未知';
  const hops = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((part) => normalizeIp(part))
    .filter(Boolean);
  if (hops.length) return hops[hops.length - 1]; // 最右一跳：最近代理追加的客户端地址
  return socketIp || '未知';
}

// 返回 null 表示「没有 Authorization 头」（交给 Cookie）；返回 '' 表示头存在但不合法（不再回退）
function bearerOf(req) {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : '';
}

function cookieOf(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try { return decodeURIComponent(value); } catch (err) { return value; }
  }
  return '';
}

// 返回 { user, payload, token, ip }；未登录 / token 失效返回 null；空闲超时返回 { idleExpired: true }
function authenticate(req) {
  const startedAt = Number(req._cvStartedAt) || Date.now();
  const headerToken = bearerOf(req);
  const token = headerToken === null ? cookieOf(req, 'cv_token') : headerToken;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const now = Date.now();
  if (!(Number(payload.exp) * 1000 > now)) return null;
  const jti = String(payload.jti || '');
  if (jti && revokedJti.has(jti)) return null;

  const db = readUsersDb();
  const user = db.users.find((u) => u && u.id === payload.u);
  if (!user) return null;
  if (user.status !== 'active') return null;
  if ((Number(user.tokenVersion) || 1) !== (Number(payload.tv) || 1)) return null;

  const idleSeconds = Number(CONFIG.idleTimeoutSeconds) || 0;
  if (idleSeconds > 0 && jti) {
    const last = lastSeenAt.get(jti) || (Number(payload.iat) || 0) * 1000;
    if (last > 0 && now - last > idleSeconds * 1000) {
      revokeJti(jti, payload.exp); // 空闲超时同样持久化吊销，重启后不能复活
      lastSeenAt.delete(jti);
      return { idleExpired: true };
    }
    lastSeenAt.set(jti, now);
    if (lastSeenAt.size > MAX_TRACKED_SESSIONS) {
      const oldest = lastSeenAt.keys().next().value;
      if (oldest) lastSeenAt.delete(oldest);
    }
  }
  return { user: user, payload: payload, token: token, ip: clientIp(req), startedAt: startedAt };
}

function requireAuth(req) {
  const session = authenticate(req);
  if (!session) throw apiError('unauthorized', '请先登录：缺少或失效的登录令牌');
  if (session.idleExpired) throw apiError('unauthorized', '登录已空闲超时，请重新登录');
  return session;
}

// 角色校验骨架：viewer < editor < admin，越权统一 403 forbidden（契约 §11.1）
function requireRole(session, role) {
  const need = ROLE_RANK[role] || ROLE_RANK.admin;
  const have = ROLE_RANK[session.user.role] || 0;
  if (have >= need) return session;
  if (need >= ROLE_RANK.admin) throw apiError('forbidden', '只有管理员可以执行该操作');
  throw apiError('forbidden', '当前账号只有查看权限，不能修改');
}

function setTokenCookie(res, token, ttlSeconds) {
  const maxAge = Math.max(0, Math.floor(Number(ttlSeconds) || 0));
  res.setHeader('Set-Cookie', 'cv_token=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge);
}

function clearTokenCookie(res) {
  res.setHeader('Set-Cookie', 'cv_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

// ---------------------------------------------------------------------------
// 审计日志（audit.json）
// ---------------------------------------------------------------------------
function readAuditEntries() {
  const parsed = readJsonFile(AUDIT_FILE, null);
  if (!parsed) return [];
  const entries = Array.isArray(parsed) ? parsed : parsed.entries;
  return Array.isArray(entries) ? entries : [];
}

function makeAuditEntry(session, action, options) {
  const opts = options || {};
  const now = isoNow();
  const user = session && session.user ? session.user : null;
  return {
    at: now,
    ts: now, // 桌面版日志面板读 ts，保持兼容
    userId: user ? user.id : null,
    username: user ? user.username : String(opts.username || ''),
    role: user ? user.role : String(opts.role || ''),
    action: String(action || ''),
    target: opts.target == null ? '' : String(opts.target),
    detail: opts.detail == null ? '' : String(opts.detail),
    ip: opts.ip || (session && session.ip) || '',
    ok: opts.ok !== false,
    ms: Number.isFinite(opts.ms)
      ? opts.ms
      : (session && Number.isFinite(session.startedAt) ? Math.max(0, Date.now() - session.startedAt) : 0),
  };
}

// 只能在串行写队列里调用（内部直接读写文件，不再入队，避免自锁）
function appendAuditEntries(entries) {
  if (!entries.length) return [];
  const all = readAuditEntries();
  for (const item of entries) all.push(item);
  writeJsonAtomic(AUDIT_FILE, { version: 1, entries: all.slice(-AUDIT_KEEP) });
  return entries;
}

function auditDirect(session, action, options) {
  try {
    appendAuditEntries([makeAuditEntry(session, action, options)]);
  } catch (err) {
    // 审计写失败不影响主流程（磁盘满等极端情况），但要留下服务端日志
    console.error('【CertVault】写审计日志失败：' + (err && err.message ? err.message : err));
  }
}

// 注册防刷：同一 IP 10 分钟内最多 5 次（契约 §11.3）
const registerHits = new Map();
function checkRegisterRate(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const hits = (registerHits.get(ip) || []).filter((t) => now - t < windowMs);
  if (hits.length >= 5) {
    registerHits.set(ip, hits);
    throw apiError('bad_request', '注册过于频繁，请稍后再试', 429);
  }
  hits.push(now);
  registerHits.set(ip, hits);
  if (registerHits.size > 5000) registerHits.clear();
}

// ---------------------------------------------------------------------------
// HTTP 输出辅助
// ---------------------------------------------------------------------------
function sendJson(res, status, body) {
  const text = JSON.stringify(body === undefined ? null : body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(text)));
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

function sendText(res, status, text, type) {
  const body = String(text == null ? '' : text);
  res.statusCode = status;
  res.setHeader('Content-Type', type || 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(body)));
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

// 统一错误体：{ error: { code, message } }
function sendFailure(res, err) {
  if (res.headersSent) {
    try { res.end(); } catch (ignored) { /* 连接已断，忽略 */ }
    return;
  }
  if (err instanceof ApiError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }
  console.error('【CertVault】未处理的异常：' + (err && err.stack ? err.stack : err));
  sendJson(res, 500, { error: { code: 'internal', message: '服务器内部错误，请查看服务端日志' } });
}

// CORS：局域网 IP 与域名是不同 origin，需要允许跨源携带 Bearer / Cookie
function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,If-Match,If-None-Match');
  res.setHeader('Access-Control-Expose-Headers', 'ETag,Content-Length');
  res.setHeader('Access-Control-Max-Age', '600');
}

// ---------------------------------------------------------------------------
// 请求体读取 / multipart 解析 / 图片宽高
// ---------------------------------------------------------------------------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(apiError('payload_too_large', '请求体 ' + formatBytes(declared) + ' 超过上限 ' + formatBytes(limit)));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        reject(apiError('payload_too_large', '请求体超过上限 ' + formatBytes(limit)));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function readJsonBody(req, limit) {
  const buf = await readBody(req, limit || MAX_JSON_BYTES);
  if (!buf.length) return {};
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) { throw apiError('bad_request', '请求体不是合法 JSON'); }
  return parsed;
}

// 解析 multipart/form-data，返回 [{ name, filename, type, data }]
function parseMultipart(buf, boundary) {
  const parts = [];
  const delimiter = Buffer.from('--' + boundary);
  let cursor = buf.indexOf(delimiter);
  while (cursor !== -1) {
    const after = cursor + delimiter.length;
    if (buf[after] === 0x2d && buf[after + 1] === 0x2d) break; // '--' 结束标志
    let headStart = after;
    if (buf[headStart] === 0x0d && buf[headStart + 1] === 0x0a) headStart += 2;
    const next = buf.indexOf(delimiter, headStart);
    if (next === -1) break;
    let end = next;
    if (buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;
    const chunk = buf.subarray(headStart, end);
    const split = chunk.indexOf('\r\n\r\n');
    if (split > 0) {
      const rawHeaders = chunk.subarray(0, split).toString('utf8');
      const data = chunk.subarray(split + 4);
      const headers = {};
      for (const line of rawHeaders.split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const disposition = headers['content-disposition'] || '';
      const nameMatch = /name="([^"]*)"/i.exec(disposition);
      const fileMatch = /filename="([^"]*)"/i.exec(disposition);
      let filename = fileMatch ? fileMatch[1] : '';
      if (!filename) {
        const star = /filename\*=([^;]+)/i.exec(disposition);
        if (star) {
          const raw = star[1].trim().replace(/^UTF-8''/i, '');
          try { filename = decodeURIComponent(raw); } catch (err) { filename = raw; }
        }
      }
      parts.push({
        name: nameMatch ? nameMatch[1] : '',
        filename: filename,
        type: headers['content-type'] || '',
        data: data,
      });
    }
    cursor = next;
  }
  return parts;
}

// 从文件头读图片宽高（失败返回 0,0，不影响上传成功）
function imageSize(buf) {
  try {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const format = buf.toString('ascii', 12, 16);
      if (format === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (format === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (format === 'VP8X') return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const length = buf.readUInt16BE(i + 2);
        if (length < 2) break;
        const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
        if (isSof) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + length;
      }
    }
  } catch (err) {
    // 宽高读不出来不算失败，记 0 即可
  }
  return { w: 0, h: 0 };
}

function extOf(fileName, mime) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(fileName || ''));
  if (match) {
    const ext = match[1].toLowerCase();
    if (ext && ext !== 'tmp') return ext;
  }
  const typed = /^image\/([a-z0-9.+-]+)$/i.exec(String(mime || ''));
  if (typed) {
    const ext = typed[1].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (ext === 'jpeg') return 'jpg';
    if (ext) return ext;
  }
  return 'png';
}

function safeSegment(raw, label) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) throw apiError('bad_request', label + '不能为空');
  if (text === '.' || text === '..' || /[\\/\u0000]/.test(text) || text.length > 200) {
    throw apiError('bad_request', label + '不合法');
  }
  return text;
}

function listImageFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

function countImageFiles() {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(IMAGES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      total += listImageFiles(path.join(IMAGES_DIR, entry.name)).length;
    }
  } catch (err) {
    // 统计失败不影响健康检查
  }
  return total;
}

// ---------------------------------------------------------------------------
// 静态站点：/ → app/index.html；禁止 .. 穿越；html 不缓存
// ---------------------------------------------------------------------------
let cachedAppRoot;
function appRoot() {
  if (cachedAppRoot !== undefined) return cachedAppRoot;
  const candidates = [];
  if (process.env.CV_APP_DIR) candidates.push(path.resolve(process.env.CV_APP_DIR));
  candidates.push(path.join(__dirname, 'app'));        // 容器：/srv/app
  candidates.push(path.join(__dirname, '..', 'app'));  // 仓库：server/../app
  for (const dir of candidates) {
    if (statOrNull(path.join(dir, 'index.html'))) { cachedAppRoot = dir; return dir; }
  }
  cachedAppRoot = null;
  return null;
}

function hasHiddenSegment(relPath) {
  return relPath.split(/[\\/]+/).some((segment) => segment.startsWith('.') && segment.length > 1);
}

function handleStatic(req, res, pathname) {
  const root = appRoot();
  if (!root) return sendText(res, 404, '404 未找到：静态站点目录 app 不存在');
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') return sendText(res, 405, '405 静态资源只支持 GET');
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!rel || hasHiddenSegment(rel)) return sendText(res, 404, '404 未找到：' + pathname);
  let file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return sendText(res, 404, '404 未找到：' + pathname);
  let stat = statOrNull(file);
  if (stat && stat.isDirectory()) {
    file = path.join(file, 'index.html');
    stat = statOrNull(file);
  }
  if (!stat || !stat.isFile()) return sendText(res, 404, '404 未找到：' + pathname);
  const ext = path.extname(file).toLowerCase();
  const etag = '"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', ext === '.html' || ext === '.htm' ? 'no-cache' : 'max-age=0, must-revalidate');
  if (String(req.headers['if-none-match'] || '') === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  if (method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(file);
  stream.on('error', () => { try { res.destroy(); } catch (ignored) { /* 已断开 */ } });
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// 备份 / 占用标记 / 台账 / 设置的小工具
// ---------------------------------------------------------------------------
function stampToTime(name) {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(String(name || ''));
  if (!match) return 0;
  return new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]).getTime();
}

function listBackups() {
  let names = [];
  try {
    names = fs.readdirSync(BACKUP_DIR).filter((name) => BACKUP_RE.test(name));
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  names.sort();
  return names.map((name) => {
    let bytes = 0;
    try { bytes = fs.statSync(path.join(BACKUP_DIR, name)).size; } catch (ignored) { bytes = 0; }
    return { name: name, bytes: bytes, at: stampToTime(name) };
  });
}

function readRecordsDoc() {
  const parsed = readJsonFile(RECORDS_FILE, null);
  if (!parsed) return { version: 1, updatedAt: null, records: [] };
  if (Array.isArray(parsed)) return { version: 1, updatedAt: null, records: parsed };
  return {
    version: Number(parsed.version) || 1,
    updatedAt: parsed.updatedAt || null,
    records: Array.isArray(parsed.records) ? parsed.records : [],
  };
}

// 比较前后两次 records（按 id，缺 id 时按序号），供 §12 的 record_add / record_delete 审计使用
function diffRecords(before, after) {
  const oldList = Array.isArray(before) ? before : [];
  const newList = Array.isArray(after) ? after : [];
  const keyOf = (item, index) => {
    const id = item && typeof item === 'object' && item.id != null ? String(item.id) : '';
    return id || '#index-' + index;
  };
  const oldMap = new Map();
  oldList.forEach((item, index) => oldMap.set(keyOf(item, index), item));
  const seen = new Set();
  let added = 0;
  let changed = 0;
  newList.forEach((item, index) => {
    const key = keyOf(item, index);
    seen.add(key);
    if (!oldMap.has(key)) { added += 1; return; }
    if (JSON.stringify(oldMap.get(key)) !== JSON.stringify(item)) changed += 1;
  });
  let removed = 0;
  for (const key of oldMap.keys()) if (!seen.has(key)) removed += 1;
  return { added: added, changed: changed, removed: removed };
}

function readLockInfo() {
  const parsed = readJsonFile(LOCK_FILE, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const ts = Number(parsed.ts) > 0 ? Number(parsed.ts) : (Date.parse(String(parsed.at || '')) || 0);
  const at = parsed.at || (ts > 0 ? new Date(ts).toISOString() : null);
  return { owner: String(parsed.owner || parsed.id || '未知'), at: at, ts: ts };
}

function parseIfMatch(raw) {
  if (raw === undefined) return { provided: false, value: null };
  let text = String(raw).trim();
  if (/^W\//i.test(text)) text = text.slice(2).trim();
  const quoted = /^"([\s\S]*)"$/.exec(text);
  if (quoted) text = quoted[1].trim();
  if (!text || text === 'null' || text === 'undefined') return { provided: true, value: null };
  return { provided: true, value: text };
}

// ---------------------------------------------------------------------------
// 业务端点：健康检查 / 公开配置 / 登录 / 会话
// ---------------------------------------------------------------------------
function apiHealth(res) {
  const doc = readRecordsDoc();
  sendJson(res, 200, {
    ok: true,
    name: APP_NAME,
    version: APP_VERSION,
    records: doc.records.length,
    images: countImageFiles(),
    uptime: Math.round(process.uptime()),
  });
}

function apiConfigPublic(res) {
  sendJson(res, 200, {
    name: APP_NAME,
    version: APP_VERSION,
    serverTime: isoNow(),
    loginHint: '请输入管理员分配的账号与密码',
  });
}

async function apiLogin(req, res) {
  const body = await readJsonBody(req, MAX_JSON_BYTES);
  const username = String(body.user || body.username || '').trim();
  const password = String(body.password || '');
  const ip = clientIp(req);
  const startedAt = Number(req._cvStartedAt) || Date.now();
  if (!username || !password) throw apiError('bad_request', '请输入账号和密码');

  const db = readUsersDb();
  const user = findUserByName(db.users, username);
  if (!user || !verifyPassword(password, user.salt, user.passHash)) {
    await serialWrite(() => auditDirect(null, 'login_failed', {
      username: username, role: '', ip: ip, ok: false,
      target: ip, detail: '账号或密码不正确（密码错误或账号不存在）',
      ms: Date.now() - startedAt,
    })).catch(() => undefined);
    throw apiError('unauthorized', '账号或密码不正确');
  }
  if (user.status === 'pending') throw apiError('forbidden', '账号正在等待管理员审批，请稍后再试');
  if (user.status === 'rejected') throw apiError('forbidden', '账号申请已被拒绝' + (user.reason ? '：' + user.reason : ''));
  if (user.status === 'disabled') throw apiError('forbidden', '账号已被停用' + (user.reason ? '：' + user.reason : ''));

  const issued = issueToken(user, body.ttlSeconds);
  await serialWrite(() => {
    const fresh = readUsersDb();
    const target = fresh.users.find((u) => u && u.id === user.id);
    if (target) {
      target.lastLoginAt = isoNow();
      target.loginCount = (Number(target.loginCount) || 0) + 1;
      target.ip = ip;
      target.tokenVersion = Number(target.tokenVersion) || 1;
      writeJsonAtomic(USERS_FILE, { version: 1, users: fresh.users });
    }
    auditDirect({ user: user, ip: ip, startedAt: startedAt }, 'login', {
      target: ip,
      detail: '登录成功（角色：' + (ROLE_LABEL[user.role] || user.role) + '，有效期 ' + issued.ttlSeconds + ' 秒）',
    });
  });

  setTokenCookie(res, issued.token, issued.ttlSeconds);
  sendJson(res, 200, {
    ok: true,
    role: user.role,
    user: publicUser(user),
    token: issued.token,
    expiresAt: issued.expiresAt,
    ttlSeconds: issued.ttlSeconds,
    idleTimeoutSeconds: Number(CONFIG.idleTimeoutSeconds) || 0,
  });
}

async function apiLogout(req, res, session) {
  const jti = String((session.payload && session.payload.jti) || '');
  if (jti) {
    revokeJti(jti, session.payload && session.payload.exp); // 先持久化吊销再返回，保证重启后仍 401
    lastSeenAt.delete(jti);
  }
  await serialWrite(() => auditDirect(session, 'logout', { target: session.ip, detail: '退出登录' })).catch(() => undefined);
  clearTokenCookie(res);
  sendJson(res, 200, { ok: true });
}

function apiSessionGet(res, session) {
  const payload = session.payload || {};
  const exp = Number(payload.exp) || 0;
  const iat = Number(payload.iat) || 0;
  sendJson(res, 200, {
    user: publicUser(session.user),
    username: session.user.username,
    role: session.user.role,
    expiresAt: exp > 0 ? new Date(exp * 1000).toISOString() : null,
    ttlSeconds: exp > 0 && iat > 0 ? exp - iat : null,
    idleTimeoutSeconds: Number(CONFIG.idleTimeoutSeconds) || 0,
    serverTime: isoNow(),
  });
}

async function apiSessionExtend(req, res, session) {
  const body = await readJsonBody(req, MAX_JSON_BYTES);
  const current = Number(session.payload && session.payload.exp) - Number(session.payload && session.payload.iat);
  const issued = issueToken(session.user, body.ttlSeconds == null ? current : body.ttlSeconds);
  await serialWrite(() => auditDirect(session, 'login', {
    target: session.ip, detail: '会话续期 ' + issued.ttlSeconds + ' 秒',
  })).catch(() => undefined);
  setTokenCookie(res, issued.token, issued.ttlSeconds);
  sendJson(res, 200, {
    ok: true,
    token: issued.token,
    expiresAt: issued.expiresAt,
    ttlSeconds: issued.ttlSeconds,
    role: session.user.role,
  });
}

// ---------------------------------------------------------------------------
// 业务端点：台账 / 设置 / 审计
// ---------------------------------------------------------------------------
function apiRecordsGet(res) {
  sendJson(res, 200, readRecordsDoc());
}

async function apiRecordsPut(req, res, session) {
  requireRole(session, 'editor');
  const body = await readJsonBody(req, MAX_RECORDS_BYTES);
  if (!Array.isArray(body.records)) throw apiError('bad_request', 'records 必须是数组');
  const precondition = parseIfMatch(req.headers['if-match']);
  const result = await serialWrite(() => {
    const current = readRecordsDoc();
    if (precondition.provided && precondition.value !== (current.updatedAt || null)) {
      throw apiError('conflict', '有人刚改过，请刷新后重试');
    }
    const updatedAt = isoNow();
    const diff = diffRecords(current.records, body.records);
    writeJsonAtomic(RECORDS_FILE, { version: 1, updatedAt: updatedAt, records: body.records });
    const auditBatch = [makeAuditEntry(session, 'record_edit', {
      target: 'records',
      detail: '保存台账：共 ' + body.records.length + ' 条（新增 ' + diff.added + ' / 修改 ' + diff.changed + ' / 删除 ' + diff.removed + '）',
    })];
    if (diff.added > 0) {
      auditBatch.push(makeAuditEntry(session, 'record_add', { target: 'records', detail: '新增 ' + diff.added + ' 条记录' }));
    }
    if (diff.removed > 0) {
      auditBatch.push(makeAuditEntry(session, 'record_delete', { target: 'records', detail: '删除 ' + diff.removed + ' 条记录' }));
    }
    appendAuditEntries(auditBatch);
    return { ok: true, updatedAt: updatedAt, count: body.records.length, added: diff.added, removed: diff.removed, changed: diff.changed };
  });
  sendJson(res, 200, result);
}

function apiSettingsGet(res) {
  const parsed = readJsonFile(SETTINGS_FILE, null);
  const base = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  sendJson(res, 200, Object.assign({}, DEFAULT_SETTINGS, base, { version: 1 }));
}

async function apiSettingsPut(req, res, session) {
  requireRole(session, 'editor');
  const body = await readJsonBody(req, MAX_JSON_BYTES);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw apiError('bad_request', '设置必须是对象');
  const settings = Object.assign({}, DEFAULT_SETTINGS, body, { version: 1 });
  await serialWrite(() => {
    writeJsonAtomic(SETTINGS_FILE, settings);
    auditDirect(session, 'settings_update', { target: 'settings', detail: '更新设置' });
  });
  sendJson(res, 200, { ok: true, settings: settings });
}

function apiAuditGet(res, session, query) {
  requireRole(session, 'viewer');
  const all = readAuditEntries();
  const isAdmin = session.user.role === 'admin';
  if (!isAdmin) {
    const mine = all.filter((entry) => entry && (
      entry.userId === session.user.id ||
      String(entry.username || '').toLowerCase() === String(session.user.username || '').toLowerCase()
    ));
    sendJson(res, 200, { version: 1, entries: mine.slice(-50), total: mine.length });
    return;
  }
  const limitText = Number(query.get('limit'));
  const limit = Number.isFinite(limitText) && limitText > 0 ? Math.min(Math.floor(limitText), AUDIT_KEEP) : AUDIT_PAGE;
  const user = String(query.get('user') || '').trim().toLowerCase();
  const action = String(query.get('action') || '').trim();
  const from = query.get('from') ? Date.parse(String(query.get('from'))) : NaN;
  const to = query.get('to') ? Date.parse(String(query.get('to'))) : NaN;
  const filtered = all.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (user) {
      const name = String(entry.username || '').toLowerCase();
      const id = String(entry.userId || '').toLowerCase();
      if (name !== user && id !== user) return false;
    }
    if (action && String(entry.action || '') !== action) return false;
    const time = Date.parse(String(entry.at || entry.ts || ''));
    if (Number.isFinite(from) && Number.isFinite(time) && time < from) return false;
    if (Number.isFinite(to) && Number.isFinite(time) && time > to) return false;
    return true;
  });
  sendJson(res, 200, { version: 1, entries: filtered.slice(-limit), total: filtered.length });
}

async function apiAuditPost(req, res, session) {
  requireRole(session, 'viewer');
  const body = await readJsonBody(req, MAX_JSON_BYTES);
  const list = Array.isArray(body) ? body : [body];
  const allowed = session.user.role === 'admin' ? AUDIT_ACTION_SET : AUDIT_CLIENT_ACTIONS;
  const entries = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (item.action == null || String(item.action).trim() === '') continue;
    const action = String(item.action).trim();
    if (!AUDIT_ACTION_SET.has(action)) throw apiError('bad_request', '不支持的审计动作：' + action);
    if (!allowed.has(action)) throw apiError('forbidden', '当前账号不能记录该审计动作');
    entries.push(makeAuditEntry(session, action, {
      target: item.target,
      detail: item.detail,
    }));
  }
  if (!entries.length) throw apiError('bad_request', '缺少 action 字段');
  await serialWrite(() => { appendAuditEntries(entries); });
  sendJson(res, 200, { ok: true, count: entries.length });
}

// ---------------------------------------------------------------------------
// 业务端点：截图（multipart 上传 / 读取 / 删除）
// ---------------------------------------------------------------------------
async function apiImageUpload(req, res, session, recordId) {
  requireRole(session, 'editor');
  const contentType = String(req.headers['content-type'] || '');
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!/^multipart\/form-data/i.test(contentType) || !boundaryMatch) {
    throw apiError('bad_request', '请用 multipart/form-data 上传，字段名 files');
  }
  const boundary = String(boundaryMatch[1] || boundaryMatch[2] || '').trim();
  if (!boundary) throw apiError('bad_request', 'multipart 缺少 boundary');

  const buf = await readBody(req, MAX_UPLOAD_BYTES);
  const parts = parseMultipart(buf, boundary).filter((part) => part.name === 'files' && part.filename);
  if (!parts.length) throw apiError('bad_request', '没有找到 files 字段（或文件名为空）');

  const rid = safeSegment(recordId, '记录 id');
  const dir = path.join(IMAGES_DIR, rid);
  const result = await serialWrite(() => {
    fs.mkdirSync(dir, { recursive: true });
    const existing = listImageFiles(dir);
    let remaining = Math.max(0, MAX_IMAGES_PER_RECORD - existing.length);
    const added = [];
    const skipped = [];
    for (const part of parts) {
      const shown = part.filename;
      if (part.type && !/^image\//i.test(part.type)) {
        skipped.push({ name: shown, reason: '不是图片文件（' + part.type + '）' });
        continue;
      }
      if (part.data.length > MAX_IMAGE_BYTES) {
        skipped.push({ name: shown, reason: '超过单张 8MB 上限（' + formatBytes(part.data.length) + '）' });
        continue;
      }
      if (!part.data.length) {
        skipped.push({ name: shown, reason: '文件内容为空' });
        continue;
      }
      if (remaining <= 0) {
        skipped.push({ name: shown, reason: '该记录截图已达 ' + MAX_IMAGES_PER_RECORD + ' 张上限' });
        continue;
      }
      const ext = extOf(part.filename, part.type);
      let fileName = stampCompact(new Date()) + '-' + randToken(4) + '.' + ext;
      let guard = 0;
      while (statOrNull(path.join(dir, fileName)) && guard < 20) {
        fileName = stampCompact(new Date()) + '-' + randToken(4) + '.' + ext;
        guard += 1;
      }
      writeFileAtomic(path.join(dir, fileName), part.data);
      const size = imageSize(part.data);
      added.push({ file: fileName, w: size.w, h: size.h, size: part.data.length, addedAt: isoNow() });
      remaining -= 1;
    }
    const detail = '上传截图 ' + rid + '：新增 ' + added.length + ' 张' +
      (skipped.length ? '，跳过 ' + skipped.length + ' 张' : '');
    auditDirect(session, 'image_add', { target: rid, detail: detail });
    return { ok: true, added: added, skipped: skipped };
  });
  sendJson(res, 200, result);
}

function apiImageGet(req, res, session, recordId, file) {
  requireRole(session, 'viewer');
  const rid = safeSegment(recordId, '记录 id');
  const name = safeSegment(file, '文件名');
  const target = path.join(IMAGES_DIR, rid, name);
  const stat = statOrNull(target);
  if (!stat || !stat.isFile()) throw apiError('not_found', '截图不存在：' + name);
  const etag = '"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
  res.setHeader('ETag', etag);
  if (String(req.headers['if-none-match'] || '') === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  const body = fs.readFileSync(target);
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.end(body);
}

async function apiImageDelete(res, session, recordId, file) {
  requireRole(session, 'editor');
  const rid = safeSegment(recordId, '记录 id');
  const name = safeSegment(file, '文件名');
  await serialWrite(() => {
    try {
      fs.unlinkSync(path.join(IMAGES_DIR, rid, name));
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    auditDirect(session, 'image_delete', { target: rid + '/' + name, detail: '删除截图' });
  });
  sendJson(res, 200, { ok: true });
}

async function apiImageDeleteAll(res, session, recordId) {
  requireRole(session, 'editor');
  const rid = safeSegment(recordId, '记录 id');
  await serialWrite(() => {
    try {
      fs.rmSync(path.join(IMAGES_DIR, rid), { recursive: true, force: true });
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    auditDirect(session, 'image_delete', { target: rid, detail: '删除该记录的全部截图' });
  });
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// 业务端点：备份（只留最近 10 份）
// ---------------------------------------------------------------------------
async function apiBackupsPost(req, res, session) {
  requireRole(session, 'editor');
  const body = await readJsonBody(req, MAX_JSON_BYTES);
  const reason = String((body && body.reason) || 'manual');
  const result = await serialWrite(() => {
    const snapshot = readJsonFile(RECORDS_FILE, null);
    const before = listBackups();
    if (!snapshot) {
      return { ok: true, file: null, count: before.length, message: '还没有台账数据，无需备份' };
    }
    const safeReason = reason.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'manual';
    const base = stampCompact(new Date()) + '-' + safeReason;
    let fileName = base + '.json';
    let suffix = 2;
    while (statOrNull(path.join(BACKUP_DIR, fileName)) && suffix <= 99) {
      fileName = base + '-' + suffix + '.json';
      suffix += 1;
    }
    writeFileAtomic(path.join(BACKUP_DIR, fileName), JSON.stringify(snapshot, null, 2));
    const after = listBackups();
    const drop = after.slice(0, Math.max(0, after.length - BACKUP_KEEP));
    let pruned = 0;
    for (const item of drop) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, item.name));
        pruned += 1;
      } catch (ignored) {
        // 删不掉就留到下次，不影响本次备份
      }
    }
    const kept = listBackups();
    auditDirect(session, 'backup_create', {
      target: fileName,
      detail: '创建备份 ' + fileName + '，清理 ' + pruned + ' 份，当前 ' + kept.length + ' 份',
    });
    return { ok: true, file: fileName, count: kept.length, pruned: pruned };
  });
  sendJson(res, 200, result);
}

function apiBackupsGet(res) {
  const files = listBackups();
  const latest = files.length ? files[files.length - 1] : null;
  sendJson(res, 200, {
    count: files.length,
    latest: latest ? latest.name : '',
    latestAt: latest ? latest.at : 0,
    bytes: files.reduce((sum, item) => sum + item.bytes, 0),
    files: files,
  });
}

// ---------------------------------------------------------------------------
// 业务端点：占用标记（超过 4 小时视为陈旧，可被接管）
// ---------------------------------------------------------------------------
function apiLockGet(res) {
  const info = readLockInfo();
  if (!info) {
    sendJson(res, 200, { locked: false, owner: null, at: null, stale: false });
    return;
  }
  const stale = !(info.ts > 0) || (Date.now() - info.ts > LOCK_STALE_MS);
  sendJson(res, 200, { locked: true, owner: info.owner, at: info.at, stale: stale });
}

async function apiLockPost(req, res, session) {
  requireRole(session, 'editor');
  const body = await readJsonBody(req, MAX_JSON_BYTES);
  const owner = String((body && body.owner) || session.user.username || 'unknown').trim().slice(0, 64) || 'unknown';
  const result = await serialWrite(() => {
    const current = readLockInfo();
    if (current) {
      const stale = !(current.ts > 0) || (Date.now() - current.ts > LOCK_STALE_MS);
      if (!stale && current.owner !== owner) {
        throw apiError('conflict', '该数据目录正被「' + current.owner + '」占用，请稍后再试');
      }
    }
    const info = { owner: owner, at: isoNow(), ts: Date.now(), id: 'lock_' + randToken(8) };
    writeJsonAtomic(LOCK_FILE, info);
    return { ok: true, locked: true, owner: info.owner, at: info.at, stale: false };
  });
  sendJson(res, 200, result);
}

async function apiLockDelete(res, session) {
  requireRole(session, 'editor');
  await serialWrite(() => {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
  });
  sendJson(res, 200, { ok: true, locked: false });
}

// ---------------------------------------------------------------------------
// 业务端点：注册与审批（多用户流程的骨架；完整交互由后续任务补齐）
// ---------------------------------------------------------------------------
async function apiRegister(req, res) {
  const ip = clientIp(req);
  const startedAt = Number(req._cvStartedAt) || Date.now();
  checkRegisterRate(ip);
  const body = await readJsonBody(req, MAX_JSON_BYTES);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const device = String(body.device || '').trim().slice(0, 64);
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) {
    throw apiError('bad_request', '用户名需 3~32 位，只能包含字母、数字、下划线和短横线');
  }
  if (password.length < 6) throw apiError('bad_request', '密码至少 6 位');

  await serialWrite(() => {
    const db = readUsersDb();
    const existing = findUserByName(db.users, username);
    if (existing) {
      if (existing.status === 'pending') throw apiError('conflict', '该用户名已提交申请，请等待管理员审批');
      throw apiError('conflict', '用户名已存在，请换一个');
    }
    const hashed = hashPassword(password);
    const user = makeUserRecord({
      username: username,
      passHash: hashed.passHash,
      salt: hashed.salt,
      role: 'viewer',
      status: 'pending',
      device: device,
      ip: ip,
    });
    db.users.push(user);
    writeJsonAtomic(USERS_FILE, { version: 1, users: db.users });
    auditDirect(null, 'user_register', {
      username: user.username,
      role: 'viewer',
      ip: ip,
      target: user.username,
      detail: '申请注册（设备：' + (device || '未知') + '）',
      ms: Date.now() - startedAt,
    });
  });

  sendJson(res, 200, { ok: true, status: 'pending', message: '已提交申请，请等待管理员审批' });
}

async function apiRegisterStatus(req, res) {
  const body = await readJsonBody(req, MAX_JSON_BYTES);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const db = readUsersDb();
  const user = findUserByName(db.users, username);
  if (!user || !verifyPassword(password, user.salt, user.passHash)) {
    sendJson(res, 200, { status: 'none' });
    return;
  }
  const payload = { status: user.status };
  if (user.reason && (user.status === 'rejected' || user.status === 'disabled')) payload.reason = user.reason;
  sendJson(res, 200, payload);
}

function apiAdminUsers(res, session) {
  requireRole(session, 'admin');
  const db = readUsersDb();
  sendJson(res, 200, { users: db.users.map((user) => publicUser(user)) });
}

async function apiAdminUserAction(req, res, session, userId, action) {
  requireRole(session, 'admin');
  const body = await readJsonBody(req, MAX_JSON_BYTES);
  const id = safeSegment(userId, '账号 id');
  const result = await serialWrite(() => {
    const db = readUsersDb();
    const user = db.users.find((item) => item && item.id === id);
    if (!user) throw apiError('not_found', '账号不存在');

    if (action === 'approve') {
      const role = String(body.role || 'viewer');
      if (!ROLE_RANK[role]) throw apiError('bad_request', '角色只能是 viewer / editor / admin');
      if (user.status === 'active') throw apiError('conflict', '该账号已经是启用状态');
      user.role = role;
      user.status = 'active';
      user.approvedAt = isoNow();
      user.approvedBy = session.user.id;
      user.reason = null;
      writeJsonAtomic(USERS_FILE, { version: 1, users: db.users });
      auditDirect(session, 'user_approve', {
        target: user.username,
        detail: '通过注册申请，角色：' + role,
      });
      return { ok: true, user: publicUser(user) };
    }

    if (action === 'reject') {
      if (user.status === 'active') throw apiError('conflict', '该账号已启用，不能拒绝；如需停用请使用停用接口');
      const reason = String(body.reason || '').trim().slice(0, 200);
      user.status = 'rejected';
      user.reason = reason || null;
      user.approvedAt = null;
      user.approvedBy = session.user.id;
      writeJsonAtomic(USERS_FILE, { version: 1, users: db.users });
      auditDirect(session, 'user_reject', {
        target: user.username,
        detail: '拒绝注册申请' + (reason ? '：' + reason : ''),
      });
      return { ok: true, user: publicUser(user) };
    }

    if (action === 'role') {
      const role = String(body.role || '');
      if (!ROLE_RANK[role]) throw apiError('bad_request', '角色只能是 viewer / editor / admin');
      if (user.role === 'admin' && role !== 'admin' && countActiveAdmins(db.users) <= 1) {
        throw apiError('bad_request', '至少保留一个可用的管理员账号');
      }
      user.role = role;
      writeJsonAtomic(USERS_FILE, { version: 1, users: db.users });
      auditDirect(session, 'user_role', { target: user.username, detail: '角色改为 ' + role });
      return { ok: true, user: publicUser(user) };
    }

    if (action === 'status') {
      const status = String(body.status || '');
      if (status !== 'active' && status !== 'disabled') throw apiError('bad_request', '状态只能是 active 或 disabled');
      if (status === 'disabled' && user.id === session.user.id) {
        throw apiError('bad_request', '不能停用当前登录的账号');
      }
      if (status === 'disabled' && user.role === 'admin' && countActiveAdmins(db.users) <= 1) {
        throw apiError('bad_request', '至少保留一个可用的管理员账号');
      }
      user.status = status;
      if (status === 'active') user.reason = null;
      writeJsonAtomic(USERS_FILE, { version: 1, users: db.users });
      auditDirect(session, 'user_status', { target: user.username, detail: '状态改为 ' + status });
      return { ok: true, user: publicUser(user) };
    }

    if (action === 'reset-password') {
      const password = String(body.password || '');
      if (password.length < 6) throw apiError('bad_request', '密码至少 6 位');
      const hashed = hashPassword(password);
      user.passHash = hashed.passHash;
      user.salt = hashed.salt;
      user.tokenVersion = (Number(user.tokenVersion) || 1) + 1;
      writeJsonAtomic(USERS_FILE, { version: 1, users: db.users });
      if (String(user.username || '').toLowerCase() === String((CONFIG && CONFIG.user) || '').toLowerCase()) {
        CONFIG.passHash = user.passHash;
        CONFIG.salt = user.salt;
        saveConfig(CONFIG);
      }
      auditDirect(session, 'user_reset_password', { target: user.username, detail: '重置密码（已吊销旧 token）' });
      return { ok: true, tokenVersion: user.tokenVersion };
    }

    throw apiError('not_found', '未知的账号操作：' + action);
  });
  sendJson(res, 200, result);
}

// ---------------------------------------------------------------------------
// API 路由
// ---------------------------------------------------------------------------
function normalizePath(rawPath) {
  let pathname = String(rawPath || '/');
  try { pathname = decodeURIComponent(pathname); } catch (err) { throw apiError('bad_request', '请求路径包含非法字符'); }
  pathname = pathname.replace(/\/{2,}/g, '/');
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  return pathname;
}

async function handleApi(req, res, url, pathname) {
  const method = req.method || 'GET';
  const query = url.searchParams;

  // —— 免认证端点（契约 §3） ——
  if (method === 'GET' && pathname === '/api/health') return apiHealth(res);
  if (method === 'GET' && pathname === '/api/config/public') return apiConfigPublic(res);
  if (method === 'POST' && pathname === '/api/login') return apiLogin(req, res);
  if (method === 'POST' && pathname === '/api/register') return apiRegister(req, res);
  if (method === 'POST' && pathname === '/api/register/status') return apiRegisterStatus(req, res);

  // —— 以下全部需要有效 token ——
  const session = requireAuth(req);

  if (method === 'POST' && pathname === '/api/logout') return apiLogout(req, res, session);
  if (method === 'GET' && pathname === '/api/session') return apiSessionGet(res, session);
  if (method === 'POST' && pathname === '/api/session/extend') return apiSessionExtend(req, res, session);

  if (method === 'GET' && pathname === '/api/records') return apiRecordsGet(res);
  if (method === 'PUT' && pathname === '/api/records') return apiRecordsPut(req, res, session);
  if (method === 'GET' && pathname === '/api/settings') return apiSettingsGet(res);
  if (method === 'PUT' && pathname === '/api/settings') return apiSettingsPut(req, res, session);

  if (method === 'GET' && pathname === '/api/audit') return apiAuditGet(res, session, query);
  if (method === 'POST' && pathname === '/api/audit') return apiAuditPost(req, res, session);

  if (method === 'POST' && pathname === '/api/backups') return apiBackupsPost(req, res, session);
  if (method === 'GET' && pathname === '/api/backups') return apiBackupsGet(res);

  if (method === 'GET' && pathname === '/api/lock') return apiLockGet(res);
  if (method === 'POST' && pathname === '/api/lock') return apiLockPost(req, res, session);
  if (method === 'DELETE' && pathname === '/api/lock') return apiLockDelete(res, session);

  const imageOne = /^\/api\/images\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (imageOne) {
    if (method === 'GET') return apiImageGet(req, res, session, imageOne[1], imageOne[2]);
    if (method === 'DELETE') return apiImageDelete(res, session, imageOne[1], imageOne[2]);
  }
  const imageDir = /^\/api\/images\/([^/]+)$/.exec(pathname);
  if (imageDir) {
    if (method === 'POST') return apiImageUpload(req, res, session, imageDir[1]);
    if (method === 'DELETE') return apiImageDeleteAll(res, session, imageDir[1]);
  }

  if (method === 'GET' && pathname === '/api/admin/users') return apiAdminUsers(res, session);
  const adminAction = /^\/api\/admin\/users\/([^/]+)\/(approve|reject|role|status|reset-password)$/.exec(pathname);
  if (adminAction && method === 'POST') {
    return apiAdminUserAction(req, res, session, adminAction[1], adminAction[2]);
  }

  throw apiError('not_found', '接口不存在：' + method + ' ' + pathname);
}

// ---------------------------------------------------------------------------
// HTTP 服务入口
// ---------------------------------------------------------------------------
async function handleRequest(req, res) {
  req._cvStartedAt = Date.now();
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  let url;
  try {
    url = new URL(req.url || '/', 'http://' + (req.headers.host || '127.0.0.1'));
  } catch (err) {
    throw apiError('bad_request', '请求地址不合法');
  }
  const pathname = normalizePath(url.pathname);
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    await handleApi(req, res, url, pathname);
    return;
  }
  handleStatic(req, res, pathname);
}

function createServer() {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).then(() => {
      if (pathnameIsApi(req.url)) log(req.method + ' ' + req.url + ' → ' + res.statusCode);
    }).catch((err) => {
      if (pathnameIsApi(req.url)) log(req.method + ' ' + req.url + ' → ' + (err && err.status ? err.status : 500));
      sendFailure(res, err);
    });
  });
  server.on('clientError', (err, socket) => {
    try { socket.destroy(); } catch (ignored) { /* 连接已断 */ }
  });
  return server;
}

function pathnameIsApi(rawUrl) {
  return String(rawUrl || '').indexOf('/api/') === 0;
}

function main() {
  bootstrap();
  const server = createServer();
  server.on('error', (err) => {
    console.error('【CertVault】服务启动失败：' + (err && err.message ? err.message : err));
    process.exit(1);
  });
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    const shownHost = LISTEN_HOST === '0.0.0.0' ? '127.0.0.1' : LISTEN_HOST;
    console.log('【CertVault】服务已启动');
    console.log('  监听地址：http://' + shownHost + ':' + LISTEN_PORT);
    console.log('  数据目录：' + DATA_ROOT);
    console.log('  静态站点：' + (appRoot() || '（未找到 app 目录，仅提供 API）'));
    console.log('  时　　区：' + (process.env.TZ || '(系统默认)'));
  });
  const shutdown = (signal) => {
    console.log('【CertVault】收到 ' + signal + '，正在关闭服务…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    console.error('【CertVault】未处理的 Promise 拒绝：' + (err && err.stack ? err.stack : err));
  });
}

main();

