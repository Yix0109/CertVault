#!/usr/bin/env node
// CertVault 服务器版端到端验收脚本（scripts/e2e-server.mjs）
// 依据：docs/接口契约-服务器版.md（唯一事实来源）。
// 覆盖：
//   ① 30 个端点逐条断言；
//   ② 三角色越权矩阵：viewer 对全部写路由 403、editor 编辑级写路由 200、admin 额外可用用户管理；
//   ③ 注册 → pending → 管理员同意 → 登录 → 角色生效 → 拒绝 → 停用 → 重置密码；
//   ④ 双 token 并发写：各 20 次 PUT /api/records，≥19 次 409，最终 JSON 合法、无 .tmp 残留；
//   ⑤ 会话：ttlSeconds=86400（有效可用 / 过期 401）与 extend 续期。
// 零依赖：只用 Node 18+ 内置模块与 fetch；不改业务代码。
//
// 用法：
//   node scripts/e2e-server.mjs
//     默认验收 http://127.0.0.1:8090；若该地址无服务，自动用临时数据目录在 8090 自启服务
//     （CV_USER=admin / CV_PASS=e2e-admin-123），结束后清理临时目录。
//   CV_BASE=http://192.168.1.10:8090 CV_USER=admin CV_PASS=xxx node scripts/e2e-server.mjs
//     验收已在运行的服务（注意：脚本会覆盖该实例台账与设置，只对测试实例使用）。
//     要覆盖「过期 token → 401」，再给 CV_DATA=<服务数据根目录>（读 config.json 的 secret）；
//     未给 CV_DATA 时该断言标记跳过，其余照常执行。
// 退出码：0 = 无失败（跳过项见输出）；1 = 有失败或异常。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(ROOT, 'server', 'server.js');
const APP_DIR = process.env.CV_APP_DIR || path.join(ROOT, 'app');
const ENV_BASE = String(process.env.CV_BASE || '').trim();
const RAW_BASE = ENV_BASE || 'http://127.0.0.1:8090';
const BASE = RAW_BASE.endsWith('/') ? RAW_BASE.slice(0, -1) : RAW_BASE;
const ADMIN_USER = String(process.env.CV_USER || 'admin').trim() || 'admin';
const ADMIN_PASS = String(process.env.CV_PASS || 'e2e-admin-123');
const RUN = Math.random().toString(36).slice(2, 8);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const ENDPOINTS = [
  [1, 'GET', '/api/health', '免认证健康检查'],
  [2, 'POST', '/api/login', '登录 + Cookie'],
  [3, 'POST', '/api/logout', '退出登录'],
  [4, 'GET', '/api/records', '读台账'],
  [5, 'PUT', '/api/records', '写台账 + If-Match'],
  [6, 'GET', '/api/settings', '读设置'],
  [7, 'PUT', '/api/settings', '写设置'],
  [8, 'GET', '/api/audit', '读审计'],
  [9, 'POST', '/api/audit', '写审计'],
  [10, 'POST', '/api/images/{recordId}', '上传截图'],
  [11, 'GET', '/api/images/{recordId}/{file}', '读截图'],
  [12, 'DELETE', '/api/images/{recordId}/{file}', '删单张截图'],
  [13, 'DELETE', '/api/images/{recordId}', '删记录全部截图'],
  [14, 'POST', '/api/backups', '创建备份'],
  [15, 'GET', '/api/backups', '备份列表'],
  [16, 'GET', '/api/lock', '读锁'],
  [17, 'POST', '/api/lock', '加锁'],
  [18, 'DELETE', '/api/lock', '释放锁'],
  [19, 'GET', '/api/session', '当前会话'],
  [20, 'POST', '/api/session/extend', '会话续期'],
  [21, 'GET', '/api/config/public', '免认证公开配置'],
  [22, 'POST', '/api/register', '注册申请'],
  [23, 'POST', '/api/register/status', '注册状态轮询'],
  [24, 'GET', '/api/admin/users', '用户列表（admin）'],
  [25, 'POST', '/api/admin/users/{id}/approve', '同意（admin）'],
  [26, 'POST', '/api/admin/users/{id}/reject', '拒绝（admin）'],
  [27, 'POST', '/api/admin/users/{id}/role', '改角色（admin）'],
  [28, 'POST', '/api/admin/users/{id}/status', '停用/启用（admin）'],
  [29, 'POST', '/api/admin/users/{id}/reset-password', '重置密码（admin）'],
  [30, 'GET', '/api/audit?filters', '审计筛选（admin）'],
];

const results = [];
const endpointChecks = {};
let failures = 0;
let skipped = 0;
let child = null;
let serverLog = '';
let dataDir = '';
let ownsDataDir = false;
let externalMode = false;
let secret = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function section(title) {
  console.log('');
  console.log('== ' + title);
}

function ok(name, pass, detail) {
  if (pass) {
    results.push({ name: name, pass: true, skipped: false });
    console.log('  [PASS] ' + name);
    return true;
  }
  failures += 1;
  results.push({ name: name, pass: false, skipped: false });
  let text = '';
  if (detail !== undefined) {
    text = '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
    if (text.length > 600) text = text.slice(0, 600) + '…';
  }
  console.log('  [FAIL] ' + name + text);
  return false;
}

function skip(name, reason) {
  skipped += 1;
  results.push({ name: name, pass: false, skipped: true });
  console.log('  [SKIP] ' + name + '（' + reason + '）');
}

function ep(n, title, pass, detail) {
  const name = 'EP' + String(n).padStart(2, '0') + ' ' + title;
  const prev = endpointChecks[n];
  const finalPass = prev ? (prev.pass && !!pass) : !!pass;
  ok(name, finalPass, detail);
  endpointChecks[n] = { pass: finalPass, name: name };
  return finalPass;
}

function isApiError(response, status, code) {
  return !!response && response.status === status && !!response.data && !!response.data.error && response.data.error.code === code;
}

function errInfo(response) {
  if (!response) return 'no response';
  if (response.error) return 'network: ' + response.error;
  if (response.data && response.data.error) return { status: response.status, code: response.data.error.code, message: response.data.error.message };
  return { status: response.status };
}

function cookieHeaderOf(response) {
  const raw = String((response && response.headers.get('set-cookie')) || '');
  const match = /cv_token=([^;]+)/.exec(raw);
  return match ? 'cv_token=' + match[1] : '';
}

function tokenFromCookie(response) {
  const header = cookieHeaderOf(response);
  return header ? header.slice('cv_token='.length) : '';
}

function tokenOf(response) {
  const body = response && response.data;
  if (body && typeof body.token === 'string' && body.token) return body.token;
  return tokenFromCookie(response);
}

