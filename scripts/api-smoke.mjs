#!/usr/bin/env node
// CertVault 服务器版接口冒烟测试
// ---------------------------------------------------------------------------
// 零依赖：只用 Node 内置模块 + 全局 fetch（Node 18+）。
//
// 用法：
//   node scripts/api-smoke.mjs                                  # 自己拉起 server/server.js（临时数据目录，跑完清理）
//   CV_BASE=http://127.0.0.1:8090 CV_PASS=xxx node scripts/api-smoke.mjs  # 打一个已在运行的服务
//
// 覆盖：认证双通道（Bearer/Cookie）、401/403/409/413/304、台账 If-Match 乐观锁、
//       截图 multipart 上传（2 张 / 8 张上限 / 8MB 超限 / 非图片跳过）、截图读删、
//       备份只留 10 份、占用标记 4 小时陈旧与冲突、会话续期、注册审批与角色校验、
//       审计筛选、静态站点与目录穿越防护、20 次并发写不残留 .tmp。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(ROOT, 'server', 'server.js');
const APP_DIR = path.join(ROOT, 'app');
const ADMIN_USER = process.env.CV_USER || 'admin';
const ADMIN_PASS = process.env.CV_PASS || 'admin-smoke-123';
const EXTERNAL_BASE = (process.env.CV_BASE || '').replace(/\/+$/, '');

// 1×1 透明 PNG（用来验证上传 + 宽高解析 + 304）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
let failures = 0;
function ok(name, condition, detail) {
  if (condition) {
    results.push({ name, pass: true });
    console.log('  ✓ ' + name);
    return true;
  }
  failures += 1;
  results.push({ name, pass: false, detail });
  const extra = detail === undefined ? '' : '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.log('  ✗ ' + name + extra);
  return false;
}

function section(title) {
  console.log('\n— ' + title);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, serverLog, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) return await response.json();
      lastError = 'HTTP ' + response.status;
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
    }
    await sleep(120);
  }
  throw new Error('服务在 ' + timeoutMs + 'ms 内没有就绪（' + lastError + '）\n服务端输出：\n' + serverLog());
}

// 统一请求封装：json 走 JSON，raw 走原始字节（multipart / 空 body）
async function call(base, method, pathname, options) {
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
  const response = await fetch(base + pathname, { method, headers, body, redirect: 'manual' });
  const contentType = String(response.headers.get('content-type') || '');
  let data;
  if (contentType.includes('application/json')) data = await response.json();
  else data = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, data };
}

function multipart(files) {
  const boundary = '----cvsmoke' + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const file of files) {
    chunks.push(Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="files"; filename="' + file.name + '"\r\n' +
      'Content-Type: ' + (file.type || 'image/png') + '\r\n\r\n',
      'utf8',
    ));
    chunks.push(file.data);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n', 'utf8'));
  return { boundary, body: Buffer.concat(chunks) };
}

function cookieOf(response) {
  const raw = response.headers.get('set-cookie') || '';
  const match = /^cv_token=([^;]+)/.exec(raw);
  return match ? 'cv_token=' + match[1] : '';
}

