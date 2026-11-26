// CertVault v1 · 前端 HTTP 适配器（服务器 / NAS 模式）
// 契约：docs/接口契约-服务器版.md §6 —— 必须与 app/store.js 的 Store 完全同签名/同返回，
// JS 侧零改动即可把「本地文件夹模式」换成「服务器模式」。
// 依赖：无。以 classic script 方式加载（放在 store.js 之后、app.js 之前），
// 暴露 window.CVStoreHttp = { HttpStore, create, login, logout, probe..., endpoints... }。
// 认证：所有请求优先带 Authorization: Bearer <token>（token 存 localStorage('cv.token')）；
// 服务端同时支持 Cookie，但局域网 IP 与域名是不同 origin、Cookie 不共享，所以 Bearer 才是主力。
// 注意：与 app.js 保持一致，刻意不使用模板字符串。
(function () {
  'use strict';

  const TOKEN_KEY = 'cv.token';
  const ENDPOINTS_KEY = 'cv.endpoints';
  const DEFAULT_TIMEOUT_MS = 15000;
  const PROBE_TIMEOUT_MS = 1200;
  const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
  const IMAGE_CACHE_MAX = 48;

  // 与 app.js / store.js 对齐的默认设置（服务端 settings.json 可能为空对象）
  const DEFAULT_SETTINGS = {
    trayMinimize: true,
    autostart: false,
    popupIntervalHours: 12,
    backupBeforeDanger: true,
    lastPopupAt: null,
    lastOpen: null
  };

  // 契约 §12 的服务端审计动作是固定集合，而 app.js 传的是本地简写（add/edit/delete...）。
  // 双向映射，避免服务端 400「不支持的审计动作」。服务端已自动留痕的动作（改台账、截图、
  // 备份、设置、登录）不再重复上报，否则一次操作会出现两条日志；只有导出/导入这类
  // 服务端看不到的动作才 POST /api/audit。
  const AUDIT_OUT = {
    import: 'record_import',
    export: 'record_export',
    add: 'record_add',
    edit: 'record_edit',
    delete: 'record_delete',
    backup: 'backup_create',
    settings: 'settings_update',
    login: 'login',
    logout: 'logout'
  };
  const AUDIT_AUTO = { add: 1, edit: 1, delete: 1, backup: 1, settings: 1, login: 1, logout: 1 };
  const AUDIT_IN = {
    record_add: 'add',
    record_edit: 'edit',
    record_delete: 'delete',
    record_import: 'import',
    record_export: 'export',
    backup_create: 'backup',
    settings_update: 'settings'
  };

  let onUnauthorized = null;
  let onNetworkFailure = null;

  // ---------- localStorage（file:// 与隐私模式可能抛错，全部兜底） ----------
  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (err) { return null; }
  }

  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (err) { return false; }
  }

  function lsDel(key) {
    try { window.localStorage.removeItem(key); } catch (err) { /* 忽略 */ }
  }

  function readToken() {
    return lsGet(TOKEN_KEY) || '';
  }

  function writeToken(token) {
    if (token) lsSet(TOKEN_KEY, String(token));
    else lsDel(TOKEN_KEY);
  }

  function clearToken() {
    lsDel(TOKEN_KEY);
  }

  // ---------- 地址归一化与地址簿 ----------
  function normalizeBase(input) {
    let value = String(input == null ? '' : input).trim();
    if (!value) return '';
    if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
    value = value.replace(/\/+$/, '');
    return value;
  }

  function readEndpoints() {
    try {
      const raw = lsGet(ENDPOINTS_KEY);
      if (!raw) return [];
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      const out = [];
      list.forEach(function (item) {
        const base = normalizeBase(item);
        if (base && out.indexOf(base) < 0) out.push(base);
      });
      return out;
    } catch (err) {
      return [];
    }
  }

  function writeEndpoints(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach(function (item) {
      const base = normalizeBase(item);
      if (base && out.indexOf(base) < 0) out.push(base);
    });
    lsSet(ENDPOINTS_KEY, JSON.stringify(out));
    return out;
  }

  function addEndpoint(base) {
    const clean = normalizeBase(base);
    if (!clean) return readEndpoints();
    const list = readEndpoints();
    if (list.indexOf(clean) < 0) list.push(clean);
    return writeEndpoints(list);
  }

  function removeEndpoint(base) {
    const clean = normalizeBase(base);
    return writeEndpoints(readEndpoints().filter(function (item) { return item !== clean; }));
  }

  // 时间归一：服务端有 ISO 字符串，也有毫秒时间戳（backups/lock），两种都接受
  function toMs(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') return isFinite(value) ? value : 0;
    const text = String(value).trim();
    const num = Number(text);
    if (text !== '' && isFinite(num)) return num;
    const parsed = Date.parse(text);
    return isNaN(parsed) ? 0 : parsed;
  }

  function hostOf(base) {
    try { return String(new URL(base).hostname || '').toLowerCase(); } catch (err) { return ''; }
  }

  // 契约 §9：私网地址（10/8、172.16/12、192.168/16、127/8、*.local）优先
  function isPrivateHost(base) {
    const host = hostOf(base);
    if (!host) return false;
    if (host === 'localhost' || host === '::1') return true;
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    const m = /^172\.(\d+)\./.exec(host);
    if (m) {
      const second = Number(m[1]);
      if (second >= 16 && second <= 31) return true;
    }
    if (/\.local$/.test(host)) return true;
    return false;
  }

  // ---------- 错误对象 ----------
  function makeError(message, status, code) {
    const err = new Error(message);
    err.name = 'HttpError';
    err.status = status || 0;
    err.code = code || '';
    return err;
  }

  function notifyUnauthorized(err) {
    if (typeof onUnauthorized === 'function') {
      try { onUnauthorized(err); } catch (e) { /* 回调异常不打断请求链 */ }
    }
  }

  function notifyNetworkFailure(err, url) {
    if (typeof onNetworkFailure === 'function') {
      try { onNetworkFailure(err, url); } catch (e) { /* 同上 */ }
    }
  }

  // ---------- fetch 底座：带超时 + 统一错误 ----------
  function fetchWithTimeout(url, init, ms) {
    if (typeof window.fetch !== 'function') {
      return Promise.reject(makeError('当前环境不支持网络请求', 0, 'unsupported'));
    }
    if (typeof window.AbortController !== 'function') {
      return window.fetch(url, init);
    }
    const ctrl = new window.AbortController();
    const timer = window.setTimeout(function () { ctrl.abort(); }, ms);
    const opts = Object.assign({}, init, { signal: ctrl.signal });
    return window.fetch(url, opts).then(function (resp) {
      window.clearTimeout(timer);
      return resp;
    }, function (err) {
      window.clearTimeout(timer);
      if (err && err.name === 'AbortError') err.aborted = true;
      throw err;
    });
  }

  function parseErrorBody(resp) {
    return resp.text().then(function (text) {
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch (err) { data = null; } }
      const info = data && data.error ? data.error : {};
      throw makeError(info.message || ('请求失败（HTTP ' + resp.status + '）'), resp.status, info.code || 'http_error');
    });
  }

  // 统一请求：opt.path / opt.method / opt.headers / opt.body / opt.auth / opt.silent401 /
  //          opt.timeoutMs / opt.responseType('json'|'blob')
  function request(base, options) {
    const opt = options || {};
    const url = normalizeBase(base) + (opt.path || '/');
    const headers = Object.assign({}, opt.headers || {});
    if (!headers['Accept'] && !headers['accept']) {
      headers['Accept'] = opt.responseType === 'blob' ? '*/*' : 'application/json';
    }
    if (opt.auth !== false) {
      const token = readToken();
      if (token) headers['Authorization'] = 'Bearer ' + token;
    }
    const init = {
      method: opt.method || 'GET',
      headers: headers,
      cache: 'no-store',
      credentials: 'same-origin'
    };
    if (opt.body !== undefined && opt.body !== null) init.body = opt.body;
    const timeoutMs = opt.timeoutMs || DEFAULT_TIMEOUT_MS;
    return fetchWithTimeout(url, init, timeoutMs).then(function (resp) {
      if (resp.status === 401) {
        clearToken();
        const err = makeError('登录已过期，请重新登录', 401, 'unauthorized');
        if (opt.silent401 !== true) notifyUnauthorized(err);
        throw err;
      }
      if (opt.responseType === 'blob') {
        if (resp.status === 404) return null;
        if (!resp.ok) return parseErrorBody(resp);
        return resp.blob();
      }
      return resp.text().then(function (text) {
        let data = null;
        if (text) { try { data = JSON.parse(text); } catch (err) { data = null; } }
        if (!resp.ok) {
          const info = data && data.error ? data.error : {};
          throw makeError(info.message || ('请求失败（HTTP ' + resp.status + '）'), resp.status, info.code || 'http_error');
        }
        return data;
      });
    }).catch(function (err) {
      if (err && err.status) throw err;
      const aborted = !!(err && err.aborted);
      const message = aborted
        ? '请求超时（' + Math.round(timeoutMs / 1000) + ' 秒），请检查网络或服务器地址'
        : '连不上服务器：' + (err && err.message ? err.message : '网络错误');
      const wrapped = makeError(message, 0, aborted ? 'timeout' : 'network');
      wrapped.network = true;
      wrapped.base = url;
      notifyNetworkFailure(wrapped, url);
      throw wrapped;
    });
  }

  // ---------- 图片元信息归一（服务端字段可能略有差异） ----------
  function normalizeImageMeta(item) {
    if (!item) return null;
    if (typeof item === 'string') {
      return { file: item, w: 0, h: 0, size: 0, addedAt: new Date().toISOString() };
    }
    const file = item.file || item.name || item.filename || '';
    if (!file) return null;
    return {
      file: String(file),
      w: Number(item.w || item.width || 0) || 0,
      h: Number(item.h || item.height || 0) || 0,
      size: Number(item.size || item.bytes || 0) || 0,
      addedAt: item.addedAt || item.at || new Date().toISOString()
    };
  }

  // ---------- HttpStore：与 app/store.js 的 Store 同签名 ----------
  class HttpStore {
    constructor(base, options) {
      const opt = options || {};
      this.kind = 'http';
      this.base = normalizeBase(base);
      this.needsPermission = false;
      this.handle = { _path: this.base };
      this.lastRecovered = null;
      this.lastPruned = [];
      this._etag = null;
      this._name = opt.name ? String(opt.name) : '';
      this._imageCache = {};
      this._imageKeys = [];
    }

    get folderName() {
      return this._name || this.base;
    }

    _rememberImage(key, blob) {
      if (!blob) return;
      if (!this._imageCache[key]) this._imageKeys.push(key);
      this._imageCache[key] = blob;
      while (this._imageKeys.length > IMAGE_CACHE_MAX) {
        const old = this._imageKeys.shift();
        delete this._imageCache[old];
      }
    }

    _forgetImages(recordId, file) {
      const self = this;
      const prefix = String(recordId) + '/';
      this._imageKeys = this._imageKeys.filter(function (key) {
        const hit = file ? key === prefix + file : key.indexOf(prefix) === 0;
        if (hit) delete self._imageCache[key];
        return !hit;
      });
    }

    // GET /api/records：契约要求原样返回对象，但 app.js 的 loadFsData 需要数组，
    // 所以返回数组本身，并把 version / updatedAt / records 以不可枚举属性挂上，两种用法都兼容。
    async readRecords() {
      const data = await request(this.base, { path: '/api/records' });
      let list = [];
      let version = 1;
      let updatedAt = null;
      if (Array.isArray(data)) {
        list = data;
      } else if (data && Array.isArray(data.records)) {
        list = data.records;
        if (data.version !== undefined && data.version !== null) version = data.version;
        if (data.updatedAt !== undefined) updatedAt = data.updatedAt;
      }
      this._etag = updatedAt;
      const out = list.slice();
      try {
        Object.defineProperty(out, 'version', { value: version, enumerable: false, configurable: true });
        Object.defineProperty(out, 'updatedAt', { value: updatedAt, enumerable: false, configurable: true });
        Object.defineProperty(out, 'records', { value: out, enumerable: false, configurable: true });
      } catch (err) { /* 极老浏览器不支持就算了 */ }
      return out;
    }

    // PUT /api/records：内部维护 _etag，409 时抛契约指定的中文提示
    async writeRecords(records) {
      const list = Array.isArray(records) ? records : [];
      const updatedAt = new Date().toISOString();
      const etag = this._etag === null || this._etag === undefined ? 'null' : String(this._etag);
      let data = null;
      try {
        data = await request(this.base, {
          method: 'PUT',
          path: '/api/records',
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'If-Match': etag },
          body: JSON.stringify({ version: 1, updatedAt: updatedAt, records: list })
        });
      } catch (err) {
        if (err && err.status === 409) throw new Error('有人刚改过，请刷新后重试');
        throw err;
      }
      this._etag = data && data.updatedAt ? data.updatedAt : updatedAt;
      return true;
    }

    async readSettings() {
      const data = await request(this.base, { path: '/api/settings' });
      const base = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      return Object.assign({}, DEFAULT_SETTINGS, base, { version: 1 });
    }

    async writeSettings(settings) {
      await request(this.base, {
        method: 'PUT',
        path: '/api/settings',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(settings || {})
      });
      return true;
    }

    async addImages(recordId, files) {
      const list = Array.prototype.slice.call(files || []);
      const form = new FormData();
      const skipped = [];
      let count = 0;
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        if (!file) continue;
        const type = file.type ? String(file.type) : '';
        if (type && type.indexOf('image/') !== 0) {
          skipped.push({ file: file.name || '', reason: '不是图片文件' });
          continue;
        }
        if (Number(file.size) > IMAGE_MAX_BYTES) {
          skipped.push({ file: file.name || '', reason: '单张超过 8MB' });
          continue;
        }
        form.append('files', file, file.name || 'image.png');
        count += 1;
      }
      const added = [];
      if (count > 0) {
        const data = await request(this.base, {
          method: 'POST',
          path: '/api/images/' + encodeURIComponent(String(recordId)),
          body: form
        });
        let rawAdded = [];
        if (Array.isArray(data)) rawAdded = data;
        else if (data && Array.isArray(data.added)) rawAdded = data.added;
        rawAdded.forEach(function (item) {
          const meta = normalizeImageMeta(item);
          if (meta) added.push(meta);
        });
        const rawSkipped = data && Array.isArray(data.skipped) ? data.skipped : [];
        rawSkipped.forEach(function (item) {
          if (!item) return;
          if (typeof item === 'string') {
            skipped.push({ file: item, reason: '服务器跳过' });
            return;
          }
          skipped.push({
            file: String(item.file || item.name || ''),
            reason: item.reason ? String(item.reason) : '服务器跳过'
          });
        });
        this._forgetImages(recordId);
      }
      const out = added.slice();
      try {
        Object.defineProperty(out, 'added', { value: added, enumerable: false, configurable: true });
        Object.defineProperty(out, 'skipped', { value: skipped, enumerable: false, configurable: true });
      } catch (err) { /* 同上 */ }
      return out;
    }

    async deleteImage(recordId, file) {
      try {
        await request(this.base, {
          method: 'DELETE',
          path: '/api/images/' + encodeURIComponent(String(recordId)) + '/' + encodeURIComponent(String(file))
        });
      } catch (err) {
        if (err && err.status === 404) {
          this._forgetImages(recordId, file);
          return true;
        }
        throw err;
      }
      this._forgetImages(recordId, file);
      return true;
    }

    async deleteRecordImages(recordId) {
      try {
        await request(this.base, { method: 'DELETE', path: '/api/images/' + encodeURIComponent(String(recordId)) });
      } catch (err) {
        if (!err || err.status !== 404) throw err;
      }
      this._forgetImages(recordId);
      return true;
    }

    async imageBlob(recordId, file) {
      const key = String(recordId) + '/' + String(file);
      if (this._imageCache[key]) return this._imageCache[key];
      let blob = null;
      try {
        blob = await request(this.base, {
          path: '/api/images/' + encodeURIComponent(String(recordId)) + '/' + encodeURIComponent(String(file)),
          responseType: 'blob'
        });
      } catch (err) {
        if (err && err.status === 404) return null;
        throw err;
      }
      if (!blob) return null;
      this._rememberImage(key, blob);
      return blob;
    }

    async backup(reason) {
      const data = await request(this.base, {
        method: 'POST',
        path: '/api/backups',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ reason: reason ? String(reason) : 'manual' })
      });
      this.lastPruned = data && Array.isArray(data.pruned) ? data.pruned : [];
      return data && data.file ? String(data.file) : null;
    }

    async backupInfo() {
      const data = await request(this.base, { path: '/api/backups' });
      const files = data && Array.isArray(data.files) ? data.files : [];
      const latest = data && data.latest ? String(data.latest) : '';
      let bytes = 0;
      let latestAt = 0;
      for (let i = 0; i < files.length; i++) {
        const item = files[i] || {};
        bytes += Number(item.bytes) || 0;
        if (item.name && latest && String(item.name) === latest) {
          latestAt = toMs(item.at);
        }
      }
      if (!latestAt && files.length) {
        const tail = files[files.length - 1] || {};
        latestAt = toMs(tail.at);
      }
      return {
        count: Number(data && data.count) || files.length,
        latest: latest || (files.length ? String(files[files.length - 1].name || '') : ''),
        latestAt: latestAt,
        bytes: bytes
      };
    }

    async audit(entry) {
      const item = entry || {};
      const action = item.action ? String(item.action) : 'audit';
      const detail = item.detail === undefined || item.detail === null ? '' : String(item.detail);
      const serverAction = AUDIT_OUT[action] || '';
      // 服务端自行留痕或该动作不在 §12 固定集合（remind / recover / connect）→ 本地返回即可，
      // 不能因为「日志」让业务主流程弹错。
      if (!serverAction || AUDIT_AUTO[action]) {
        return { ts: new Date().toISOString(), action: action, detail: detail };
      }
      try {
        await request(this.base, {
          method: 'POST',
          path: '/api/audit',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ action: serverAction, detail: detail })
        });
      } catch (err) {
        // 普通账号只允许上报导出/导入等少数动作：无权限或参数不被接受时降级为本地留痕。
        if (err && (err.status === 400 || err.status === 403)) {
          return { ts: new Date().toISOString(), action: action, detail: detail };
        }
        throw err;
      }
      return { ts: new Date().toISOString(), action: action, detail: detail };
    }

    async readAudit() {
      const data = await request(this.base, { path: '/api/audit' });
      let list = [];
      if (Array.isArray(data)) list = data;
      else if (data && Array.isArray(data.entries)) list = data.entries;
      return list.map(function (entry) {
        const item = entry || {};
        const at = item.at || item.ts || '';
        const serverAction = item.action ? String(item.action) : '';
        return {
          ts: at,
          action: AUDIT_IN[serverAction] || serverAction,
          serverAction: serverAction,
          detail: item.detail === undefined || item.detail === null ? '' : String(item.detail),
          user: item.username || item.user || '',
          role: item.role || '',
          ip: item.ip || '',
          ok: item.ok
        };
      });
    }

    async lock() {
      if (!this._lockOwner) {
        this._lockOwner = 'cv-web-' + Math.random().toString(36).slice(2, 10);
      }
      await request(this.base, {
        method: 'POST',
        path: '/api/lock',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ owner: this._lockOwner })
      });
      return { id: this._lockOwner, ts: Date.now() };
    }

    async unlock() {
      await request(this.base, { method: 'DELETE', path: '/api/lock' });
      return { id: this._lockOwner || '', ts: Date.now() };
    }

    async lockInfo() {
      const data = await request(this.base, { path: '/api/lock' });
      const locked = !!(data && data.locked);
      const at = data && data.at ? toMs(data.at) : 0;
      return {
        held: locked,
        stale: locked ? !!(data && data.stale) : false,
        ts: at || 0,
        owner: data && data.owner ? String(data.owner) : ''
      };
    }

    // HTTP 模式没有浏览器授权概念
    async grant() {
      return true;
    }
  }

  // ---------- 会话与登录（§10） ----------
  function login(base, body) {
    const payload = body || {};
    const ttl = payload.ttlSeconds === undefined || payload.ttlSeconds === null ? 7 * 24 * 3600 : Number(payload.ttlSeconds) || 0;
    return request(base, {
      method: 'POST',
      path: '/api/login',
      auth: false,
      silent401: true,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        user: payload.user ? String(payload.user) : '',
        password: payload.password ? String(payload.password) : '',
        ttlSeconds: ttl
      })
    }).then(function (data) {
      const token = data && data.token ? String(data.token) : '';
      if (!token) throw makeError('登录失败：服务器没有返回 token', 0, 'bad_response');
      writeToken(token);
      return data;
    });
  }

  function logout(base) {
    return request(base, { method: 'POST', path: '/api/logout' }).catch(function () {
      return null;
    }).then(function () {
      clearToken();
      return true;
    });
  }

  function session(base) {
    return request(base, { path: '/api/session' });
  }

  function extendSession(base, ttlSeconds) {
    const body = ttlSeconds === undefined || ttlSeconds === null ? {} : { ttlSeconds: Number(ttlSeconds) || 0 };
    return request(base, {
      method: 'POST',
      path: '/api/session/extend',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body)
    }).then(function (data) {
      if (data && data.token) writeToken(String(data.token));
      return data;
    });
  }

  function health(base) {
    return request(base, { path: '/api/health', auth: false });
  }

  function configPublic(base, timeoutMs) {
    return request(base, { path: '/api/config/public', auth: false, silent401: true, timeoutMs: timeoutMs || PROBE_TIMEOUT_MS });
  }

  // ---------- 地址探测（§9 的最小实现，t5 会在此基础上扩展） ----------
  function probeBase(base, timeoutMs) {
    const clean = normalizeBase(base);
    const started = Date.now();
    return configPublic(clean, timeoutMs).then(function (config) {
      return { base: clean, ms: Date.now() - started, config: config || null };
    });
  }

  function pickEndpoint(list, timeoutMs) {
    const bases = [];
    (Array.isArray(list) ? list : [list]).forEach(function (item) {
      const base = normalizeBase(item);
      if (base && bases.indexOf(base) < 0) bases.push(base);
    });
    if (!bases.length) return Promise.reject(makeError('没有可用的服务器地址', 0, 'no_endpoint'));
    return Promise.all(bases.map(function (base) {
      return probeBase(base, timeoutMs).then(function (ok) {
        return { base: base, ok: true, ms: ok.ms, config: ok.config, reason: '' };
      }, function (err) {
        return { base: base, ok: false, ms: 0, config: null, reason: err && err.message ? err.message : '连接失败' };
      });
    })).then(function (results) {
      const reachable = results.filter(function (item) { return item.ok; });
      if (!reachable.length) {
        const err = makeError('连不上服务器：' + results.map(function (item) { return item.base + '（' + item.reason + '）'; }).join('；'), 0, 'offline');
        err.results = results;
        throw err;
      }
      reachable.sort(function (a, b) {
        const pa = isPrivateHost(a.base) ? 0 : 1;
        const pb = isPrivateHost(b.base) ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return a.ms - b.ms;
      });
      const best = reachable[0];
      best.results = results;
      return best;
    });
  }

  function create(base, config) {
    return new HttpStore(base, config);
  }

  // ---------- 导出 ----------
  window.CVStoreHttp = {
    version: '1.0.0',
    HttpStore: HttpStore,
    create: create,
    request: request,
    login: login,
    logout: logout,
    session: session,
    extendSession: extendSession,
    health: health,
    configPublic: configPublic,
    probeBase: probeBase,
    pickEndpoint: pickEndpoint,
    isPrivateHost: isPrivateHost,
    normalizeBase: normalizeBase,
    token: readToken,
    setToken: writeToken,
    clearToken: clearToken,
    endpoints: readEndpoints,
    saveEndpoints: writeEndpoints,
    addEndpoint: addEndpoint,
    removeEndpoint: removeEndpoint,
    setUnauthorizedHandler: function (fn) {
      onUnauthorized = typeof fn === 'function' ? fn : null;
    },
    setNetworkFailureHandler: function (fn) {
      onNetworkFailure = typeof fn === 'function' ? fn : null;
    }
  };
})();