async function call(method, pathname, options) {
  const opts = options || {};
  const headers = Object.assign({}, opts.headers || {});
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  if (opts.cookie) headers.Cookie = opts.cookie;
  let body;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(BASE + pathname, {
      method: method,
      headers: headers,
      body: body,
      redirect: 'manual',
      signal: controller.signal,
    });
    const contentType = String(response.headers.get('content-type') || '');
    let data;
    if (contentType.includes('application/json')) {
      const text = await response.text();
      try { data = JSON.parse(text); } catch (err) { data = { __unparsable: text }; }
    } else {
      data = Buffer.from(await response.arrayBuffer());
    }
    return { status: response.status, headers: response.headers, data: data };
  } catch (err) {
    return { status: 0, headers: new Headers(), data: null, error: err && err.message ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function multipart(files) {
  const boundary = '----cve2e' + RUN + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const file of files) {
    chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="files"; filename="' + file.name + '"\r\nContent-Type: ' + (file.type || 'image/png') + '\r\n\r\n', 'utf8'));
    chunks.push(file.data);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n', 'utf8'));
  return { boundary: boundary, body: Buffer.concat(chunks) };
}

function png(name) {
  return { name: name, data: PNG, type: 'image/png' };
}

async function upload(token, recordId, files) {
  const form = multipart(files);
  return call('POST', '/api/images/' + encodeURIComponent(recordId), {
    token: token,
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + form.boundary },
    raw: form.body,
  });
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

function decodeToken(token) {
  const text = String(token || '');
  const dot = text.indexOf('.');
  if (dot <= 0) return null;
  try { return JSON.parse(base64urlDecode(text.slice(0, dot))); } catch (err) { return null; }
}

function forgeToken(secretValue, payload) {
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(crypto.createHmac('sha256', secretValue).update(body).digest());
  return body + '.' + signature;
}

function walkTmp(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (err) { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tmp')) found.push(full);
    }
  };
  walk(dir);
  return found;
}

function tailLog() {
  return serverLog.split('\n').filter((line) => line.trim()).slice(-40).join('\n');
}

async function probeHealth(timeoutMs) {
  try {
    const response = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(timeoutMs || 1200) });
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.name === 'CertVault' ? data : null;
  } catch (err) {
    return null;
  }
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 25000);
  while (Date.now() < deadline) {
    const health = await probeHealth(1500);
    if (health) return health;
    if (child && child.exitCode !== null) {
      throw new Error('服务进程提前退出（exit=' + child.exitCode + '）\n' + tailLog());
    }
    await sleep(150);
  }
  throw new Error('服务未在 ' + timeoutMs + 'ms 内就绪\n' + tailLog());
}

async function bootTarget() {
  if (ENV_BASE) {
    externalMode = true;
    dataDir = String(process.env.CV_DATA || '');
    await waitForHealth(10000);
    console.log('  模式：外部服务（CV_BASE 指定），数据目录：' + (dataDir || '未提供（CV_DATA）'));
    return;
  }
  const existing = await probeHealth(1200);
  if (existing) {
    externalMode = true;
    dataDir = String(process.env.CV_DATA || '');
    console.log('  模式：复用 8090 上已在运行的 CertVault 服务；数据目录：' + (dataDir || '未提供（CV_DATA）'));
    return;
  }
  const address = new URL(BASE);
  const port = Number(address.port || 8080);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'certvault-e2e-'));
  ownsDataDir = true;
  console.log('  模式：脚本自启服务（临时数据目录 ' + dataDir + '，端口 ' + port + '）');
  const env = Object.assign({}, process.env, {
    CV_DATA: dataDir,
    CV_PORT: String(port),
    CV_HOST: '127.0.0.1',
    CV_USER: ADMIN_USER,
    CV_PASS: ADMIN_PASS,
    CV_TZ: 'Asia/Shanghai',
    CV_APP_DIR: APP_DIR,
  });
  child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
  try {
    await waitForHealth(25000);
  } catch (err) {
    throw new Error(err.message + '\n提示：' + BASE + ' 端口被占用或 server/server.js 启动失败；可设置 CV_BASE 指向已运行的服务。');
  }
}

function loadSecret() {
  if (!dataDir) return '';
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    return typeof config.secret === 'string' ? config.secret : '';
  } catch (err) {
    return '';
  }
}

async function adminUsers(token) {
  const response = await call('GET', '/api/admin/users', { token: token });
  const users = response.status === 200 && response.data && Array.isArray(response.data.users) ? response.data.users : [];
  return { response: response, users: users };
}

function findUser(users, name) {
  return users.find((user) => String(user.username || '').toLowerCase() === String(name || '').toLowerCase()) || null;
}

function idOf(user) {
  return user && user.id ? String(user.id) : 'missing-' + RUN;
}

async function cleanup() {
  if (child) {
    const proc = child;
    child = null;
    try { proc.kill('SIGTERM'); } catch (err) { /* 已退出 */ }
    const gone = await Promise.race([
      new Promise((resolve) => { proc.once('exit', () => resolve(true)); }),
      sleep(3000).then(() => false),
    ]);
    if (!gone) { try { proc.kill('SIGKILL'); } catch (err) { /* 已退出 */ } }
  }
  if (ownsDataDir && dataDir) {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (err) { /* 清理失败不影响结论 */ }
  }
}