function isApiError(response, expectedStatus, expectedCode) {
  return response.status === expectedStatus && response.data && response.data.error && response.data.error.code === expectedCode;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function run() {
  let child = null;
  let serverLog = '';
  let dataDir = '';
  let base = EXTERNAL_BASE;
  const extraDirs = []; // 追加实例（XFF 信任 / 重启持久化）的临时数据目录
  try {
    if (!base) {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'certvault-smoke-'));
      const port = await freePort();
      base = 'http://127.0.0.1:' + port;
      child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
          CV_DATA: dataDir,
          CV_PORT: String(port),
          CV_HOST: '127.0.0.1',
          CV_USER: ADMIN_USER,
          CV_PASS: ADMIN_PASS,
          CV_TZ: 'Asia/Shanghai',
          CV_APP_DIR: APP_DIR,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunkBuf) => { serverLog += chunkBuf.toString(); });
      child.stderr.on('data', (chunkBuf) => { serverLog += chunkBuf.toString(); });
    }

    // 追加起停独立服务进程：XFF 信任模式、重启后吊销持久化这类用例必须换进程/换数据目录
    const startExtraServer = async (dir, extraEnv) => {
      const port = await freePort();
      const logStart = serverLog.length;
      const proc = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
          CV_DATA: dir,
          CV_PORT: String(port),
          CV_HOST: '127.0.0.1',
          CV_USER: ADMIN_USER,
          CV_PASS: ADMIN_PASS,
          CV_TZ: 'Asia/Shanghai',
          CV_APP_DIR: APP_DIR,
        }, extraEnv || {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout.on('data', (chunkBuf) => { serverLog += chunkBuf.toString(); });
      proc.stderr.on('data', (chunkBuf) => { serverLog += chunkBuf.toString(); });
      const url = 'http://127.0.0.1:' + port;
      await waitForHealth(url, () => serverLog.slice(logStart));
      return { proc, base: url };
    };
    const stopExtraServer = async (proc) => {
      if (!proc || proc.exitCode !== null) return;
      const exited = new Promise((resolve) => proc.once('exit', () => resolve('exit')));
      proc.kill('SIGTERM');
      const first = await Promise.race([exited, sleep(3000).then(() => 'timeout')]);
      if (first === 'timeout') {
        proc.kill('SIGKILL');
        await Promise.race([exited, sleep(2000)]);
      }
    };

    const health = await waitForHealth(base, () => serverLog);
    console.log('CertVault 接口冒烟测试 · 服务地址 ' + base);

    const upload = async (token, recordId, files) => {
      const form = multipart(files);
      return call(base, 'POST', '/api/images/' + recordId, {
        token,
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + form.boundary },
        raw: form.body,
      });
    };

    section('健康检查与公开配置（免认证）');
    ok('GET /api/health 返回 ok/name/version',
      health.ok === true && health.name === 'CertVault' && !!health.version);
    ok('GET /api/health 带 records/images/uptime 统计',
      typeof health.records === 'number' && typeof health.images === 'number' && typeof health.uptime === 'number',
      health);
    const publicConfig = await call(base, 'GET', '/api/config/public');
    ok('GET /api/config/public 免认证返回 {name,version,serverTime,loginHint}',
      publicConfig.status === 200 && publicConfig.data.name === 'CertVault' && !!publicConfig.data.version && !!publicConfig.data.serverTime && !!publicConfig.data.loginHint);
    const preflight = await call(base, 'OPTIONS', '/api/records', {
      headers: { Origin: 'http://example.local', 'Access-Control-Request-Method': 'PUT' },
    });
    ok('OPTIONS 预检 → 204', preflight.status === 204);

    section('认证：401 / 登录 / Bearer 优先 / Cookie 兜底');
    const unauth = await call(base, 'GET', '/api/records');
    ok('GET /api/records 无 token → 401 unauthorized', isApiError(unauth, 401, 'unauthorized'));
    const wrongPass = await call(base, 'POST', '/api/login', { json: { user: ADMIN_USER, password: 'wrong-password' } });
    ok('POST /api/login 口令错误 → 401 unauthorized', isApiError(wrongPass, 401, 'unauthorized'));
    const login = await call(base, 'POST', '/api/login', { json: { user: ADMIN_USER, password: ADMIN_PASS } });
    ok('管理员登录成功，返回 token 与 role=admin',
      login.status === 200 && login.data.ok === true && login.data.role === 'admin' && typeof login.data.token === 'string' && login.data.token.includes('.'));
    const setCookie = String(login.headers.get('set-cookie') || '');
    ok('登录响应 Set-Cookie: cv_token（HttpOnly + SameSite=Lax）',
      /cv_token=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(setCookie) && /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie),
      setCookie);
    const ADMIN_TOKEN = login.data.token;
    const ADMIN_COOKIE = cookieOf(login);
    const withBearer = await call(base, 'GET', '/api/records', { token: ADMIN_TOKEN });
    ok('Bearer 通道可访问 GET /api/records',
      withBearer.status === 200 && withBearer.data.version === 1 && Array.isArray(withBearer.data.records));
    ok('初始台账为 {version:1, updatedAt:null, records:[]}',
      withBearer.data.updatedAt === null && withBearer.data.records.length === 0);
    const withCookie = await call(base, 'GET', '/api/records', { cookie: ADMIN_COOKIE });
    ok('Cookie 兜底通道可访问 GET /api/records', withCookie.status === 200);
    const bearerWins = await call(base, 'GET', '/api/records', { token: 'not-a-valid-token', cookie: ADMIN_COOKIE });
    ok('Bearer 优先：无效 Bearer 不会回退到 Cookie → 401', isApiError(bearerWins, 401, 'unauthorized'));

    section('台账读写与 If-Match 乐观锁');
    const firstWrite = await call(base, 'PUT', '/api/records', {
      token: ADMIN_TOKEN,
      headers: { 'If-Match': '' },
      json: { updatedAt: null, records: [{ id: 'r_1', name: '第一张 CA' }] },
    });
    ok('PUT /api/records 首次写入（If-Match 空）→ 200 且返回 updatedAt',
      firstWrite.status === 200 && firstWrite.data.ok === true && typeof firstWrite.data.updatedAt === 'string');
    const ETAG1 = firstWrite.data.updatedAt;
    const staleWrite = await call(base, 'PUT', '/api/records', {
      token: ADMIN_TOKEN,
      headers: { 'If-Match': 'null' },
      json: { updatedAt: null, records: [] },
    });
    ok('PUT /api/records 陈旧 If-Match → 409 conflict 且提示「有人刚改过，请刷新后重试」',
      isApiError(staleWrite, 409, 'conflict') && String(staleWrite.data.error.message).includes('有人刚改过'));
    const freshWrite = await call(base, 'PUT', '/api/records', {
      token: ADMIN_TOKEN,
      headers: { 'If-Match': ETAG1 },
      json: { updatedAt: ETAG1, records: [{ id: 'r_1', name: '第一张 CA' }, { id: 'r_2', name: '第二张 CA' }] },
    });
    ok('PUT /api/records 带最新 If-Match → 200（count=2）', freshWrite.status === 200 && freshWrite.data.count === 2);
    const quotedWrite = await call(base, 'PUT', '/api/records', {
      token: ADMIN_TOKEN,
      headers: { 'If-Match': '"' + freshWrite.data.updatedAt + '"' },
      json: { records: [{ id: 'r_1', name: '第一张 CA' }, { id: 'r_2', name: '第二张 CA' }, { id: 'r_3', name: '第三张 CA' }] },
    });
    ok('PUT /api/records 支持带双引号的 ETag', quotedWrite.status === 200);
    const recordsNow = await call(base, 'GET', '/api/records', { token: ADMIN_TOKEN });
    ok('GET /api/records 返回 3 条记录与最新 updatedAt',
      recordsNow.status === 200 && recordsNow.data.records.length === 3 && typeof recordsNow.data.updatedAt === 'string');

    section('设置读写');
    const settings0 = await call(base, 'GET', '/api/settings', { token: ADMIN_TOKEN });
    ok('GET /api/settings 返回默认设置（popupIntervalHours=12）',
      settings0.status === 200 && settings0.data.version === 1 && settings0.data.popupIntervalHours === 12);
    const settingsPut = await call(base, 'PUT', '/api/settings', { token: ADMIN_TOKEN, json: { popupIntervalHours: 24, trayMinimize: false } });
    ok('PUT /api/settings → 200', settingsPut.status === 200 && settingsPut.data.ok === true);
    const settings1 = await call(base, 'GET', '/api/settings', { token: ADMIN_TOKEN });
    ok('GET /api/settings 读到新值且保留其他默认项',
      settings1.data.popupIntervalHours === 24 && settings1.data.trayMinimize === false && settings1.data.autostart === false);

    section('审计日志');
    const auditPost = await call(base, 'POST', '/api/audit', { token: ADMIN_TOKEN, json: { action: 'record_export', detail: '导出 smoke.xlsx' } });
    ok('POST /api/audit 追加一条 → ok', auditPost.status === 200 && auditPost.data.ok === true);
    const auditGet = await call(base, 'GET', '/api/audit', { token: ADMIN_TOKEN });
    ok('GET /api/audit 返回 {version,entries} 且含 login 与 record_export',
      auditGet.status === 200 && auditGet.data.version === 1 && Array.isArray(auditGet.data.entries) &&
      auditGet.data.entries.some((e) => e.action === 'login') && auditGet.data.entries.some((e) => e.action === 'record_export'));
    const lastEntry = auditGet.data.entries[auditGet.data.entries.length - 1];
    ok('审计条目带 at/ts/userId/username/ip/ok（桌面版日志面板读 ts）',
      !!lastEntry && !!lastEntry.at && !!lastEntry.ts && !!lastEntry.userId && lastEntry.username === ADMIN_USER && typeof lastEntry.ok === 'boolean');
    const auditFilter = await call(base, 'GET', '/api/audit?action=login&limit=3', { token: ADMIN_TOKEN });
    ok('GET /api/audit?action=login&limit=3 只返回 login 且不超过 3 条',
      auditFilter.status === 200 && auditFilter.data.entries.length > 0 && auditFilter.data.entries.length <= 3 &&
      auditFilter.data.entries.every((e) => e.action === 'login'));

    section('截图：multipart 上传 / 读取(304) / 删除');
    const up1 = await upload(ADMIN_TOKEN, 'rec-smoke-1', [
      { name: 'one.png', data: PNG, type: 'image/png' },
      { name: 'two.png', data: PNG, type: 'image/png' },
    ]);
    ok('POST /api/images/rec-smoke-1 上传 2 张 → added 2、skipped 0',
      up1.status === 200 && up1.data.added.length === 2 && up1.data.skipped.length === 0);
    ok('截图元数据 {file,w,h,size,addedAt} 且宽高解析为 1×1、文件名符合桌面版规则',
      up1.data.added.every((f) => f.w === 1 && f.h === 1 && f.size === PNG.length && !!f.addedAt &&
        /^\d{8}-\d{6}-[0-9a-f]{4}\.png$/.test(String(f.file))));
    const imgName = up1.data.added[0].file;
    const imgGet = await call(base, 'GET', '/api/images/rec-smoke-1/' + imgName, { token: ADMIN_TOKEN });
    ok('GET 截图返回 image/png 且字节完全一致',
      imgGet.status === 200 && Buffer.isBuffer(imgGet.data) && Buffer.compare(imgGet.data, PNG) === 0 &&
      String(imgGet.headers.get('content-type')).includes('image/png'));
    const img304 = await call(base, 'GET', '/api/images/rec-smoke-1/' + imgName, {
      token: ADMIN_TOKEN,
      headers: { 'If-None-Match': String(imgGet.headers.get('etag') || '') },
    });
    ok('GET 截图带 If-None-Match → 304', img304.status === 304);
    const imgMissing = await call(base, 'GET', '/api/images/rec-smoke-1/nope.png', { token: ADMIN_TOKEN });
    ok('GET 不存在的截图 → 404 not_found', isApiError(imgMissing, 404, 'not_found'));
    const delOne = await call(base, 'DELETE', '/api/images/rec-smoke-1/' + imgName, { token: ADMIN_TOKEN });
    ok('DELETE /api/images/<record>/<file> → 200', delOne.status === 200 && delOne.data.ok === true);
    const imgGone = await call(base, 'GET', '/api/images/rec-smoke-1/' + imgName, { token: ADMIN_TOKEN });
    ok('删除后再 GET → 404', imgGone.status === 404);

    const bulkFiles = [];
    for (let i = 0; i < 6; i += 1) bulkFiles.push({ name: 'bulk-' + i + '.png', data: PNG, type: 'image/png' });
    bulkFiles.push({ name: 'notes.txt', data: Buffer.from('not an image', 'utf8'), type: 'text/plain' });
    bulkFiles.push({ name: 'huge.png', data: Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]), type: 'image/png' });
    for (let i = 0; i < 3; i += 1) bulkFiles.push({ name: 'extra-' + i + '.png', data: PNG, type: 'image/png' });
    const bulk = await upload(ADMIN_TOKEN, 'rec-bulk', bulkFiles);
    ok('批量上传：单条记录最多 8 张（7 张有效图 + 溢出）→ added 8',
      bulk.status === 200 && bulk.data.added.length === 8, bulk.data && bulk.data.skipped);
    ok('非图片文件被跳过并给出中文原因',
      bulk.data.skipped.some((s) => s.name === 'notes.txt' && String(s.reason).includes('不是图片')));
    ok('单张 >8MB 被跳过并给出中文原因',
      bulk.data.skipped.some((s) => s.name === 'huge.png' && String(s.reason).includes('8MB')));
    ok('超过 8 张上限被跳过并给出中文原因',
      bulk.data.skipped.some((s) => String(s.reason).includes('8 张上限')));
    const delAll = await call(base, 'DELETE', '/api/images/rec-bulk', { token: ADMIN_TOKEN });
    ok('DELETE /api/images/<record> 清空该记录截图 → 200', delAll.status === 200 && delAll.data.ok === true);
    const bulkGone = await call(base, 'GET', '/api/images/rec-bulk/' + bulk.data.added[0].file, { token: ADMIN_TOKEN });
    ok('清空后截图 GET → 404', bulkGone.status === 404);

    section('备份只留最近 10 份');
    const backup1 = await call(base, 'POST', '/api/backups', { token: ADMIN_TOKEN, json: { reason: 'smoke' } });
    ok('POST /api/backups → 200 且文件名符合 yyyyMMdd-HHmmss-reason.json',
      backup1.status === 200 && backup1.data.ok === true &&
      /^\d{8}-\d{6}-[A-Za-z0-9_-]+\.json$/.test(String(backup1.data.file)) && backup1.data.count === 1);
    for (let i = 0; i < 11; i += 1) {
      await call(base, 'POST', '/api/backups', { token: ADMIN_TOKEN, json: { reason: 'bulk' + i } });
    }
    const backups = await call(base, 'GET', '/api/backups', { token: ADMIN_TOKEN });
    ok('连续备份 12 次后只保留 10 份', backups.status === 200 && backups.data.count === 10 && backups.data.files.length === 10);
    ok('GET /api/backups 对齐桌面 backupInfo（latest/latestAt/bytes）',
      typeof backups.data.latest === 'string' && backups.data.latest.length > 0 && backups.data.latestAt > 0 && backups.data.bytes > 0);

    section('占用标记（4 小时陈旧可接管）');
    const lock0 = await call(base, 'GET', '/api/lock', { token: ADMIN_TOKEN });
    ok('GET /api/lock 初始 locked=false', lock0.status === 200 && lock0.data.locked === false && lock0.data.stale === false);
    const lockA = await call(base, 'POST', '/api/lock', { token: ADMIN_TOKEN, json: { owner: 'smoke-a' } });
    ok('POST /api/lock 抢锁 → locked=true', lockA.status === 200 && lockA.data.locked === true && lockA.data.owner === 'smoke-a');
    const lockB = await call(base, 'POST', '/api/lock', { token: ADMIN_TOKEN, json: { owner: 'smoke-b' } });
    ok('他人持有时 POST /api/lock → 409 conflict', isApiError(lockB, 409, 'conflict'));
    const lockGet = await call(base, 'GET', '/api/lock', { token: ADMIN_TOKEN });
    ok('GET /api/lock 返回 owner/at/stale=false',
      lockGet.data.locked === true && lockGet.data.owner === 'smoke-a' && lockGet.data.stale === false && !!lockGet.data.at);
    const lockDel = await call(base, 'DELETE', '/api/lock', { token: ADMIN_TOKEN });
    ok('DELETE /api/lock → 200', lockDel.status === 200);
    const lockDel2 = await call(base, 'DELETE', '/api/lock', { token: ADMIN_TOKEN });
    ok('DELETE /api/lock 幂等（再删一次仍 200）', lockDel2.status === 200);

    section('会话信息与续期');
    const sess = await call(base, 'GET', '/api/session', { token: ADMIN_TOKEN });
    ok('GET /api/session 返回 user/role/expiresAt/ttlSeconds/idleTimeoutSeconds',
      sess.status === 200 && sess.data.user.username === ADMIN_USER && sess.data.role === 'admin' &&
      typeof sess.data.expiresAt === 'string' && sess.data.ttlSeconds > 0 && typeof sess.data.idleTimeoutSeconds === 'number');
    const extend = await call(base, 'POST', '/api/session/extend', { token: ADMIN_TOKEN, json: { ttlSeconds: 3600 } });
    ok('POST /api/session/extend{ttlSeconds:3600} → 新 token 且 ttlSeconds=3600',
      extend.status === 200 && typeof extend.data.token === 'string' && extend.data.ttlSeconds === 3600);
    const extendUse = await call(base, 'GET', '/api/session', { token: extend.data.token });
    ok('续期后的新 token 可用', extendUse.status === 200 && extendUse.data.ttlSeconds === 3600);
    const clampLogin = await call(base, 'POST', '/api/login', { json: { user: ADMIN_USER, password: ADMIN_PASS, ttlSeconds: 999999999 } });
    ok('登录 ttlSeconds 被 maxTtlSeconds 夹紧（不超过 3650 天）',
      clampLogin.status === 200 && clampLogin.data.ttlSeconds <= 3650 * 24 * 3600);

    section('注册 → 审批 → 角色校验（requireRole 骨架）');
    const reg1 = await call(base, 'POST', '/api/register', { json: { username: 'smokeditor', password: 'smoke123456', device: 'smoke-cli' } });
    ok('POST /api/register → {status:pending}', reg1.status === 200 && reg1.data.status === 'pending');
    const regDup = await call(base, 'POST', '/api/register', { json: { username: 'smokeditor', password: 'smoke123456' } });
    ok('重复注册同一用户名 → 409 conflict', isApiError(regDup, 409, 'conflict'));
    const regBad = await call(base, 'POST', '/api/register', { json: { username: 'ab', password: '123' } });
    ok('非法用户名 / 短密码 → 400 bad_request', isApiError(regBad, 400, 'bad_request'));
    const regStatus1 = await call(base, 'POST', '/api/register/status', { json: { username: 'smokeditor', password: 'smoke123456' } });
    ok('POST /api/register/status → pending', regStatus1.status === 200 && regStatus1.data.status === 'pending');
    const regPendingLogin = await call(base, 'POST', '/api/login', { json: { user: 'smokeditor', password: 'smoke123456' } });
    ok('未审批账号登录 → 403 forbidden', isApiError(regPendingLogin, 403, 'forbidden'));
    const adminUsers = await call(base, 'GET', '/api/admin/users', { token: ADMIN_TOKEN });
    ok('GET /api/admin/users 列出待审批账号（不含 passHash/salt）',
      adminUsers.status === 200 && adminUsers.data.users.some((u) => u.username === 'smokeditor' && u.status === 'pending') &&
      adminUsers.data.users.every((u) => !('passHash' in u) && !('salt' in u)));
    const pendingUser = adminUsers.data.users.find((u) => u.username === 'smokeditor');
    const approve = await call(base, 'POST', '/api/admin/users/' + pendingUser.id + '/approve', { token: ADMIN_TOKEN, json: { role: 'editor' } });
    ok('POST /api/admin/users/<id>/approve{role:editor} → active/editor',
      approve.status === 200 && approve.data.user.status === 'active' && approve.data.user.role === 'editor');
    const editorLogin = await call(base, 'POST', '/api/login', { json: { user: 'smokeditor', password: 'smoke123456' } });
    ok('审批后可登录，角色 editor', editorLogin.status === 200 && editorLogin.data.role === 'editor');
    const EDITOR_TOKEN = editorLogin.data.token;
    const editorWrite = await call(base, 'PUT', '/api/records', { token: EDITOR_TOKEN, json: { records: recordsNow.data.records } });
    ok('editor 可写台账 → 200', editorWrite.status === 200);
    const roleToViewer = await call(base, 'POST', '/api/admin/users/' + pendingUser.id + '/role', { token: ADMIN_TOKEN, json: { role: 'viewer' } });
    ok('POST /api/admin/users/<id>/role → viewer', roleToViewer.status === 200 && roleToViewer.data.user.role === 'viewer');
    const viewerWrite = await call(base, 'PUT', '/api/records', { token: EDITOR_TOKEN, json: { records: recordsNow.data.records } });
    ok('降级为 viewer 后写台账 → 403 forbidden 且「只有查看权限」',
      isApiError(viewerWrite, 403, 'forbidden') && String(viewerWrite.data.error.message).includes('只有查看权限'));
    const viewerRead = await call(base, 'GET', '/api/records', { token: EDITOR_TOKEN });
    ok('viewer 仍可读台账 → 200', viewerRead.status === 200);
    const viewerImageDel = await call(base, 'DELETE', '/api/images/rec-smoke-1', { token: EDITOR_TOKEN });
    ok('viewer 删除截图 → 403 forbidden', isApiError(viewerImageDel, 403, 'forbidden'));
    const viewerAdmin = await call(base, 'GET', '/api/admin/users', { token: EDITOR_TOKEN });
    ok('viewer 访问 /api/admin/users → 403 forbidden', isApiError(viewerAdmin, 403, 'forbidden'));

    const reg2 = await call(base, 'POST', '/api/register', { json: { username: 'smokereject', password: 'smoke123456', device: 'smoke-cli' } });
    ok('第二个账号注册 → pending', reg2.status === 200 && reg2.data.status === 'pending');
    const users2 = await call(base, 'GET', '/api/admin/users', { token: ADMIN_TOKEN });
    const rejectUser = users2.data.users.find((u) => u.username === 'smokereject');
    const reject = await call(base, 'POST', '/api/admin/users/' + rejectUser.id + '/reject', { token: ADMIN_TOKEN, json: { reason: '冒烟测试' } });
    ok('POST /api/admin/users/<id>/reject{reason} → rejected',
      reject.status === 200 && reject.data.user.status === 'rejected');
    const regStatus2 = await call(base, 'POST', '/api/register/status', { json: { username: 'smokereject', password: 'smoke123456' } });
    ok('register/status 返回 rejected + reason',
      regStatus2.data.status === 'rejected' && String(regStatus2.data.reason || '').includes('冒烟测试'));
    const rejectedLogin = await call(base, 'POST', '/api/login', { json: { user: 'smokereject', password: 'smoke123456' } });
    ok('被拒账号登录 → 403 且 message 带原因',
      isApiError(rejectedLogin, 403, 'forbidden') && String(rejectedLogin.data.error.message).includes('冒烟测试'));

    const reset = await call(base, 'POST', '/api/admin/users/' + pendingUser.id + '/reset-password', { token: ADMIN_TOKEN, json: { password: 'smoke654321' } });
    ok('POST /api/admin/users/<id>/reset-password → tokenVersion 递增到 2',
      reset.status === 200 && reset.data.tokenVersion === 2);
    const oldTokenAfterReset = await call(base, 'GET', '/api/records', { token: EDITOR_TOKEN });
    ok('重置密码后旧 token 立即失效 → 401', isApiError(oldTokenAfterReset, 401, 'unauthorized'));
    const newLogin = await call(base, 'POST', '/api/login', { json: { user: 'smokeditor', password: 'smoke654321' } });
    ok('重置后用新口令登录成功', newLogin.status === 200);
    const disable = await call(base, 'POST', '/api/admin/users/' + pendingUser.id + '/status', { token: ADMIN_TOKEN, json: { status: 'disabled' } });
    ok('POST /api/admin/users/<id>/status{disabled} → disabled',
      disable.status === 200 && disable.data.user.status === 'disabled');
    const disabledLogin = await call(base, 'POST', '/api/login', { json: { user: 'smokeditor', password: 'smoke654321' } });
    ok('停用账号登录 → 403 forbidden', isApiError(disabledLogin, 403, 'forbidden'));
    const selfDisable = await call(base, 'POST', '/api/admin/users/' + login.data.user.id + '/status', { token: ADMIN_TOKEN, json: { status: 'disabled' } });
    ok('停用当前登录账号 → 400 bad_request', isApiError(selfDisable, 400, 'bad_request'));
    const lastAdmin = await call(base, 'POST', '/api/admin/users/' + login.data.user.id + '/role', { token: ADMIN_TOKEN, json: { role: 'viewer' } });
    ok('降级最后一个管理员 → 400 bad_request', isApiError(lastAdmin, 400, 'bad_request'));

    section('多用户留痕与审计条目（§11 / §12）');
    // 上一段把 smokeditor 停用了，这里重新启用得到一个 viewer 会话
    const reactivate = await call(base, 'POST', '/api/admin/users/' + pendingUser.id + '/status', { token: ADMIN_TOKEN, json: { status: 'active' } });
    ok('管理员可重新启用账号 → active', reactivate.status === 200 && reactivate.data.user.status === 'active');
    const viewerLogin = await call(base, 'POST', '/api/login', { json: { user: 'smokeditor', password: 'smoke654321' } });
    ok('viewer 重新启用后可登录', viewerLogin.status === 200 && viewerLogin.data.role === 'viewer');
    const VIEWER_TOKEN = viewerLogin.data.token;
    const viewerId = viewerLogin.data.user.id;
    const viewerForbidden = [
      ['PUT /api/settings（viewer 改设置）', 'PUT', '/api/settings', { settings: { popupIntervalHours: 1 } }],
      ['POST /api/backups（viewer 建备份）', 'POST', '/api/backups', { reason: 'viewer' }],
      ['POST /api/lock（viewer 加锁）', 'POST', '/api/lock', { owner: 'viewer' }],
      ['DELETE /api/lock（viewer 解锁）', 'DELETE', '/api/lock', {}],
    ];
    for (const item of viewerForbidden) {
      const resp = await call(base, item[1], item[2], { token: VIEWER_TOKEN, json: item[3] });
      ok(item[0] + ' → 403 forbidden 且「只有查看权限」',
        isApiError(resp, 403, 'forbidden') && String(resp.data.error.message).includes('只有查看权限'),
        resp.status + ' ' + JSON.stringify(resp.data).slice(0, 120));
    }
    const viewerReads = await Promise.all([
      call(base, 'GET', '/api/settings', { token: VIEWER_TOKEN }),
      call(base, 'GET', '/api/backups', { token: VIEWER_TOKEN }),
      call(base, 'GET', '/api/lock', { token: VIEWER_TOKEN }),
    ]);
    ok('viewer 可读设置 / 备份信息 / 占用信息 → 200', viewerReads.every((r) => r.status === 200));

    // login_failed：ok:false，且带 ip 与数值型 ms
    await call(base, 'POST', '/api/login', { json: { user: ADMIN_USER, password: 'wrong-password-xyz' } });
    const failedAudit = await call(base, 'GET', '/api/audit?action=login_failed&limit=5', { token: ADMIN_TOKEN });
    const failedEntry = failedAudit.data.entries[failedAudit.data.entries.length - 1];
    ok('login_failed 条目 ok:false、ip 非空、ms 为数字',
      failedAudit.status === 200 && !!failedEntry && failedEntry.action === 'login_failed' && failedEntry.ok === false &&
      typeof failedEntry.ip === 'string' && failedEntry.ip.length > 0 && typeof failedEntry.ms === 'number' && failedEntry.ms >= 0,
      failedEntry);

    // 审批类动作由服务端自记，target 用用户名
    const allAudit = await call(base, 'GET', '/api/audit?limit=500', { token: ADMIN_TOKEN });
    const actionsSeen = new Set(allAudit.data.entries.map((e) => e.action));
    const wantActions = ['user_register', 'user_approve', 'user_reject', 'user_role', 'user_status', 'user_reset_password'];
    ok('审计覆盖 user_register / approve / reject / role / status / reset_password',
      wantActions.every((a) => actionsSeen.has(a)), wantActions.filter((a) => !actionsSeen.has(a)).join(',') || '全部命中');
    ok('审批类条目以用户名为 target（smokeditor / smokereject）',
      allAudit.data.entries.some((e) => e.action === 'user_approve' && e.target === 'smokeditor') &&
      allAudit.data.entries.some((e) => e.action === 'user_reject' && e.target === 'smokereject'));

    // 客户端伪造 userId/ok/ms/ip 一律忽略，身份以 token 为准
    const spoof = await call(base, 'POST', '/api/audit', {
      token: VIEWER_TOKEN,
      json: { action: 'record_export', detail: '冒烟：伪造 userId', userId: 'u_deadbeefdead', username: 'fake', role: 'admin', ok: false, ms: 999999, ip: '10.9.9.9' },
    });
    ok('POST /api/audit（viewer 自记导出）→ 200', spoof.status === 200 && spoof.data.ok === true);
    const afterSpoof = await call(base, 'GET', '/api/audit?limit=50', { token: VIEWER_TOKEN });
    const spoofEntry = afterSpoof.data.entries.filter((e) => e.action === 'record_export').slice(-1)[0];
    ok('伪造的 userId / ok / ms 被忽略（身份取 token）',
      !!spoofEntry && spoofEntry.userId === viewerId && spoofEntry.username === 'smokeditor' &&
      spoofEntry.ok === true && spoofEntry.ms < 999999, spoofEntry);

    // 数组批量追加
    const beforeBatch = (await call(base, 'GET', '/api/audit?limit=1000', { token: ADMIN_TOKEN })).data.entries.length;
    const batch = await call(base, 'POST', '/api/audit', {
      token: ADMIN_TOKEN,
      json: [{ action: 'record_export', detail: '批量 1' }, { action: 'record_import', detail: '批量 2' }],
    });
    const afterBatchDoc = (await call(base, 'GET', '/api/audit?limit=1000', { token: ADMIN_TOKEN })).data;
    ok('POST /api/audit 数组批量追加 2 条', batch.status === 200 && afterBatchDoc.entries.length >= beforeBatch + 2);

    // 筛选：user / from / to
    const byUser = await call(base, 'GET', '/api/audit?user=smokeditor&limit=500', { token: ADMIN_TOKEN });
    ok('GET /api/audit?user=smokeditor 只返回该账号条目',
      byUser.status === 200 && byUser.data.entries.length > 0 && byUser.data.entries.every((e) => e.username === 'smokeditor'));
    const fromIso = new Date(Date.now() - 3600 * 1000).toISOString();
    const toIso = new Date(Date.now() + 60 * 1000).toISOString();
    const byTime = await call(base, 'GET', '/api/audit?from=' + encodeURIComponent(fromIso) + '&to=' + encodeURIComponent(toIso) + '&limit=500', { token: ADMIN_TOKEN });
    ok('GET /api/audit?from&to 时间筛选生效',
      byTime.status === 200 && byTime.data.entries.length > 0 && byTime.data.entries.every((e) => e.at >= fromIso && e.at <= toIso));

    // 非 admin 只能看自己最近 50 条
    const viewerAudit = await call(base, 'GET', '/api/audit?limit=500', { token: VIEWER_TOKEN });
    ok('非 admin 查审计只得到自己最近 50 条',
      viewerAudit.status === 200 && viewerAudit.data.entries.length > 0 && viewerAudit.data.entries.length <= 50 &&
      viewerAudit.data.entries.every((e) => e.userId === viewerId || e.username === 'smokeditor'));

    // 保留策略是 5000 条：批量写 250 条后磁盘 audit.json 应 > 200 条
    const bulkAudit = [];
    for (let i = 0; i < 250; i += 1) bulkAudit.push({ action: 'record_export', detail: '保留策略 smoke ' + i });
    const bulkPost = await call(base, 'POST', '/api/audit', { token: ADMIN_TOKEN, json: bulkAudit });
    ok('批量追加 250 条审计 → 200', bulkPost.status === 200);
    if (dataDir) {
      const rawDiskAudit = JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'audit.json'), 'utf8'));
      const diskEntries = Array.isArray(rawDiskAudit) ? rawDiskAudit : rawDiskAudit.entries;
      ok('磁盘 audit.json 条目数 > 200（按 5000 条保留，而非 200）',
        Array.isArray(diskEntries) && diskEntries.length > 200, Array.isArray(diskEntries) ? diskEntries.length : 'not array');
    }

    section('注册防刷（同一 IP 10 分钟最多 5 次）');
    let rateHit = null;
    for (let i = 0; i < 4 && !rateHit; i += 1) {
      const attempt = await call(base, 'POST', '/api/register', { json: { username: 'spam' + i + 'x9', password: 'spam123456' } });
      if (attempt.status === 429) rateHit = attempt;
    }
    ok('超出注册频率 → 429 且 message 为「注册过于频繁，请稍后再试」',
      !!rateHit && /注册过于频繁/.test(String(rateHit.data && rateHit.data.error && rateHit.data.error.message)));

    section('X-Forwarded-For 信任策略（P1①）');
    // 默认模式：XFF 完全不被信任，伪造不同 XFF 仍按 TCP 来源 IP 限流
    const xffOffDir = fs.mkdtempSync(path.join(os.tmpdir(), 'certvault-smoke-xff-off-'));
    extraDirs.push(xffOffDir);
    const xffOff = await startExtraServer(xffOffDir);
    const xffOffStatuses = [];
    for (let i = 0; i < 6; i += 1) {
      const spoof = await call(xffOff.base, 'POST', '/api/register', {
        headers: { 'X-Forwarded-For': '198.51.100.' + (i + 1) },
        json: { username: 'xffoff' + i + 'x1', password: 'xff123456' },
      });
      xffOffStatuses.push(spoof.status);
    }
    ok('默认不信任 XFF：换 6 个伪造 XFF 仍按真实来源 IP 计数 → 前 5 次 200、第 6 次 429',
      xffOffStatuses.slice(0, 5).every((s) => s === 200) && xffOffStatuses[5] === 429, xffOffStatuses);
    const xffOffAdmin = await call(xffOff.base, 'POST', '/api/login', { json: { user: ADMIN_USER, password: ADMIN_PASS } });
    const xffOffAudit = await call(xffOff.base, 'GET', '/api/audit?action=user_register&limit=20', { token: xffOffAdmin.data.token });
    const xffOffEntries = (xffOffAudit.data.entries || []).filter((e) => e.action === 'user_register');
    ok('默认模式审计 ip 取自 TCP 来源（127.0.0.1），不是伪造的 198.51.100.x',
      xffOffEntries.length >= 5 && xffOffEntries.every((e) => e.ip === '127.0.0.1'), xffOffEntries.map((e) => e.ip));
    await stopExtraServer(xffOff.proc);

    // 信任模式（CV_TRUST_PROXY=1）：取 XFF 最右一跳，并做 IPv4:port 剥离
    const xffOnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'certvault-smoke-xff-on-'));
    extraDirs.push(xffOnDir);
    const xffOn = await startExtraServer(xffOnDir, { CV_TRUST_PROXY: '1' });
    const xffOnStatuses = [];
    for (let i = 0; i < 6; i += 1) {
      const spoof = await call(xffOn.base, 'POST', '/api/register', {
        headers: { 'X-Forwarded-For': '203.0.113.' + (i + 1) },
        json: { username: 'xffon' + i + 'x1', password: 'xff123456' },
      });
      xffOnStatuses.push(spoof.status);
    }
    ok('CV_TRUST_PROXY=1：6 个不同 XFF 被视为不同客户端，均未被限流（全部 200）',
      xffOnStatuses.every((s) => s === 200), xffOnStatuses);
    const xffSameStatuses = [];
    for (let i = 0; i < 6; i += 1) {
      const spoof = await call(xffOn.base, 'POST', '/api/register', {
        headers: { 'X-Forwarded-For': '10.9.8.7, 203.0.113.99' },
        json: { username: 'xffsame' + i + 'x1', password: 'xff123456' },
      });
      xffSameStatuses.push(spoof.status);
    }
    ok('信任模式同一 XFF 仍受 5 次/10 分钟限制 → 第 6 次 429',
      xffSameStatuses.slice(0, 5).every((s) => s === 200) && xffSameStatuses[5] === 429, xffSameStatuses);
    const xffRightmost = await call(xffOn.base, 'POST', '/api/register', {
      headers: { 'X-Forwarded-For': '203.0.113.99, 203.0.113.50' },
      json: { username: 'xffrightx1', password: 'xff123456' },
    });
    ok('信任模式取最右一跳：最左 IP 已限流、最右为新 IP 时仍放行（200）', xffRightmost.status === 200, xffRightmost.status);
    const xffPortStatuses = [];
    for (let i = 0; i < 6; i += 1) {
      const spoof = await call(xffOn.base, 'POST', '/api/register', {
        headers: { 'X-Forwarded-For': '198.51.100.7:443' },
        json: { username: 'xffport' + i + 'x1', password: 'xff123456' },
      });
      xffPortStatuses.push(spoof.status);
    }
    ok('XFF 带端口（198.51.100.7:443）会被剥离并按同一 IP 计数 → 第 6 次 429',
      xffPortStatuses.slice(0, 5).every((s) => s === 200) && xffPortStatuses[5] === 429, xffPortStatuses);
    await stopExtraServer(xffOn.proc);

    section('静态站点与目录穿越防护');
    const indexHtml = await call(base, 'GET', '/');
    ok('GET / 返回 app/index.html（200 text/html + no-cache）',
      indexHtml.status === 200 && Buffer.isBuffer(indexHtml.data) && indexHtml.data.length > 0 &&
      String(indexHtml.headers.get('content-type')).includes('text/html') &&
      String(indexHtml.headers.get('cache-control')).includes('no-cache'));
    ok('首页 HTML 含 CertVault 字样', indexHtml.data.includes(Buffer.from('CertVault', 'utf8')));
    const appJs = await call(base, 'GET', '/app.js');
    ok('GET /app.js 返回 JS 资源（max-age=0, must-revalidate）',
      appJs.status === 200 && String(appJs.headers.get('content-type')).includes('javascript') &&
      String(appJs.headers.get('cache-control')).includes('must-revalidate'));
    const traversal = await call(base, 'GET', '/%2e%2e/package.json');
    ok('GET /%2e%2e/package.json 目录穿越 → 404', traversal.status === 404);
    const missingStatic = await call(base, 'GET', '/no-such-file.js');
    ok('不存在的静态文件 → 404 纯文本',
      missingStatic.status === 404 && String(missingStatic.headers.get('content-type') || '').includes('text/plain'));
    const unknownApi = await call(base, 'GET', '/api/nope', { token: ADMIN_TOKEN });
    ok('未知 /api 路径 → 404 not_found', isApiError(unknownApi, 404, 'not_found'));

    section('并发写：20 次 PUT 不残留 .tmp，文件始终合法 JSON');
    const writes = [];
    for (let i = 0; i < 20; i += 1) {
      writes.push(call(base, 'PUT', '/api/records', { token: ADMIN_TOKEN, json: { records: [{ id: 'r_1', name: '并发写入 ' + i }] } }));
    }
    const writeResults = await Promise.all(writes);
    ok('20 次并发 PUT /api/records 全部 200', writeResults.every((item) => item.status === 200),
      writeResults.map((item) => item.status));
    const finalRecords = await call(base, 'GET', '/api/records', { token: ADMIN_TOKEN });
    ok('并发后 GET /api/records 仍是合法结构',
      finalRecords.status === 200 && finalRecords.data.version === 1 &&
      Array.isArray(finalRecords.data.records) && finalRecords.data.records.length === 1);
    if (dataDir) {
      const tmpFiles = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.tmp')) tmpFiles.push(full);
        }
      };
      walk(dataDir);
      ok('数据目录没有 .tmp 残留', tmpFiles.length === 0, tmpFiles.join(', '));
      ok('certvault.json 可被 JSON.parse',
        (() => { try { JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'certvault.json'), 'utf8')); return true; } catch (err) { return false; } })());
      ok('config.json 含 secret 与 TTL 配置（会话时长可配置）',
        (() => {
          const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
          return typeof cfg.secret === 'string' && cfg.secret.length >= 32 && cfg.sessionTtlSeconds > 0 && cfg.maxTtlSeconds >= cfg.sessionTtlSeconds &&
            typeof cfg.idleTimeoutSeconds === 'number';
        })());
      ok('users.json 只存 scrypt 哈希（不含明文口令）',
        (() => {
          const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
          return db.users.length >= 2 && db.users.every((u) => String(u.passHash).startsWith('scrypt$') && String(u.salt).length >= 16) &&
            !JSON.stringify(db).includes(ADMIN_PASS);
        })());
      ok('备份目录只保留 10 份（磁盘核对）',
        (() => {
          const names = fs.readdirSync(path.join(dataDir, 'backup'));
          return names.length === 10 && names.every((name) => /^\d{8}-\d{6}-[A-Za-z0-9_-]+\.json$/.test(name));
        })());
    }

    section('退出登录');
    const logout = await call(base, 'POST', '/api/logout', { token: ADMIN_TOKEN });
    ok('POST /api/logout → 200 且清 Cookie（Max-Age=0）',
      logout.status === 200 && /Max-Age=0/.test(String(logout.headers.get('set-cookie') || '')));
    const afterLogout = await call(base, 'GET', '/api/records', { token: ADMIN_TOKEN });
    ok('登出后原 token → 401', isApiError(afterLogout, 401, 'unauthorized'));

    if (dataDir) {
      section('吊销持久化：登出 → 重启 → 旧 token 仍 401（P1②）');
      const revokedFile = path.join(dataDir, 'data', 'revoked.json');
      const revokedDoc = JSON.parse(fs.readFileSync(revokedFile, 'utf8'));
      const revokedList = Array.isArray(revokedDoc.revoked) ? revokedDoc.revoked : [];
      ok('登出后 data/revoked.json 已落盘（每项含 jti + exp）',
        revokedList.length >= 1 && revokedList.every((item) => typeof item.jti === 'string' && item.jti.length > 0 && Number(item.exp) > 0), revokedList);
      await stopExtraServer(child);
      const restarted = await startExtraServer(dataDir);
      child = restarted.proc;
      base = restarted.base;
      const staleAfterRestart = await call(base, 'GET', '/api/records', { token: ADMIN_TOKEN });
      ok('重启进程后，重启前已登出的旧 Bearer 仍然 → 401 unauthorized',
        isApiError(staleAfterRestart, 401, 'unauthorized'), staleAfterRestart.status);
      const relogin = await call(base, 'POST', '/api/login', { json: { user: ADMIN_USER, password: ADMIN_PASS } });
      const reloginRead = await call(base, 'GET', '/api/records', { token: relogin.data.token });
      ok('重启后重新登录的新 token 正常访问 → 200', relogin.status === 200 && reloginRead.status === 200);

      section('吊销表损坏时服务不崩（改名 .bad-<ts>）');
      await stopExtraServer(child);
      fs.writeFileSync(revokedFile, '{ this is not json', 'utf8');
      const recovered = await startExtraServer(dataDir);
      child = recovered.proc;
      base = recovered.base;
      const recoveredHealth = await call(base, 'GET', '/api/health');
      ok('吊销表损坏后服务仍能启动（GET /api/health → 200）', recoveredHealth.status === 200);
      const dataFiles = fs.readdirSync(path.join(dataDir, 'data'));
      const badFiles = dataFiles.filter((name) => /^revoked\.json\.bad-\d+$/.test(name));
      ok('损坏文件被改名为 revoked.json.bad-<ts> 保留现场', badFiles.length >= 1, dataFiles);
      const revokedHealthy = !fs.existsSync(revokedFile) || (() => {
        try {
          const doc = JSON.parse(fs.readFileSync(revokedFile, 'utf8'));
          return Array.isArray(doc.revoked);
        } catch (err) {
          return false;
        }
      })();
      ok('损坏表被忽略：新的 revoked.json 不存在或结构合法（没有把坏数据读进来）', revokedHealthy);
      const recoveryLogin = await call(base, 'POST', '/api/login', { json: { user: ADMIN_USER, password: ADMIN_PASS } });
      const recoveryLogout = await call(base, 'POST', '/api/logout', { token: recoveryLogin.data.token });
      let regenerated = null;
      try { regenerated = JSON.parse(fs.readFileSync(revokedFile, 'utf8')); } catch (err) { regenerated = null; }
      ok('损坏恢复后再次登出能正常重建吊销表（revoked 数组 ≥1）',
        recoveryLogout.status === 200 && !!regenerated && Array.isArray(regenerated.revoked) && regenerated.revoked.length >= 1);
    }

    section('结果');
    const passed = results.length - failures;
    console.log('  通过 ' + passed + ' / ' + results.length + ' 项' + (failures ? '，失败 ' + failures + ' 项' : '，全部通过'));
    if (failures) {
      console.log('  失败项：');
      for (const item of results.filter((r) => !r.pass)) console.log('    - ' + item.name);
      const tail = serverLog.split('\n').slice(-20).join('\n');
      if (tail.trim()) console.log('  服务端日志尾部：\n' + tail);
    }
    return failures === 0 ? 0 : 1;
  } finally {
    if (child) {
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise((resolve) => child.once('exit', () => resolve('exit'))),
        sleep(3000).then(() => 'timeout'),
      ]);
      if (exited === 'timeout') child.kill('SIGKILL');
    }
    for (const dir of extraDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (ignored) { /* 临时目录清理失败不影响结果 */ }
    }
    if (dataDir) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (ignored) { /* 临时目录清理失败不影响结果 */ }
    }
  }
}

let exitCode = 0;
try {
  exitCode = await run();
} catch (err) {
  console.error('\n冒烟测试异常中止：' + (err && err.stack ? err.stack : err));
  exitCode = 1;
}
process.exitCode = exitCode;