async function run() {
  console.log('CertVault 服务器版 E2E 验收');
  console.log('  目标：' + BASE);
  console.log('  脚本：' + fileURLToPath(import.meta.url));
  await bootTarget();
  secret = loadSecret();
  if (!secret) {
    console.log('  提示：未读取到 config.json（secret），会话过期断言与磁盘 .tmp 检查将跳过；可设置 CV_DATA 指向服务数据根目录。');
  }

  section('一、健康检查与公开配置（免认证）');
  const health = await call('GET', '/api/health');
  ep(1, 'GET /api/health → 200 {ok,name,version,records,images,uptime}',
    health.status === 200 && !!health.data && health.data.ok === true && health.data.name === 'CertVault' &&
    typeof health.data.version === 'string' && health.data.version.length > 0 &&
    typeof health.data.records === 'number' && typeof health.data.images === 'number' && typeof health.data.uptime === 'number',
    errInfo(health));

  const publicConfig = await call('GET', '/api/config/public');
  ep(21, 'GET /api/config/public → 200 {name,version,serverTime,loginHint}',
    publicConfig.status === 200 && !!publicConfig.data && publicConfig.data.name === 'CertVault' &&
    typeof publicConfig.data.version === 'string' && typeof publicConfig.data.serverTime === 'string' &&
    !Number.isNaN(Date.parse(publicConfig.data.serverTime)) && typeof publicConfig.data.loginHint === 'string',
    errInfo(publicConfig));

  const indexPage = await call('GET', '/');
  ok('附加：GET / 返回 app/index.html（text/html + no-cache）',
    indexPage.status === 200 && Buffer.isBuffer(indexPage.data) &&
    String(indexPage.headers.get('content-type') || '').includes('text/html') &&
    String(indexPage.headers.get('cache-control') || '').includes('no-cache'),
    { status: indexPage.status, type: String(indexPage.headers.get('content-type') || ''), cache: String(indexPage.headers.get('cache-control') || '') });

  const unauthRecords = await call('GET', '/api/records');
  ok('附加：未登录访问 /api/records → 401 unauthorized', isApiError(unauthRecords, 401, 'unauthorized'), errInfo(unauthRecords));

  section('二、登录与会话端点');
  const badLogin = await call('POST', '/api/login', { json: { user: ADMIN_USER, password: 'wrong-' + RUN } });
  const login = await call('POST', '/api/login', { json: { user: ADMIN_USER, password: ADMIN_PASS } });
  const ADMIN_TOKEN = tokenOf(login);
  const ADMIN_COOKIE = cookieHeaderOf(login);
  const adminPayload = decodeToken(ADMIN_TOKEN);
  ep(2, 'POST /api/login 错误口令 401 / 正确 200 + role + token + Cookie cv_token',
    isApiError(badLogin, 401, 'unauthorized') &&
    login.status === 200 && !!login.data && login.data.ok === true && login.data.role === 'admin' &&
    typeof ADMIN_TOKEN === 'string' && ADMIN_TOKEN.indexOf('.') > 0 && ADMIN_COOKIE.length > 0 &&
    !!adminPayload && typeof adminPayload.u === 'string' && adminPayload.u.length > 0,
    { bad: errInfo(badLogin), good: { status: login.status, role: login.data && login.data.role, hasToken: !!ADMIN_TOKEN, hasCookie: !!ADMIN_COOKIE } });

  const cookieRecords = await call('GET', '/api/records', { cookie: ADMIN_COOKIE });
  ok('附加：Cookie 通道可访问（无 Authorization 时回退 cv_token）', cookieRecords.status === 200, errInfo(cookieRecords));
  const badBearer = await call('GET', '/api/records', { token: 'not-a-token', cookie: ADMIN_COOKIE });
  ok('附加：Authorization 无效时不回退 Cookie → 401', isApiError(badBearer, 401, 'unauthorized'), errInfo(badBearer));

  const sessionGet = await call('GET', '/api/session', { token: ADMIN_TOKEN });
  ep(19, 'GET /api/session → {user,role,expiresAt,ttlSeconds,idleTimeoutSeconds}',
    sessionGet.status === 200 && !!sessionGet.data && sessionGet.data.role === 'admin' &&
    !!sessionGet.data.user && sessionGet.data.user.username === ADMIN_USER &&
    typeof sessionGet.data.expiresAt === 'string' && !Number.isNaN(Date.parse(sessionGet.data.expiresAt)) &&
    typeof sessionGet.data.ttlSeconds === 'number' && typeof sessionGet.data.idleTimeoutSeconds === 'number',
    errInfo(sessionGet));

  const preflightBackup = await call('POST', '/api/backups', { token: ADMIN_TOKEN, json: { reason: 'e2e-preflight' } });
  ok('附加：验收前自动备份当前台账（可回滚）', preflightBackup.status === 200, errInfo(preflightBackup));

  section('三、台账与设置');
  const records0 = await call('GET', '/api/records', { token: ADMIN_TOKEN });
  ep(4, 'GET /api/records → {version:1,updatedAt,records[]}',
    records0.status === 200 && !!records0.data && records0.data.version === 1 &&
    Array.isArray(records0.data.records) && records0.data.updatedAt !== undefined,
    errInfo(records0));

  const baseRecords = records0.data && Array.isArray(records0.data.records) ? records0.data.records : [];
  const baseUpdatedAt = records0.data && typeof records0.data.updatedAt === 'string' ? records0.data.updatedAt : null;
  const firstWrite = await call('PUT', '/api/records', {
    token: ADMIN_TOKEN,
    headers: { 'If-Match': baseUpdatedAt === null ? 'null' : '"' + baseUpdatedAt + '"' },
    json: { updatedAt: baseUpdatedAt, records: [{ id: 'r_e2e_1', name: 'E2E 记录 1' }] },
  });
  const updatedAt1 = firstWrite.data && typeof firstWrite.data.updatedAt === 'string' ? firstWrite.data.updatedAt : null;
  const staleWrite = await call('PUT', '/api/records', {
    token: ADMIN_TOKEN,
    headers: { 'If-Match': baseUpdatedAt === null ? 'null' : '"' + baseUpdatedAt + '"' },
    json: { records: [{ id: 'r_e2e_stale', name: '陈旧写入' }] },
  });
  const quotedWrite = updatedAt1
    ? await call('PUT', '/api/records', { token: ADMIN_TOKEN, headers: { 'If-Match': '"' + updatedAt1 + '"' }, json: { records: [{ id: 'r_e2e_1', name: 'E2E 记录 1' }, { id: 'r_e2e_2', name: 'E2E 记录 2' }] } })
    : { status: 0, headers: new Headers(), data: null };
  ep(5, 'PUT /api/records：带 If-Match 写入 200 / 陈旧 If-Match 409（中文提示）/ 带引号 ETag 200',
    firstWrite.status === 200 && !!updatedAt1 &&
    isApiError(staleWrite, 409, 'conflict') && String(staleWrite.data.error.message).includes('有人刚改过') &&
    quotedWrite.status === 200,
    { first: firstWrite.status, stale: errInfo(staleWrite), quoted: quotedWrite.status });

  const settings0 = await call('GET', '/api/settings', { token: ADMIN_TOKEN });
  ep(6, 'GET /api/settings → 设置对象（非数组）',
    settings0.status === 200 && !!settings0.data && typeof settings0.data === 'object' && !Array.isArray(settings0.data) && Object.keys(settings0.data).length > 0,
    errInfo(settings0));

  const settingsPut = await call('PUT', '/api/settings', { token: ADMIN_TOKEN, json: { popupIntervalHours: 24, trayMinimize: false, note: 'e2e-' + RUN } });
  const settings1 = await call('GET', '/api/settings', { token: ADMIN_TOKEN });
  ep(7, 'PUT /api/settings 整体覆盖 200 且可读回',
    settingsPut.status === 200 && settings1.status === 200 && !!settings1.data &&
    Number(settings1.data.popupIntervalHours) === 24 && settings1.data.trayMinimize === false,
    { put: settingsPut.status, got: settings1.data });

  section('四、审计日志');
  const audit0 = await call('GET', '/api/audit', { token: ADMIN_TOKEN });
  ep(8, 'GET /api/audit → {version:1,entries[]}（最多 200 条）',
    audit0.status === 200 && !!audit0.data && audit0.data.version === 1 && Array.isArray(audit0.data.entries) &&
    audit0.data.entries.length > 0 && audit0.data.entries.length <= 200,
    errInfo(audit0));

  const auditPost1 = await call('POST', '/api/audit', { token: ADMIN_TOKEN, json: { action: 'record_export', detail: 'E2E 单条' } });
  const auditPost2 = await call('POST', '/api/audit', { token: ADMIN_TOKEN, json: [
    { action: 'record_export', detail: 'E2E 批量 1' },
    { action: 'record_import', detail: 'E2E 批量 2' },
  ] });
  const auditBadAction = await call('POST', '/api/audit', { token: ADMIN_TOKEN, json: { action: 'no_such_action' } });
  const audit1 = await call('GET', '/api/audit', { token: ADMIN_TOKEN });
  const auditDetails = audit1.data && Array.isArray(audit1.data.entries) ? audit1.data.entries.map((item) => String(item.detail || '')) : [];
  ep(9, 'POST /api/audit 单条/数组 → ok:true 且审计可读回',
    auditPost1.status === 200 && auditPost1.data && auditPost1.data.ok === true &&
    auditPost2.status === 200 && auditPost2.data && auditPost2.data.ok === true &&
    isApiError(auditBadAction, 400, 'bad_request') &&
    auditDetails.includes('E2E 批量 2'),
    { one: errInfo(auditPost1), many: errInfo(auditPost2), bad: errInfo(auditBadAction) });

  section('五、截图上传 / 读取 / 删除');
  const REC = 'rec-e2e-' + RUN;
  const upload1 = await upload(ADMIN_TOKEN, REC, [png('one.png'), png('two.png')]);
  const added = upload1.data && Array.isArray(upload1.data.added) ? upload1.data.added : [];
  ep(10, 'POST /api/images/{recordId} multipart files 多文件 → added=2、skipped=0',
    upload1.status === 200 && !!upload1.data && upload1.data.ok === true && added.length === 2 &&
    Array.isArray(upload1.data.skipped) && upload1.data.skipped.length === 0 &&
    added.every((item) => typeof item.file === 'string' && item.file.length > 0 && typeof item.size === 'number'),
    errInfo(upload1));

  const fileOne = added[0] ? added[0].file : 'missing-1.png';
  const fileTwo = added[1] ? added[1].file : 'missing-2.png';
  const imagePath1 = '/api/images/' + encodeURIComponent(REC) + '/' + encodeURIComponent(fileOne);
  const imagePath2 = '/api/images/' + encodeURIComponent(REC) + '/' + encodeURIComponent(fileTwo);
  const imageGet = await call('GET', imagePath1, { token: ADMIN_TOKEN });
  const etag = String(imageGet.headers.get('etag') || '');
  const image304 = etag ? await call('GET', imagePath1, { token: ADMIN_TOKEN, headers: { 'If-None-Match': etag } }) : { status: 0, headers: new Headers(), data: null };
  ep(11, 'GET 截图 → 200 image/png 且字节一致；If-None-Match → 304',
    imageGet.status === 200 && Buffer.isBuffer(imageGet.data) && imageGet.data.equals(PNG) &&
    String(imageGet.headers.get('content-type') || '').includes('image/png') && etag.length > 0 && image304.status === 304,
    { status: imageGet.status, type: String(imageGet.headers.get('content-type') || ''), etag: etag, notModified: image304.status });

  const imageDelete = await call('DELETE', imagePath1, { token: ADMIN_TOKEN });
  const imageGone = await call('GET', imagePath1, { token: ADMIN_TOKEN });
  ep(12, 'DELETE 单张截图 → 200 ok；再 GET → 404 not_found',
    imageDelete.status === 200 && imageDelete.data && imageDelete.data.ok === true && isApiError(imageGone, 404, 'not_found'),
    errInfo(imageDelete));

  const imageDeleteAll = await call('DELETE', '/api/images/' + encodeURIComponent(REC), { token: ADMIN_TOKEN });
  const dirGone = await call('GET', imagePath2, { token: ADMIN_TOKEN });
  ep(13, 'DELETE /api/images/{recordId} 清空目录 → 200 ok',
    imageDeleteAll.status === 200 && imageDeleteAll.data && imageDeleteAll.data.ok === true && isApiError(dirGone, 404, 'not_found'),
    errInfo(imageDeleteAll));

  section('六、备份与占用标记');
  const backupCreate = await call('POST', '/api/backups', { token: ADMIN_TOKEN, json: { reason: 'e2e' } });
  const backupName = backupCreate.data && typeof backupCreate.data.file === 'string' ? backupCreate.data.file : '';
  ep(14, 'POST /api/backups{reason} → {ok,file,count}，文件名 <yyyymmdd-HHmmss-reason>.json',
    backupCreate.status === 200 && !!backupCreate.data && backupCreate.data.ok === true && backupName.length > 0 &&
    /^\d{8}-\d{6}-[A-Za-z0-9_-]+\.json$/.test(backupName) &&
    typeof backupCreate.data.count === 'number' && backupCreate.data.count >= 1,
    errInfo(backupCreate));

  const backupInfo = await call('GET', '/api/backups', { token: ADMIN_TOKEN });
  const backupFiles = backupInfo.data && Array.isArray(backupInfo.data.files) ? backupInfo.data.files : [];
  ep(15, 'GET /api/backups → {count,latest,files:[{name,bytes,at}]} 且包含刚创建的备份',
    backupInfo.status === 200 && !!backupInfo.data && typeof backupInfo.data.count === 'number' &&
    backupInfo.data.count === backupFiles.length && typeof backupInfo.data.latest === 'string' &&
    backupFiles.some((item) => item && item.name === backupName) &&
    backupFiles.every((item) => item && typeof item.name === 'string' && typeof item.bytes === 'number' && typeof item.at === 'number'),
    { count: backupInfo.data && backupInfo.data.count, latest: backupInfo.data && backupInfo.data.latest, lookup: backupName });

  const lock0 = await call('GET', '/api/lock', { token: ADMIN_TOKEN });
  ep(16, 'GET /api/lock → {locked,owner,at,stale}',
    lock0.status === 200 && !!lock0.data && typeof lock0.data.locked === 'boolean' && typeof lock0.data.stale === 'boolean' &&
    'owner' in lock0.data && 'at' in lock0.data,
    errInfo(lock0));

  await call('DELETE', '/api/lock', { token: ADMIN_TOKEN });
  const lockA = await call('POST', '/api/lock', { token: ADMIN_TOKEN, json: { owner: 'e2e-a' } });
  const lockB = await call('POST', '/api/lock', { token: ADMIN_TOKEN, json: { owner: 'e2e-b' } });
  ep(17, 'POST /api/lock{owner} 首锁 200；他人持有 → 409 conflict',
    lockA.status === 200 && !!lockA.data && lockA.data.ok === true && lockA.data.locked === true && lockA.data.owner === 'e2e-a' &&
    isApiError(lockB, 409, 'conflict'),
    { first: errInfo(lockA), second: errInfo(lockB) });

  const unlock1 = await call('DELETE', '/api/lock', { token: ADMIN_TOKEN });
  const unlock2 = await call('DELETE', '/api/lock', { token: ADMIN_TOKEN });
  ep(18, 'DELETE /api/lock 幂等 → 两次均 200',
    unlock1.status === 200 && unlock2.status === 200 && unlock2.data && unlock2.data.ok === true,
    { first: errInfo(unlock1), second: errInfo(unlock2) });

  section('七、注册 → 待审批 → 同意 → 登录 → 角色生效 → 拒绝 → 停用 → 重置密码');
  const PW = 'e2e-Pass-' + RUN;
  const PW2 = 'e2e-Pass2-' + RUN;
  const editorName = 'ed_' + RUN;
  const viewerName = 'vw_' + RUN;
  const rejectedName = 'rj_' + RUN;
  const disabledName = 'ds_' + RUN;

  const regEditor = await call('POST', '/api/register', { json: { username: editorName, password: PW, device: 'e2e-editor' } });
  ep(22, 'POST /api/register → {status:pending}',
    regEditor.status === 200 && !!regEditor.data && regEditor.data.status === 'pending',
    errInfo(regEditor));

  const stEditor = await call('POST', '/api/register/status', { json: { username: editorName, password: PW } });
  const stWrong = await call('POST', '/api/register/status', { json: { username: editorName, password: 'wrong-' + RUN } });
  ep(23, 'POST /api/register/status → pending；口令错误 → none',
    stEditor.status === 200 && stEditor.data && stEditor.data.status === 'pending' &&
    stWrong.status === 200 && stWrong.data && stWrong.data.status === 'none',
    { correct: stEditor.data, wrong: stWrong.data });

  const pendingLogin = await call('POST', '/api/login', { json: { user: editorName, password: PW } });
  ok('附加：pending 账号不能登录（403 且提示等待审批）',
    isApiError(pendingLogin, 403, 'forbidden') && String(pendingLogin.data.error.message).includes('审批'),
    errInfo(pendingLogin));

  const users0 = await adminUsers(ADMIN_TOKEN);
  ep(24, 'GET /api/admin/users（仅 admin）→ users[]（含 pending，绝不含 passHash/salt）',
    users0.response.status === 200 && users0.users.length > 0 &&
    users0.users.some((user) => user.username === editorName && user.status === 'pending') &&
    users0.users.every((user) => typeof user.id === 'string' && typeof user.username === 'string' && typeof user.role === 'string' && typeof user.status === 'string') &&
    users0.users.every((user) => !('passHash' in user) && !('salt' in user) && !('tokenVersion' in user)),
    errInfo(users0.response));

  const editorUser = findUser(users0.users, editorName);
  const approveEditor = await call('POST', '/api/admin/users/' + idOf(editorUser) + '/approve', { token: ADMIN_TOKEN, json: { role: 'editor' } });
  const usersAfterApprove = await adminUsers(ADMIN_TOKEN);
  const editorAfterApprove = findUser(usersAfterApprove.users, editorName);
  ep(25, 'POST /api/admin/users/{id}/approve{role:editor} → 状态 active、角色 editor',
    approveEditor.status === 200 && !!editorAfterApprove && editorAfterApprove.status === 'active' && editorAfterApprove.role === 'editor',
    { approve: errInfo(approveEditor), user: editorAfterApprove });

  const editorLogin = await call('POST', '/api/login', { json: { user: editorName, password: PW } });
  const EDITOR_TOKEN = tokenOf(editorLogin);
  ok('附加：审批通过后 editor 可用原密码登录，role=editor',
    editorLogin.status === 200 && editorLogin.data && editorLogin.data.role === 'editor' && !!EDITOR_TOKEN,
    errInfo(editorLogin));

  const regRejected = await call('POST', '/api/register', { json: { username: rejectedName, password: PW, device: 'e2e-rejected' } });
  ok('附加：被拒流程账号注册 pending', regRejected.status === 200 && regRejected.data && regRejected.data.status === 'pending', errInfo(regRejected));
  const users1 = await adminUsers(ADMIN_TOKEN);
  const rejectedUser = findUser(users1.users, rejectedName);
  const rejectResp = await call('POST', '/api/admin/users/' + idOf(rejectedUser) + '/reject', { token: ADMIN_TOKEN, json: { reason: '资料不全（E2E）' } });
  const stRejected = await call('POST', '/api/register/status', { json: { username: rejectedName, password: PW } });
  const rejectedLogin = await call('POST', '/api/login', { json: { user: rejectedName, password: PW } });
  ep(26, 'POST /api/admin/users/{id}/reject{reason} → rejected；status 带原因；登录 403 带原因',
    rejectResp.status === 200 && stRejected.status === 200 && stRejected.data && stRejected.data.status === 'rejected' &&
    String(stRejected.data.reason || '').includes('资料不全') &&
    isApiError(rejectedLogin, 403, 'forbidden') && String(rejectedLogin.data.error.message).includes('资料不全'),
    { reject: errInfo(rejectResp), status: stRejected.data, login: errInfo(rejectedLogin) });

  const regViewer = await call('POST', '/api/register', { json: { username: viewerName, password: PW, device: 'e2e-viewer' } });
  ok('附加：viewer 流程账号注册 pending', regViewer.status === 200 && regViewer.data && regViewer.data.status === 'pending', errInfo(regViewer));
  const users2 = await adminUsers(ADMIN_TOKEN);
  const viewerUser = findUser(users2.users, viewerName);
  const approveViewer = await call('POST', '/api/admin/users/' + idOf(viewerUser) + '/approve', { token: ADMIN_TOKEN, json: { role: 'viewer' } });
  const viewerLogin = await call('POST', '/api/login', { json: { user: viewerName, password: PW } });
  const VIEWER_TOKEN0 = tokenOf(viewerLogin);
  const viewerWriteBefore = await call('PUT', '/api/records', { token: VIEWER_TOKEN0, json: { records: [{ id: 'r_role', name: 'viewer 不应写入' }] } });
  const roleUp = await call('POST', '/api/admin/users/' + idOf(viewerUser) + '/role', { token: ADMIN_TOKEN, json: { role: 'editor' } });
  const viewerWriteAfterUp = await call('PUT', '/api/records', { token: VIEWER_TOKEN0, json: { records: [{ id: 'r_role', name: '提权后写入' }] } });
  const roleDown = await call('POST', '/api/admin/users/' + idOf(viewerUser) + '/role', { token: ADMIN_TOKEN, json: { role: 'viewer' } });
  const viewerWriteAfterDown = await call('PUT', '/api/records', { token: VIEWER_TOKEN0, json: { records: [{ id: 'r_role', name: '降级后不应写入' }] } });
  ep(27, 'POST /api/admin/users/{id}/role 即时生效（同一 token：viewer 403 → editor 200 → viewer 403）',
    approveViewer.status === 200 && isApiError(viewerWriteBefore, 403, 'forbidden') &&
    roleUp.status === 200 && (viewerWriteAfterUp.status === 200 || viewerWriteAfterUp.status === 201) &&
    roleDown.status === 200 && isApiError(viewerWriteAfterDown, 403, 'forbidden'),
    { approve: errInfo(approveViewer), before: errInfo(viewerWriteBefore), up: roleUp.status, afterUp: viewerWriteAfterUp.status, down: roleDown.status, afterDown: errInfo(viewerWriteAfterDown) });

  const regDisabled = await call('POST', '/api/register', { json: { username: disabledName, password: PW, device: 'e2e-disabled' } });
  ok('附加：停用流程账号注册 pending', regDisabled.status === 200 && regDisabled.data && regDisabled.data.status === 'pending', errInfo(regDisabled));
  const users3 = await adminUsers(ADMIN_TOKEN);
  const disabledUser = findUser(users3.users, disabledName);
  await call('POST', '/api/admin/users/' + idOf(disabledUser) + '/approve', { token: ADMIN_TOKEN, json: { role: 'viewer' } });
  const disabledLogin = await call('POST', '/api/login', { json: { user: disabledName, password: PW } });
  const DISABLED_TOKEN = tokenOf(disabledLogin);
  const disableResp = await call('POST', '/api/admin/users/' + idOf(disabledUser) + '/status', { token: ADMIN_TOKEN, json: { status: 'disabled' } });
  const disabledLogin2 = await call('POST', '/api/login', { json: { user: disabledName, password: PW } });
  const disabledOldToken = await call('GET', '/api/records', { token: DISABLED_TOKEN });
  ep(28, 'POST /api/admin/users/{id}/status{disabled} → 停用；登录 403 带原因；既有 token 立即 401',
    disabledLogin.status === 200 && disableResp.status === 200 &&
    isApiError(disabledLogin2, 403, 'forbidden') && String(disabledLogin2.data.error.message).includes('停用') &&
    isApiError(disabledOldToken, 401, 'unauthorized'),
    { loginBefore: disabledLogin.status, disable: errInfo(disableResp), loginAfter: errInfo(disabledLogin2), oldToken: errInfo(disabledOldToken) });

  const resetResp = await call('POST', '/api/admin/users/' + idOf(viewerUser) + '/reset-password', { token: ADMIN_TOKEN, json: { password: PW2 } });
  const viewerOldToken = await call('GET', '/api/records', { token: VIEWER_TOKEN0 });
  const viewerRelogin = await call('POST', '/api/login', { json: { user: viewerName, password: PW2 } });
  const VIEWER_TOKEN = tokenOf(viewerRelogin);
  ep(29, 'POST /api/admin/users/{id}/reset-password → 旧 token 全部 401、新口令可登录',
    resetResp.status === 200 && isApiError(viewerOldToken, 401, 'unauthorized') &&
    viewerRelogin.status === 200 && viewerRelogin.data.role === 'viewer' && !!VIEWER_TOKEN,
    { reset: errInfo(resetResp), oldToken: errInfo(viewerOldToken), relogin: errInfo(viewerRelogin) });

  // ── 八、审计筛选（EP30）──────────────────────────────
  section('八、审计筛选（EP30）');
  const auditFilter = await call('GET', '/api/audit?action=record_export&limit=2', { token: ADMIN_TOKEN });
  const auditFilterEntries = auditFilter.status === 200 && auditFilter.data && Array.isArray(auditFilter.data.entries) ? auditFilter.data.entries : [];
  const auditMiss = await call('GET', '/api/audit?action=__no_such_action__&limit=5', { token: ADMIN_TOKEN });
  const auditMissEntries = auditMiss.status === 200 && auditMiss.data && Array.isArray(auditMiss.data.entries) ? auditMiss.data.entries : [];
  const auditMine = await call('GET', '/api/audit?action=record_export&limit=2', { token: VIEWER_TOKEN });
  const auditMineEntries = auditMine.status === 200 && auditMine.data && Array.isArray(auditMine.data.entries) ? auditMine.data.entries : [];
  ep(30, 'GET /api/audit?…：admin 可按 action/limit 过滤；普通账号只返回自己最近 50 条',
    auditFilter.status === 200 && auditFilter.data && auditFilter.data.version === 1 &&
    auditFilterEntries.length >= 1 && auditFilterEntries.length <= 2 &&
    auditFilterEntries.every((entry) => String(entry.action) === 'record_export') &&
    auditMiss.status === 200 && auditMissEntries.length === 0 &&
    auditMine.status === 200 && auditMineEntries.length <= 50 &&
    auditMineEntries.every((entry) => String(entry.username || '').toLowerCase() === viewerName.toLowerCase()),
    { admin: errInfo(auditFilter), adminCount: auditFilterEntries.length, missCount: auditMissEntries.length, viewer: errInfo(auditMine), viewerCount: auditMineEntries.length });

  // ── 九、三角色越权矩阵 ───────────────────────────────
  section('九、三角色越权矩阵（viewer 全部 403 / editor 可写 / admin 用户管理）');
  await call('DELETE', '/api/lock', { token: ADMIN_TOKEN });
  const matrixSeedUpload = await upload(ADMIN_TOKEN, REC, [png('matrix-seed.png')]);
  const matrixSeedFile = matrixSeedUpload.data && Array.isArray(matrixSeedUpload.data.added) && matrixSeedUpload.data.added[0]
    ? String(matrixSeedUpload.data.added[0].file || 'matrix-seed.png') : 'matrix-seed.png';
  const matrixCalls = [
    { label: 'PUT /api/records', run: async (token) => {
      const current = await call('GET', '/api/records', { token: token });
      const etag = current.data && current.data.updatedAt ? '"' + current.data.updatedAt + '"' : 'null';
      const records = current.data && Array.isArray(current.data.records) ? current.data.records : [];
      return call('PUT', '/api/records', { token: token, headers: { 'If-Match': etag }, json: { updatedAt: current.data ? current.data.updatedAt : null, records: records } });
    } },
    { label: 'PUT /api/settings', run: async (token) => {
      const current = await call('GET', '/api/settings', { token: token });
      const settings = current.data && typeof current.data === 'object' && !Array.isArray(current.data) ? Object.assign({}, current.data) : {};
      settings.note = 'matrix-' + RUN;
      return call('PUT', '/api/settings', { token: token, json: settings });
    } },
    { label: 'POST /api/images/{recordId}', run: (token) => upload(token, REC, [png('matrix-upload.png')]) },
    { label: 'DELETE /api/images/{recordId}/{file}', run: (token) => call('DELETE', '/api/images/' + encodeURIComponent(REC) + '/' + encodeURIComponent(matrixSeedFile), { token: token }) },
    { label: 'DELETE /api/images/{recordId}', run: (token) => call('DELETE', '/api/images/' + encodeURIComponent(REC), { token: token }) },
    { label: 'POST /api/backups', run: (token) => call('POST', '/api/backups', { token: token, json: { reason: 'matrix-' + RUN } }) },
    { label: 'POST /api/lock', run: (token) => call('POST', '/api/lock', { token: token, json: { owner: 'matrix-' + RUN } }) },
    { label: 'DELETE /api/lock', run: (token) => call('DELETE', '/api/lock', { token: token }) },
  ];
  let matrixViewer403 = 0;
  for (const item of matrixCalls) {
    const response = await item.run(VIEWER_TOKEN);
    if (isApiError(response, 403, 'forbidden')) matrixViewer403 += 1;
    ok('矩阵[viewer] ' + item.label + ' → 403 forbidden', isApiError(response, 403, 'forbidden'), errInfo(response));
  }
  const matrixPendingName = 'mp_' + RUN;
  await call('POST', '/api/register', { json: { username: matrixPendingName, password: PW, device: 'e2e-matrix' } });
  const matrixPendingUser = findUser((await adminUsers(ADMIN_TOKEN)).users, matrixPendingName);
  const adminRouteId = matrixPendingUser ? idOf(matrixPendingUser) : 'missing-' + RUN;
  const adminCases = [
    { label: 'GET /api/admin/users', run: (token) => call('GET', '/api/admin/users', { token: token }) },
    { label: 'POST /api/admin/users/{id}/approve', run: (token) => call('POST', '/api/admin/users/' + adminRouteId + '/approve', { token: token, json: { role: 'viewer' } }) },
    { label: 'POST /api/admin/users/{id}/reject', run: (token) => call('POST', '/api/admin/users/' + (disabledUser ? idOf(disabledUser) : adminRouteId) + '/reject', { token: token, json: { reason: '矩阵拒绝（E2E）' } }) },
    { label: 'POST /api/admin/users/{id}/role', run: (token) => call('POST', '/api/admin/users/' + adminRouteId + '/role', { token: token, json: { role: 'editor' } }) },
    { label: 'POST /api/admin/users/{id}/status', run: (token) => call('POST', '/api/admin/users/' + adminRouteId + '/status', { token: token, json: { status: 'disabled' } }) },
    { label: 'POST /api/admin/users/{id}/reset-password', run: (token) => call('POST', '/api/admin/users/' + adminRouteId + '/reset-password', { token: token, json: { password: PW2 } }) },
  ];
  for (const item of adminCases) {
    const response = await item.run(VIEWER_TOKEN);
    if (isApiError(response, 403, 'forbidden')) matrixViewer403 += 1;
    ok('矩阵[viewer] ' + item.label + ' → 403 forbidden', isApiError(response, 403, 'forbidden'), errInfo(response));
  }
  let matrixEditorWriteOk = 0;
  for (const item of matrixCalls) {
    const response = await item.run(EDITOR_TOKEN);
    if (response.status === 200 || response.status === 201) matrixEditorWriteOk += 1;
    ok('矩阵[editor] ' + item.label + ' → 200/201', response.status === 200 || response.status === 201, errInfo(response));
  }
  let matrixEditorAdmin403 = 0;
  for (const item of adminCases) {
    const response = await item.run(EDITOR_TOKEN);
    if (isApiError(response, 403, 'forbidden')) matrixEditorAdmin403 += 1;
    ok('矩阵[editor] ' + item.label + ' → 403 forbidden（仅 admin）', isApiError(response, 403, 'forbidden'), errInfo(response));
  }
  if (!matrixPendingUser) {
    skip('矩阵[admin] 用户管理接口全部可用', '注册名额已用尽或注册被限流，未能创建待审批账号；请重启服务后复跑');
  } else {
    let matrixAdminOk = 0;
    for (const item of adminCases) {
      const response = await item.run(ADMIN_TOKEN);
      if (response.status === 200 || response.status === 201) matrixAdminOk += 1;
      ok('矩阵[admin] ' + item.label + ' → 200/201', response.status === 200 || response.status === 201, errInfo(response));
    }
    const matrixRestore = await call('POST', '/api/admin/users/' + idOf(matrixPendingUser) + '/status', { token: ADMIN_TOKEN, json: { status: 'active' } });
    ok('矩阵[admin] 恢复待测账号 active', matrixRestore.status === 200, errInfo(matrixRestore));
    ok('矩阵汇总：viewer 14 次 403、editor 8 次写成功、editor 对 6 个 admin 接口 403、admin 6 个接口全部可用',
      matrixViewer403 === matrixCalls.length + adminCases.length &&
      matrixEditorWriteOk === matrixCalls.length &&
      matrixEditorAdmin403 === adminCases.length &&
      matrixAdminOk === adminCases.length,
      { viewer403: matrixViewer403, editorWrite: matrixEditorWriteOk, editorAdmin403: matrixEditorAdmin403, adminOk: matrixAdminOk });
  }
  const adminWriteCheck = await matrixCalls[0].run(ADMIN_TOKEN);
  ok('矩阵[admin] PUT /api/records → 200（admin 隐含 editor 权限）', adminWriteCheck.status === 200, errInfo(adminWriteCheck));

  // ── 十、并发写：双 token 各 20 次 ─────────────────────
  section('十、并发写：2 个 token 同时 PUT /api/records 各 20 次（同一 If-Match）');
  const concBase = await call('GET', '/api/records', { token: ADMIN_TOKEN });
  const concBaseRecords = concBase.data && Array.isArray(concBase.data.records) ? concBase.data.records : [];
  const concBaseUpdatedAt = concBase.data ? concBase.data.updatedAt : null;
  const concEtag = concBaseUpdatedAt ? '"' + concBaseUpdatedAt + '"' : 'null';
  const concRequests = [];
  for (let i = 0; i < 20; i += 1) {
    concRequests.push(call('PUT', '/api/records', { token: EDITOR_TOKEN, headers: { 'If-Match': concEtag },
      json: { updatedAt: concBaseUpdatedAt, records: concBaseRecords.concat([{ id: 'r_conc_a_' + i, name: 'E2E 并发 A#' + i }]) } }));
    concRequests.push(call('PUT', '/api/records', { token: ADMIN_TOKEN, headers: { 'If-Match': concEtag },
      json: { updatedAt: concBaseUpdatedAt, records: concBaseRecords.concat([{ id: 'r_conc_b_' + i, name: 'E2E 并发 B#' + i }]) } }));
  }
  const concOutcomes = await Promise.all(concRequests);
  const concSuccess = concOutcomes.filter((response) => response.status === 200 || response.status === 201).length;
  const concConflict = concOutcomes.filter((response) => isApiError(response, 409, 'conflict')).length;
  const concOther = concOutcomes.filter((response) => response.status !== 200 && response.status !== 201 && response.status !== 409).length;
  ok('并发写：40 次同 ETag PUT 至少 19 次 409（实际 ' + concConflict + '），无网络错误/5xx',
    concBase.status === 200 && concConflict >= 19 && concSuccess >= 1 && concOther === 0,
    { success: concSuccess, conflict: concConflict, other: concOther, statuses: Array.from(new Set(concOutcomes.map((response) => response.status))) });
  const concFinal = await call('GET', '/api/records', { token: ADMIN_TOKEN });
  const concFinalRecords = concFinal.data && Array.isArray(concFinal.data.records) ? concFinal.data.records : [];
  const concNames = concFinalRecords.map((record) => String((record && record.name) || ''));
  ok('并发写：最终台账可读且结构合法（每条 id/name 完整、含并发标记记录）',
    concFinal.status === 200 && concFinal.data && concFinal.data.version === 1 && typeof concFinal.data.updatedAt === 'string' &&
    concFinalRecords.length >= 1 &&
    concFinalRecords.every((record) => record && typeof record.id === 'string' && typeof record.name === 'string') &&
    concNames.some((name) => name.indexOf('E2E 并发 ') === 0),
    { status: concFinal.status, count: concFinalRecords.length, names: concNames.slice(-4) });
  if (!dataDir) {
    skip('并发写：磁盘 certvault.json 合法 + 无 .tmp 残留', '未提供 CV_DATA（CV_BASE 外部服务模式）');
  } else {
    const concDiskPath = path.join(dataDir, 'data', 'certvault.json');
    let concDiskDoc = null;
    try { concDiskDoc = JSON.parse(fs.readFileSync(concDiskPath, 'utf8')); } catch (err) { concDiskDoc = null; }
    ok('并发写：磁盘 certvault.json 为合法 JSON', !!concDiskDoc && concDiskDoc.version === 1 && Array.isArray(concDiskDoc.records),
      concDiskDoc ? { version: concDiskDoc.version, count: Array.isArray(concDiskDoc.records) ? concDiskDoc.records.length : null } : '无法解析 ' + concDiskPath);
    const concTmp = walkTmp(dataDir);
    ok('并发写：数据目录无 .tmp 残留', concTmp.length === 0, concTmp.slice(0, 5));
  }

  // ── 十一、会话：ttlSeconds=86400 / 过期 401 / extend ──
  section('十一、会话：ttlSeconds=86400、过期 401、extend 续期');
  const loginDay = await call('POST', '/api/login', { json: { user: editorName, password: PW, ttlSeconds: 86400 } });
  const dayToken = tokenOf(loginDay);
  const dayPayload = decodeToken(dayToken);
  const daySession = await call('GET', '/api/session', { token: dayToken });
  ok('会话：登录带 ttlSeconds=86400 → token exp-iat=86400、/api/session 一致',
    loginDay.status === 200 && !!dayToken && !!dayPayload && (Number(dayPayload.exp) - Number(dayPayload.iat)) === 86400 &&
    daySession.status === 200 && daySession.data.ttlSeconds === 86400,
    { login: errInfo(loginDay), ttl: dayPayload ? Number(dayPayload.exp) - Number(dayPayload.iat) : null, session: errInfo(daySession) });
  if (!secret || !dayPayload) {
    skip('会话：伪造过期 token → 401（对照未过期 token → 200）', '未读取 config.json secret（CV_DATA 未提供）');
  } else {
    const nowSec = Math.floor(Date.now() / 1000);
    const forgedExpired = forgeToken(secret, Object.assign({}, dayPayload, { iat: nowSec - 9010, exp: nowSec - 10, jti: String(dayPayload.jti) + '-exp' }));
    const expiredResp = await call('GET', '/api/records', { token: forgedExpired });
    ok('会话：已过期 token → 401 unauthorized', isApiError(expiredResp, 401, 'unauthorized'), errInfo(expiredResp));
    const forgedFresh = forgeToken(secret, Object.assign({}, dayPayload, { iat: nowSec, exp: nowSec + 3600, jti: String(dayPayload.jti) + '-fresh' }));
    const freshResp = await call('GET', '/api/records', { token: forgedFresh });
    ok('会话：同 secret 合法签名未过期 token → 200（确认 401 来自过期判断）', freshResp.status === 200, errInfo(freshResp));
  }
  const extendResp = await call('POST', '/api/session/extend', { token: dayToken, json: { ttlSeconds: 172800 } });
  const extendToken = tokenOf(extendResp);
  const extendPayload = decodeToken(extendToken);
  const extendSession = extendToken ? await call('GET', '/api/session', { token: extendToken }) : { status: 0, data: null };
  const dayStillOk = await call('GET', '/api/records', { token: dayToken });
  ep(20, 'POST /api/session/extend{ttlSeconds:172800} → 新 token 有效、ttlSeconds=172800、旧 token 仍可用',
    extendResp.status === 200 && !!extendToken && !!extendPayload &&
    (Number(extendPayload.exp) - Number(extendPayload.iat)) === 172800 &&
    extendSession.status === 200 && extendSession.data.ttlSeconds === 172800 &&
    dayStillOk.status === 200,
    { extend: errInfo(extendResp), ttl: extendPayload ? Number(extendPayload.exp) - Number(extendPayload.iat) : null, session: errInfo(extendSession), oldToken: errInfo(dayStillOk) });

  // ── 十二、登出吊销（EP03）─────────────────────────────
  section('十二、登出：token 立即吊销（EP03）');
  const logoutLogin = await call('POST', '/api/login', { json: { user: ADMIN_USER, password: ADMIN_PASS } });
  const logoutToken = tokenOf(logoutLogin);
  const logoutBefore = await call('GET', '/api/session', { token: logoutToken });
  const logoutResp = await call('POST', '/api/logout', { token: logoutToken });
  const logoutAfter = await call('GET', '/api/records', { token: logoutToken });
  const logoutCookie = String((logoutResp.headers && logoutResp.headers.get('set-cookie')) || '');
  ep(3, 'POST /api/logout → 200；该 token 立即 401；Set-Cookie 清除 cv_token',
    logoutLogin.status === 200 && !!logoutToken && logoutBefore.status === 200 &&
    logoutResp.status === 200 && logoutResp.data && logoutResp.data.ok === true &&
    isApiError(logoutAfter, 401, 'unauthorized') &&
    logoutCookie.indexOf('cv_token=;') === 0,
    { login: errInfo(logoutLogin), before: logoutBefore.status, logout: errInfo(logoutResp), after: errInfo(logoutAfter), setCookie: logoutCookie.slice(0, 120) });

}

function printEndpointTable() {
  const missing = [];
  console.log('');
  console.log('== 端点覆盖表（30）');
  for (const row of ENDPOINTS) {
    const n = row[0];
    const check = endpointChecks[n];
    const label = 'EP' + String(n).padStart(2, '0') + ' ' + row[1] + ' ' + row[2];
    if (check && check.pass) {
      console.log('  OK  ' + label);
    } else if (check) {
      console.log('  FAIL ' + label);
    } else {
      missing.push(label);
      console.log('  ?   ' + label + '（未断言）');
    }
  }
  return missing;
}

function printSummary(missingCount) {
  const passed = results.filter((item) => item.pass).length;
  console.log('');
  console.log('== 汇总');
  console.log('  断言：' + results.length + ' 条，通过 ' + passed + '，失败 ' + failures + '，跳过 ' + skipped + '，端点未断言 ' + missingCount);
  if (failures > 0 || missingCount > 0) {
    console.log('  结论：FAIL（失败 ' + failures + ' 项，未断言端点 ' + missingCount + ' 个）');
    return 1;
  }
  if (skipped > 0) {
    console.log('  结论：PASS（' + skipped + ' 项因环境跳过，建议在可读 CV_DATA 的环境复跑）');
    return 0;
  }
  console.log('  结论：PASS（30 端点 + 三角色矩阵 + 审批流 + 并发 + 会话全部通过）');
  return 0;
}

async function main() {
  let exitCode = 1;
  let missing = [];
  try {
    await run();
    missing = printEndpointTable();
    exitCode = printSummary(missing.length);
  } catch (err) {
    console.log('');
    console.log('== 执行失败：' + (err && err.message ? err.message : String(err)));
    exitCode = 1;
  } finally {
    await cleanup();
  }
  process.exitCode = exitCode;
}

await main();

