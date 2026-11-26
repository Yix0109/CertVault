// CertVault 服务器版 · 账号管理端 UI（app/admin-ui.js）
// ---------------------------------------------------------------------------
// 职责（契约 docs/接口契约-服务器版.md §10/§11/§12）：
//   1. 注册页：POST /api/register；提交成功后进入「等待管理员审批」，每 5 秒轮询
//      POST /api/register/status；通过 → 回登录页；被拒/停用 → 展示原因。
//   2. 管理员「用户管理」：GET /api/admin/users + approve / reject / role / status /
//      reset-password；至少保留一个可用管理员、不能停用自己，前端提前提示 + 服务端兜底。
//   3. 操作日志：GET /api/audit?limit=&user=&action=&from=&to=；非管理员只能看自己最近
//      50 条（服务端强制，前端只做提示与禁用筛选）。
//   4. 权限态 UI：viewer 只读（写入口变灰并拦截点击 + 提示）、editor 可写、admin 额外可见
//      「用户管理」入口；角色以 GET /api/session 为准。
//
// 约束：
//   - 不改 app.js / store.js / store-http.js / server-endpoints.js；所有请求经
//     window.CVStoreHttp.request（或 window.CVHttpStore / window.CVApi，若已提供），
//     不自己拼 fetch 认证逻辑；Bearer token 由 store-http.js 统一附加。
//   - 只暴露一个全局：window.CVAdminUI。
//   - index.html 末尾只需 <div id="cvAdminRoot"></div> 与 <script src="./admin-ui.js"></script>；
//     本文件自己注入 <style id="cvaStyles">，不改 app/style.css，避免与其它任务冲突。
//   - 与 app.js 一致：不使用模板字符串，字符串统一用 + 拼接。
//
// 供 client-dev / 集成方调用的接口：
//   window.CVAdminUI.setSession({ base, user, role, expiresAt, ttlSeconds })  // 登录成功后调用
//   window.CVAdminUI.clearSession()          // 退出登录 / 收到 401 后调用
//   window.CVAdminUI.refreshSession()        // 用 localStorage('cv.token') 调 GET /api/session
//   window.CVAdminUI.setBase('http://nas:8090')
//   window.CVAdminUI.openUsers() / openAudit() / openRegister() / closeAll()
//   事件：window 上派发 'cv:need-login'（detail.reason）、'cv:role'（detail.role/user）、
//         'cv:admin-open'、'cv:admin-close'、'cv:admin-ui-ready'。
//   若 #loginScreen 存在，本文件自动注入「还没有账号？申请注册」入口（不改 app.js）。
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var TOKEN_KEY = 'cv.token';
  var BASE_KEY = 'cv.adminBase';
  var REGISTER_POLL_MS = 5000;
  var REGISTER_WAIT_MAX_MS = 60 * 60 * 1000;
  var USERS_AUTO_MS = 15000;
  var MAX_AUDIT_LIMIT = 5000;

  var ROLE_TEXT = { viewer: '只读', editor: '编辑', admin: '管理员' };
  var ROLE_DESC = {
    viewer: '只能查看、复制与导出，不能新增或修改',
    editor: '可以新增、编辑、删除、导入导出，不能管理账号',
    admin: '全部权限：含账号审批与管理、查看全员操作日志'
  };
  var ROLE_ORDER = ['viewer', 'editor', 'admin'];

  var STATUS_TEXT = { pending: '待审批', active: '正常', rejected: '已拒绝', disabled: '已停用' };
  var STATUS_TONE = { pending: 'warn', active: 'ok', rejected: 'bad', disabled: 'off' };
  var STATUS_ORDER = { pending: 0, active: 1, disabled: 2, rejected: 3 };

  var ACTION_META = {
    login: ['登录', 'ok'],
    login_failed: ['登录失败', 'bad'],
    logout: ['退出登录', ''],
    record_add: ['新增记录', ''],
    record_edit: ['编辑记录', ''],
    record_delete: ['删除记录', 'bad'],
    record_import: ['导入台账', ''],
    record_export: ['导出台账', ''],
    image_add: ['上传截图', ''],
    image_delete: ['删除截图', 'bad'],
    settings_update: ['修改设置', ''],
    backup_create: ['创建备份', ''],
    user_register: ['注册申请', 'gold'],
    user_approve: ['通过审批', 'ok'],
    user_reject: ['拒绝申请', 'bad'],
    user_role: ['调整角色', 'gold'],
    user_status: ['启停账号', 'gold'],
    user_reset_password: ['重置密码', 'gold'],
    password_change: ['修改密码', 'gold']
  };
  var ACTION_ORDER = ['login', 'login_failed', 'logout', 'record_add', 'record_edit', 'record_delete',
    'record_import', 'record_export', 'image_add', 'image_delete', 'settings_update', 'backup_create',
    'user_register', 'user_approve', 'user_reject', 'user_role', 'user_status',
    'user_reset_password', 'password_change'];

  // viewer 在服务器模式下不能触发的写入口（只拦截点击，不改 app.js 的 disabled 状态）
  var WRITE_GUARD = [
    '#btnAdd', '#btnEdit', '#btnDelete', '#btnCancelRemind', '#btnRestoreRemind',
    '#btnImport', '#btnSave', '#btnSaveNext', '#btnBackupNow', '#btnCheckData',
    '#stTray', '#stAutostart', '#stInterval', '.sw[data-setting]',
    '#ctxMenu button[data-act="edit"]', '#ctxMenu button[data-act="delete"]'
  ];
  var WRITE_GUARD_SELECTOR = WRITE_GUARD.join(',');

  var sessionState = {
    user: null, role: '', base: '', expiresAt: null, ttlSeconds: null,
    idleTimeoutSeconds: 0, serverTime: '', loaded: false, error: ''
  };
  var booted = false;

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }

  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return ESC_MAP[ch]; });
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function parseTime(value) {
    if (!value) return null;
    var ms = Date.parse(String(value));
    return isFinite(ms) ? ms : null;
  }

  function fmtDateTime(value) {
    var ms = parseTime(value);
    if (ms == null) return value ? String(value) : '—';
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtShort(value) {
    var ms = parseTime(value);
    if (ms == null) return '—';
    var d = new Date(ms);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtRelative(value) {
    var ms = parseTime(value);
    if (ms == null) return '—';
    var diff = Date.now() - ms;
    if (diff < 0) return fmtShort(value);
    var min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    var hour = Math.floor(min / 60);
    if (hour < 24) return hour + ' 小时前';
    var day = Math.floor(hour / 24);
    if (day < 30) return day + ' 天前';
    return fmtShort(value);
  }

  function fmtExpire(value) {
    var ms = parseTime(value);
    if (ms == null) return '会话有效期未知';
    var diff = ms - Date.now();
    if (diff <= 0) return '会话已过期';
    var day = Math.floor(diff / 86400000);
    var hour = Math.floor((diff % 86400000) / 3600000);
    if (day > 0) return '会话剩余 ' + day + ' 天' + (hour ? ' ' + hour + ' 小时' : '');
    var min = Math.max(1, Math.floor(diff / 60000));
    return min >= 60 ? '会话剩余 ' + Math.floor(min / 60) + ' 小时' : '会话剩余 ' + min + ' 分钟';
  }

  function clockText(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
  }

  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (err) { return null; }
  }
  function lsSet(key, value) {
    try { window.localStorage.setItem(key, String(value)); return true; } catch (err) { return false; }
  }
  function lsDel(key) {
    try { window.localStorage.removeItem(key); } catch (err) { /* 忽略 */ }
  }

  function emit(name, detail) {
    try {
      var ev = new window.CustomEvent(name, { detail: detail || null, bubbles: false });
      window.dispatchEvent(ev);
    } catch (err) { /* 旧环境不支持 CustomEvent 时忽略 */ }
  }

  function debounce(fn, ms) {
    var timer = 0;
    return function () {
      var args = arguments;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  function deviceGuess() {
    var ua = String(navigator.userAgent || '');
    var platform = '浏览器';
    if (/Windows/i.test(ua)) platform = 'Windows';
    else if (/Macintosh|Mac OS X/i.test(ua)) platform = 'macOS';
    else if (/Android/i.test(ua)) platform = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) platform = 'iOS';
    else if (/Linux/i.test(ua)) platform = 'Linux';
    var browser = '浏览器';
    if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) browser = 'Chrome';
    else if (/Firefox\//.test(ua)) browser = 'Firefox';
    else if (/Safari\//.test(ua)) browser = 'Safari';
    return platform + ' · ' + browser;
  }

  function errMessage(err) {
    if (!err) return '操作失败，请重试';
    if (err.status === 401) return '登录已过期，请重新登录';
    if (err.status === 403) return err.message || '当前账号没有该操作权限';
    if (err.status === 404) return err.message || '账号或接口不存在';
    if (err.status === 409) return err.message || '与服务器当前状态冲突，请刷新后重试';
    if (err.status === 413) return '提交内容过大，请减少数量后重试';
    if (err.status === 429) return err.message || '操作过于频繁，请稍后再试';
    return err.message || '操作失败，请重试';
  }

  // -------------------------------------------------------------------------
  // toast（自带节点，避免和 app.js 的 #toast 抢定时器）
  // -------------------------------------------------------------------------
  var toastNode = null;
  var toastTimer = 0;
  function toast(text, tone) {
    if (!toastNode || !toastNode.parentNode) {
      toastNode = el('div', 'cva-toast');
      toastNode.setAttribute('role', 'status');
      toastNode.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastNode);
    }
    toastNode.textContent = String(text == null ? '' : text);
    toastNode.className = 'cva-toast open' + (tone ? ' ' + tone : '');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      if (toastNode) toastNode.className = 'cva-toast';
    }, 3200);
  }

  // -------------------------------------------------------------------------
  // 样式：全部由本文件注入 <style id="cvaStyles">，不修改 app/style.css
  // -------------------------------------------------------------------------
  var CSS_TEXT = [
    '/* CertVault 账号管理端（app/admin-ui.js 注入；与 app/style.css 的深墨蓝 + 香槟金令牌一致） */',
    '.cva-nav{display:flex;align-items:center;gap:6px;flex:none}',
    '.cva-nav-wrap{position:relative;display:inline-flex}',
    '.cva-pill{display:inline-flex;align-items:center;gap:6px;height:27px;padding:0 10px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.03);color:var(--text-2);font-size:11.5px;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis}',
    '.cva-pill b{font-weight:600;color:var(--text);max-width:120px;overflow:hidden;text-overflow:ellipsis}',
    '.cva-pill.role-viewer{border-color:rgba(224,178,60,.34);background:rgba(224,178,60,.10);color:#EFC863}',
    '.cva-pill.role-editor{border-color:rgba(61,123,255,.32);background:rgba(61,123,255,.10);color:#8FB2FF}',
    '.cva-pill.role-admin{border-color:rgba(201,164,92,.42);background:rgba(201,164,92,.12);color:#E4C88B}',
    '.cva-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}',
    '.cva-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:96;min-width:200px;padding:5px;background:#182433;border:1px solid #2C3B4E;border-radius:10px;box-shadow:0 18px 40px rgba(0,0,0,.55);display:none}',
    '.cva-menu.open{display:block}',
    '.cva-menu button{display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:0;border-radius:6px;background:none;color:#D6DFEA;font-size:12.5px;text-align:left;cursor:pointer;font-family:inherit}',
    '.cva-menu button:hover{background:#22304A}',
    '.cva-menu button:disabled{opacity:.45;cursor:not-allowed}',
    '.cva-menu .cva-mdiv{height:1px;background:var(--line);margin:4px 5px}',
    '.cva-menu small{margin-left:auto;color:#5E6B7C;font-size:10.5px}',
    '.cva-overlay{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(6,10,16,.62);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}',
    '.cva-overlay[hidden]{display:none!important}',
    '.cva-console{width:min(1120px,96vw);height:min(780px,90vh);display:flex;flex-direction:column;background:#111B27;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}',
    '.cva-console-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 18px 11px;border-bottom:1px solid var(--line-soft);flex:none}',
    '.cva-console-title{min-width:0}',
    '.cva-console-title h2{margin:0;font-size:16.5px;font-weight:700;line-height:1.3}',
    '.cva-console-title p{margin:2px 0 0;font-size:11.5px;color:var(--text-3)}',
    '.cva-tabs{display:flex;gap:6px;flex-wrap:wrap}',
    '.cva-tabs button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:999px;border:1px solid var(--line);background:transparent;color:#9AA9BC;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}',
    '.cva-tabs button:hover{color:#E8EDF4;border-color:#33445A}',
    '.cva-tabs button.on{background:var(--gold-soft);border-color:var(--gold-line);color:#E4C88B}',
    '.cva-tabs button i{font-style:normal;font-size:10.5px;color:#6B7A8C}',
    '.cva-tabs button.on i{color:var(--gold)}',
    '.cva-x{margin-left:auto;width:30px;height:30px;display:grid;place-items:center;padding:0;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text-2);font-size:14px;cursor:pointer;flex:none}',
    '.cva-x:hover{color:#fff;border-color:#33445a;background:var(--panel-2)}',
    '.cva-pane{flex:1;min-height:0;display:flex;flex-direction:column}',
    '.cva-pane[hidden]{display:none!important}',
    '.cva-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--line-soft);flex:none}',
    '.cva-input{height:30px;min-width:130px;max-width:240px;background:#131D29;border:1px solid var(--line);border-radius:7px;color:var(--text);padding:0 9px;font-size:12px;font-family:inherit;outline:0;transition:.16s}',
    '.cva-input:focus{border-color:rgba(201,164,92,.55);box-shadow:0 0 0 3px rgba(201,164,92,.08)}',
    '.cva-input::placeholder{color:#4E5F73}',
    '.cva-input[disabled]{opacity:.5;cursor:not-allowed}',
    'select.cva-input{padding:0 6px;min-width:110px}',
    'input[type=date].cva-input{padding:0 6px;min-width:124px}',
    '.cva-grow{flex:1}',
    '.cva-check{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text-2);white-space:nowrap;cursor:pointer;user-select:none}',
    '.cva-check input{accent-color:#C9A45C;width:13px;height:13px;cursor:pointer}',
    '.cva-note{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--line-soft);font-size:11.5px;color:var(--text-3);line-height:1.5}',
    '.cva-note b{color:#C9D4E2;font-weight:600}',
    '.cva-note .cva-warn{color:#EFC863}',
    '.cva-tablewrap{flex:1;min-height:0;overflow:auto}',
    '.cva-table{width:100%;border-collapse:separate;border-spacing:0;min-width:980px}',
    '.cva-table thead th{position:sticky;top:0;z-index:2;background:#141E2B;color:#7E8EA2;font-size:11.5px;font-weight:600;letter-spacing:.4px;text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}',
    '.cva-table tbody td{padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.045);font-size:12.5px;color:#C9D4E2;vertical-align:middle}',
    '.cva-table tbody tr:hover{background:#1A2534}',
    '.cva-table tbody tr.cva-pending{background:rgba(224,178,60,.05)}',
    '.cva-table tbody tr.cva-pending td:first-child{box-shadow:inset 2px 0 0 var(--amber)}',
    '.cva-table tbody tr.cva-self td:first-child{box-shadow:inset 2px 0 0 var(--blue)}',
    '.cva-uname{color:#E8EDF4;font-weight:600;font-size:13px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}',
    '.cva-umeta{color:#5E6B7C;font-size:11px;line-height:1.35;font-family:Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}',
    '.cva-badge{display:inline-flex;align-items:center;gap:5px;height:21px;padding:0 7px;border-radius:6px;font-size:11.5px;font-weight:600;white-space:nowrap;line-height:1}',
    '.cva-badge.ok{background:rgba(47,179,122,.11);color:#5FCF9F;border:1px solid rgba(47,179,122,.24)}',
    '.cva-badge.warn{background:rgba(224,178,60,.13);color:#EFC863;border:1px solid rgba(224,178,60,.28)}',
    '.cva-badge.bad{background:rgba(229,72,77,.14);color:#FF8A8D;border:1px solid rgba(229,72,77,.3)}',
    '.cva-badge.off{background:rgba(107,122,140,.14);color:#93A3B6;border:1px solid rgba(107,122,140,.3)}',
    '.cva-badge.gold{background:var(--gold-soft);color:#E4C88B;border:1px solid var(--gold-line)}',
    '.cva-code{font-family:Consolas,monospace;font-size:10.5px;color:#5E6B7C;margin-left:5px}',
    '.cva-ops{display:flex;align-items:center;gap:4px;flex-wrap:wrap;white-space:nowrap}',
    '.mini.cva-primary{color:#E4C88B;border-color:var(--gold-line);background:var(--gold-soft)}',
    '.mini.cva-primary:hover{background:rgba(201,164,92,.22);border-color:var(--gold);color:#F2DCA8}',
    '.mini.cva-danger{color:#F08A8D;border-color:rgba(229,72,77,.32);background:rgba(229,72,77,.07)}',
    '.mini.cva-danger:hover{background:rgba(229,72,77,.16);color:#FFA8AA}',
    '.mini.cva-ghost{background:transparent}',
    '.cva-sel{height:24px;background:#131D29;color:#D6DFEA;border:1px solid var(--line);border-radius:6px;padding:0 4px;font-size:11.5px;font-family:inherit;outline:0;cursor:pointer}',
    '.cva-sel:disabled{opacity:.5;cursor:not-allowed}',
    '.cva-empty{padding:52px 14px;text-align:center;color:#6E7E91;font-size:13px;line-height:1.7}',
    '.cva-empty b{display:block;color:#A9B8C9;font-size:13.5px;margin-bottom:3px}',
    '.cva-loading{display:flex;align-items:center;justify-content:center;gap:9px;padding:38px 14px;color:#8FA0B4;font-size:12.5px}',
    '.cva-spin{width:14px;height:14px;border:2px solid rgba(201,164,92,.25);border-top-color:var(--gold);border-radius:50%;display:inline-block;animation:cvaSpin .8s linear infinite}',
    '@keyframes cvaSpin{to{transform:rotate(360deg)}}',
    '.cva-toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,14px);z-index:120;max-width:72vw;padding:9px 16px;border-radius:9px;background:#1E2C3E;border:1px solid #33455C;color:#E8EDF4;font-size:12.5px;box-shadow:0 12px 30px rgba(0,0,0,.45);opacity:0;visibility:hidden;pointer-events:none;transition:.2s}',
    '.cva-toast.open{opacity:1;visibility:visible;transform:translate(-50%,0)}',
    '.cva-toast.ok{border-color:rgba(47,179,122,.5);color:#5FCF9F}',
    '.cva-toast.warn{border-color:rgba(224,178,60,.5);color:#EFC863}',
    '.cva-toast.bad{border-color:rgba(229,72,77,.5);color:#FF9A9E}',
    '.cva-dialog-overlay{z-index:100}',
    '.cva-dialog{width:min(470px,94vw);max-height:90vh;overflow:auto;display:flex;flex-direction:column;background:#111B27;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}',
    '.cva-dialog-head{padding:16px 18px 6px;flex:none}',
    '.cva-dialog-head h3{margin:0;font-size:15.5px;font-weight:700;line-height:1.35}',
    '.cva-dialog-head p{margin:7px 0 0;font-size:12px;color:var(--text-2);line-height:1.65;white-space:pre-wrap}',
    '.cva-dialog-body{display:flex;flex-direction:column;gap:10px;padding:10px 18px 4px}',
    '.cva-dialog-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 18px 16px;flex:none}',
    '.cva-fielderr{font-size:11.5px;color:#FF9A9E;min-height:0}',
    '.cva-reg{width:min(452px,94vw);max-height:92vh;overflow:auto;display:flex;flex-direction:column;background:#111B27;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}',
    '.cva-reg-head{display:flex;align-items:flex-start;gap:10px;padding:16px 18px 10px;border-bottom:1px solid var(--line-soft);flex:none}',
    '.cva-reg-head h2{margin:0;font-size:16px;font-weight:700;flex:1;line-height:1.35}',
    '.cva-reg-head p{margin:3px 0 0;font-size:11.5px;color:var(--text-3)}',
    '.cva-reg-body{display:flex;flex-direction:column;gap:11px;padding:14px 18px 8px}',
    '.cva-reg-foot{display:flex;align-items:center;gap:8px;padding:12px 18px 16px;border-top:1px solid var(--line-soft);flex:none}',
    '.cva-reg-foot .cva-grow{flex:1}',
    '.cva-serverchip{display:flex;align-items:center;gap:7px;height:32px;padding:0 10px;border-radius:7px;border:1px solid var(--line);background:#101A25;color:#8FB2FF;font-family:Consolas,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cva-serverchip button{margin-left:auto;flex:none;height:22px;padding:0 7px;border-radius:5px;border:1px solid var(--line);background:#182433;color:#A9B8C9;font-size:11px;cursor:pointer;font-family:inherit}',
    '.cva-wait{display:flex;flex-direction:column;align-items:center;text-align:center;gap:9px;padding:14px 4px 6px}',
    '.cva-state-ico{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;font-size:20px;font-weight:700;flex:none}',
    '.cva-state-ico.wait{background:rgba(201,164,92,.12);border:1px solid var(--gold-line);color:var(--gold)}',
    '.cva-state-ico.ok{background:rgba(47,179,122,.12);border:1px solid rgba(47,179,122,.4);color:#5FCF9F}',
    '.cva-state-ico.bad{background:rgba(229,72,77,.12);border:1px solid rgba(229,72,77,.4);color:#FF8A8D}',
    '.cva-wait h3{margin:2px 0 0;font-size:15px;font-weight:700}',
    '.cva-wait p{margin:0;font-size:12px;color:var(--text-2);line-height:1.7;max-width:330px}',
    '.cva-wait .cva-timer{font-family:Consolas,monospace;font-size:12.5px;color:#8FA0B4;letter-spacing:.4px}',
    '.cva-wait-acts{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px}',
    '.cva-wait-acts .btn{height:30px;font-size:12px}',
    '.cva-login-reg{margin-top:4px;text-align:center}',
    '.cva-linkbtn{background:none;border:0;color:#8FB2FF;font-size:12px;cursor:pointer;padding:4px 2px;font-family:inherit}',
    '.cva-linkbtn:hover{text-decoration:underline}',
    '.cva-locked{opacity:.42!important;cursor:not-allowed!important}',
    '.cva-locked:hover{filter:none!important}',
    '.cva-kv{display:grid;grid-template-columns:96px 1fr;gap:8px 12px;font-size:12.5px}',
    '.cva-kv .k{color:#6B7A8C}',
    '.cva-kv .v{color:#D6DFEA;word-break:break-all}',
    '@media (max-width:980px){',
      '.cva-overlay{padding:0}',
      '.cva-console{width:100vw;height:100vh;max-height:none;border-radius:0;border:0}',
      '.cva-toolbar .cva-input{flex:1 1 140px;max-width:none}',
      '.cva-console-head{padding:11px 12px 9px}',
      '.cva-note{padding:7px 12px}',
      '.cva-dialog{max-height:94vh}',
    '}'
  ].join('\n');

  function injectStyles() {
    var host = document.head || document.documentElement;
    var pairs = [['cvaStyles', CSS_TEXT], ['cvaStyles2', EXTRA_CSS]];
    for (var i = 0; i < pairs.length; i++) {
      if (document.getElementById(pairs[i][0])) continue;
      var node = document.createElement('style');
      node.id = pairs[i][0];
      node.textContent = pairs[i][1];
      host.appendChild(node);
    }
  }

  var EXTRA_CSS = [
    '/* cva-table / log / form / badge */',
    '.cva-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px}',
    '.cva-table th{position:sticky;top:0;z-index:1;background:#182430;color:#93A2B4;font-weight:600;text-align:left;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.09);white-space:nowrap}',
    '.cva-table td{padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.055);color:#DCE4EE;vertical-align:middle}',
    '.cva-table tbody tr:hover{background:rgba(61,123,255,.06)}',
    '.cva-table .num{text-align:right;font-variant-numeric:tabular-nums}',
    '.cva-user{display:flex;align-items:center;gap:8px;min-width:132px}',
    '.cva-avatar{width:26px;height:26px;border-radius:50%;background:rgba(61,123,255,.16);color:#8FB4FF;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex:0 0 auto}',
    '.cva-badge{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid transparent;white-space:nowrap}',
    '.cva-badge.active{background:rgba(47,179,122,.14);color:#5ED3A0;border-color:rgba(47,179,122,.35)}',
    '.cva-badge.pending{background:rgba(224,178,60,.14);color:#EBC55E;border-color:rgba(224,178,60,.35)}',
    '.cva-badge.rejected{background:rgba(229,72,77,.13);color:#F08387;border-color:rgba(229,72,77,.32)}',
    '.cva-badge.disabled{background:rgba(255,255,255,.07);color:#93A2B4;border-color:rgba(255,255,255,.14)}',
    '.cva-badge.admin{background:rgba(201,164,92,.16);color:#DCBE80;border-color:rgba(201,164,92,.4)}',
    '.cva-badge.editor{background:rgba(61,123,255,.15);color:#8FB4FF;border-color:rgba(61,123,255,.35)}',
    '.cva-badge.viewer{background:rgba(255,255,255,.07);color:#A8B6C6;border-color:rgba(255,255,255,.12)}',
    '.cva-row-actions{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}',
    '.cva-act{height:26px;padding:0 9px;border-radius:7px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#C7D3E1;font-size:11.5px;cursor:pointer;white-space:nowrap;font-family:inherit}',
    '.cva-act:hover{background:rgba(255,255,255,.1);color:#EEF3F9}',
    '.cva-act.good{color:#5ED3A0;border-color:rgba(47,179,122,.3)}',
    '.cva-act.bad{color:#F08387;border-color:rgba(229,72,77,.3)}',
    '.cva-act:disabled{opacity:.4;cursor:not-allowed}',
    '.cva-empty{padding:26px 12px;text-align:center;color:#6B7A8C;font-size:12.5px;line-height:1.7}',
    '.cva-loglist{overflow:auto;flex:1 1 auto}',
    '.cva-logitem{display:grid;grid-template-columns:138px 1fr;gap:4px 12px;padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.05)}',
    '.cva-logitem:hover{background:rgba(255,255,255,.025)}',
    '.cva-time{color:#7D8B9C;font-size:11.5px;font-variant-numeric:tabular-nums}',
    '.cva-logmain{display:flex;flex-wrap:wrap;align-items:center;gap:7px;font-size:12.5px;color:#DCE4EE;min-width:0}',
    '.cva-actor{color:#9BB0C7}',
    '.cva-action{font-weight:600}',
    '.cva-action.fail{color:#F08387}',
    '.cva-logmeta{grid-column:2;color:#7D8B9C;font-size:11.5px;display:flex;flex-wrap:wrap;gap:10px}',
    '.cva-tag{padding:1px 6px;border-radius:5px;background:rgba(255,255,255,.06);color:#A8B6C6;font-size:11px}',
    '.cva-filterbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.07)}',
    '.cva-pager{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;border-top:1px solid rgba(255,255,255,.07);font-size:12px;color:#93A2B4}',
    '.cva-form{display:grid;grid-template-columns:1fr 1fr;gap:10px 12px}',
    '.cva-form .full{grid-column:1/-1}',
    '.cva-label{display:block;font-size:11.5px;color:#93A2B4;margin:0 0 5px}',
    '.cva-note-inline{font-size:11.5px;color:#7D8B9C;line-height:1.6}',
    '.cva-spinner{width:15px;height:15px;border-radius:50%;border:2px solid rgba(255,255,255,.14);border-top-color:#8FB4FF;animation:cvaSpin .8s linear infinite;display:inline-block;vertical-align:-3px}',
    '@keyframes cvaSpin{to{transform:rotate(360deg)}}',
    '.cva-dot{width:7px;height:7px;border-radius:50%;background:#6B7A8C;display:inline-block}',
    '.cva-dot.ok{background:#2FB37A;box-shadow:0 0 0 3px rgba(47,179,122,.16)}',
    '.cva-dot.bad{background:#E5484D;box-shadow:0 0 0 3px rgba(229,72,77,.16)}',
    '.cva-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#A8B6C6;word-break:break-all}',
    '.cva-h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#7D8B9C;margin:14px 12px 6px}',
    '.cva-actions-col{min-width:210px}',
  ].join('\n');

  // -------------------------------------------------------------------------
  // UI 状态（会话态用上面的 sessionState，这里只放页面数据）
  // -------------------------------------------------------------------------
  var state = {
    ready: false,
    view: 'users',
    users: [],
    usersAt: 0,
    usersTimer: 0,
    usersBusy: false,
    logs: [],
    logsTotal: 0,
    logsBusy: false,
    logsAt: 0,
    logFilter: { user: '', action: '', from: '', to: '', limit: 200 },
    logPage: 1,
    logPageSize: 50,
    pendingCount: 0,
    consoleOpen: false,
    register: { timer: 0, username: '', device: '', stage: 'form', message: '', reason: '', startedAt: 0 }
  };

  // 追加样式：本段之后新增的组件用 addStyle()，不动上面的 CSS_TEXT / EXTRA_CSS
  var LATE_CSS = [];
  function addStyle(id, css) {
    LATE_CSS.push([id, css]);
  }
  function flushStyles() {
    if (!document.getElementById('cvaStyles')) injectStyles();
    var host = document.head || document.documentElement;
    for (var i = 0; i < LATE_CSS.length; i++) {
      var pair = LATE_CSS[i];
      if (document.getElementById(pair[0])) continue;
      var node = document.createElement('style');
      node.id = pair[0];
      node.textContent = pair[1];
      host.appendChild(node);
    }
  }

  // -------------------------------------------------------------------------
  // 数据桥：所有请求只经 window.CVStoreHttp（事实标准）/ CVHttpStore / CVApi；
  // Bearer token、401 清理、中文错误提示都由适配器负责，本文件不自己拼 fetch。
  // -------------------------------------------------------------------------
  function getAdapter() {
    var list = [window.CVStoreHttp, window.CVHttpStore, window.CVApi];
    for (var i = 0; i < list.length; i++) {
      var candidate = list[i];
      if (candidate && typeof candidate.request === 'function') return candidate;
    }
    return null;
  }

  function adapterMissing() {
    var err = new Error('服务器适配器未加载：请确认 app/store-http.js 已加载');
    err.code = 'adapter_missing';
    return err;
  }

  function normalizeBase(base) {
    var adapter = getAdapter();
    if (adapter && typeof adapter.normalizeBase === 'function') {
      try {
        var clean = adapter.normalizeBase(base);
        if (clean) return clean;
      } catch (err) { /* 落到下面的兜底 */ }
    }
    var text = String(base == null ? '' : base).trim();
    if (!text) return '';
    if (!/^https?:\/\//i.test(text)) text = 'http://' + text;
    return text.replace(/\/+$/, '');
  }

  function endpointBase(item) {
    if (!item) return '';
    if (typeof item === 'string') return item;
    return item.base || item.url || item.endpoint || '';
  }

  function storedEndpoints() {
    var adapter = getAdapter();
    if (adapter && typeof adapter.endpoints === 'function') {
      try {
        var list = adapter.endpoints();
        if (Array.isArray(list)) return list;
      } catch (err) { /* 忽略 */ }
    }
    var raw = lsGet('cv.endpoints');
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.list)) return parsed.list;
      if (parsed && Array.isArray(parsed.items)) return parsed.items;
    } catch (err) { /* 忽略 */ }
    return [];
  }

  // app.js 没有把 serverBase 暴露出来：这里按「显式设定 → 地址簿 → 同源」解析
  function baseCandidates() {
    var out = [];
    var add = function (value) {
      var clean = normalizeBase(endpointBase(value));
      if (clean && out.indexOf(clean) < 0) out.push(clean);
    };
    add(sessionState.base);
    add(lsGet(BASE_KEY));
    add(lsGet('cv.lastBase'));
    add(window.__CV_SERVER_BASE || '');
    var book = storedEndpoints();
    for (var i = 0; i < book.length; i++) add(book[i]);
    var protocol = String(window.location.protocol || '');
    if (protocol === 'http:' || protocol === 'https:') add(window.location.origin);
    return out;
  }

  function setBase(base) {
    var clean = normalizeBase(base);
    if (!clean) return '';
    sessionState.base = clean;
    lsSet(BASE_KEY, clean);
    return clean;
  }

  function resolveBase() {
    if (sessionState.base) return Promise.resolve(sessionState.base);
    var adapter = getAdapter();
    var candidates = baseCandidates();
    if (!candidates.length) {
      return Promise.reject(new Error('还没有可用的服务器地址：请先在登录框填写 NAS 地址'));
    }
    if (adapter && typeof adapter.pickEndpoint === 'function') {
      return Promise.resolve(adapter.pickEndpoint(candidates)).then(function (picked) {
        var base = setBase(endpointBase(picked));
        if (!base) throw new Error('探测不到可用的服务器地址');
        return base;
      }, function (err) {
        throw err && err.message ? err : new Error('连不上服务器，请确认 NAS 地址与端口');
      });
    }
    return Promise.resolve(setBase(candidates[0]));
  }

  function apiRequest(path, options) {
    var adapter = getAdapter();
    if (!adapter) return Promise.reject(adapterMissing());
    var opts = options || {};
    if (!opts.base && !sessionState.base) {
      return resolveBase().then(function () { return apiRequest(path, options); });
    }
    var base = opts.base || sessionState.base;
    var payload = {
      path: path,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      auth: opts.auth !== false,
      silent401: opts.silent401 === true
    };
    if (opts.body !== undefined) {
      // CVStoreHttp.request 直把 body 交给 fetch：对象/数组需先序列化并补 Content-Type
      var body = opts.body;
      if (body && typeof body === 'object' && typeof FormData !== 'undefined' && body instanceof FormData) {
        payload.body = body;
      } else if (body && typeof body === 'object' && typeof Blob !== 'undefined' && body instanceof Blob) {
        payload.body = body;
      } else if (body && typeof body === 'object') {
        payload.body = JSON.stringify(body);
        if (!payload.headers['Content-Type'] && !payload.headers['content-type']) {
          payload.headers['Content-Type'] = 'application/json';
        }
      } else {
        payload.body = body;
      }
    }
    if (opts.timeoutMs) payload.timeoutMs = opts.timeoutMs;
    if (opts.responseType) payload.responseType = opts.responseType;
    try {
      return Promise.resolve(adapter.request(base, payload));
    } catch (err) {
      // 兼容另一种签名 request(path, { base, ... })
      var alt = { base: base, method: payload.method, headers: payload.headers, auth: payload.auth };
      if (payload.body !== undefined) alt.body = payload.body;
      try {
        return Promise.resolve(adapter.request(path, alt));
      } catch (err2) {
        return Promise.reject(err);
      }
    }
  }

  function apiGet(path, options) {
    var opts = options || {};
    opts.method = 'GET';
    return apiRequest(path, opts);
  }

  function apiPost(path, body, options) {
    var opts = options || {};
    opts.method = 'POST';
    if (body !== undefined) opts.body = body;
    return apiRequest(path, opts);
  }

  function qs(params) {
    var parts = [];
    for (var key in params) {
      if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
      var value = params[key];
      if (value === undefined || value === null || value === '') continue;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  // -------------------------------------------------------------------------
  // 会话与角色（GET /api/session 是唯一事实来源，契约 §10/§11.2）
  // -------------------------------------------------------------------------
  function normalizeSession(data) {
    var source = data || {};
    var record = source.user && typeof source.user === 'object' ? source.user : null;
    var username = source.username ? String(source.username)
      : (record && record.username ? String(record.username) : '');
    var role = String(source.role || (record && record.role) || '').toLowerCase();
    if (ROLE_ORDER.indexOf(role) < 0) role = '';
    return {
      user: username || null,
      role: role,
      displayName: record && record.displayName ? String(record.displayName) : (username || ''),
      userRecord: record,
      expiresAt: source.expiresAt || null,
      ttlSeconds: source.ttlSeconds != null && isFinite(Number(source.ttlSeconds))
        ? Number(source.ttlSeconds) : null,
      idleTimeoutSeconds: source.idleTimeoutSeconds != null && isFinite(Number(source.idleTimeoutSeconds))
        ? Number(source.idleTimeoutSeconds) : 0,
      serverTime: source.serverTime || '',
      loaded: true,
      error: ''
    };
  }

  function applySession(data) {
    var next = normalizeSession(data);
    sessionState.user = next.user;
    sessionState.role = next.role;
    sessionState.displayName = next.displayName;
    sessionState.userRecord = next.userRecord;
    sessionState.expiresAt = next.expiresAt;
    sessionState.ttlSeconds = next.ttlSeconds;
    sessionState.idleTimeoutSeconds = next.idleTimeoutSeconds;
    sessionState.serverTime = next.serverTime;
    sessionState.loaded = true;
    sessionState.error = '';
    applyRoleUI();
    emit('cv:role', { role: sessionState.role, user: sessionState.user });
    return sessionState;
  }

  function setSession(info) {
    var data = info || {};
    if (data.base) setBase(data.base);
    var record = data.user && typeof data.user === 'object' ? data.user : null;
    var username = data.username || (record && record.username)
      || (typeof data.user === 'string' ? data.user : '');
    return applySession({
      user: record || (username ? { username: username, displayName: data.displayName || username } : null),
      username: username,
      role: data.role || (record && record.role) || '',
      expiresAt: data.expiresAt || null,
      ttlSeconds: data.ttlSeconds,
      idleTimeoutSeconds: data.idleTimeoutSeconds || 0
    });
  }

  function refreshSession() {
    if (!getAdapter()) return Promise.reject(adapterMissing());
    return resolveBase().then(function () {
      return apiGet('/api/session', { silent401: true, timeoutMs: 12000 });
    }).then(function (data) {
      return applySession(data);
    }, function (err) {
      sessionState.loaded = false;
      sessionState.error = errMessage(err);
      if (err && err.status === 401) clearSession('登录已过期，请重新登录');
      else applyRoleUI();
      throw err;
    });
  }

  function clearSession(reason) {
    sessionState.user = null;
    sessionState.role = '';
    sessionState.displayName = '';
    sessionState.userRecord = null;
    sessionState.expiresAt = null;
    sessionState.ttlSeconds = null;
    sessionState.loaded = false;
    sessionState.error = reason || '';
    stopUsersAuto();
    closeConsole();
    closeRegister(true);
    applyRoleUI();
    emit('cv:role', { role: '', user: '' });
    emit('cv:need-login', { reason: reason || '登录已过期，请重新登录' });
  }

  function roleOf() { return sessionState.role || ''; }
  function isAdmin() { return roleOf() === 'admin'; }
  function canWrite() { return roleOf() === 'admin' || roleOf() === 'editor'; }
  function roleLabel(role) { return ROLE_TEXT[role] || '未知角色'; }

  // -------------------------------------------------------------------------
  // 权限态 UI：viewer 写入口变灰 + 点击拦截（真实拦截至服务端 403 为准）
  // -------------------------------------------------------------------------
  var guardBound = false;
  function bindWriteGuard() {
    if (guardBound) return;
    guardBound = true;
    document.addEventListener('click', function (event) {
      if (!sessionState.loaded || canWrite()) return;
      var node = event.target;
      while (node && node !== document) {
        if (node.matches && node.matches(WRITE_GUARD_SELECTOR)) {
          event.preventDefault();
          event.stopPropagation();
          toast('当前账号是「只读」角色，不能新增或修改台账', 'warn');
          return;
        }
        node = node.parentNode;
      }
    }, true);
  }

  function lockWriteEntries(locked) {
    var nodes = [];
    try { nodes = document.querySelectorAll(WRITE_GUARD_SELECTOR); } catch (err) { nodes = []; }
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (locked) {
        node.setAttribute('data-cva-locked', '1');
        node.setAttribute('title', '只读账号不能执行写操作');
        node.classList.add('cva-locked');
      } else if (node.getAttribute('data-cva-locked')) {
        node.removeAttribute('data-cva-locked');
        node.removeAttribute('title');
        node.classList.remove('cva-locked');
      }
    }
  }

  var entryBtn = null;
  function updateTopbarEntry() {
    var topbar = document.querySelector('.topbar');
    if (!topbar) return;
    if (!entryBtn || !entryBtn.parentNode) {
      entryBtn = $('btnCvaAdmin');
      if (!entryBtn) {
        entryBtn = el('button', 'pill cva-entry');
        entryBtn.id = 'btnCvaAdmin';
        entryBtn.type = 'button';
        var anchorNode = $('btnSettings') || $('btnLog') || null;
        if (anchorNode && anchorNode.parentNode) anchorNode.parentNode.insertBefore(entryBtn, anchorNode);
        else topbar.appendChild(entryBtn);
      }
      entryBtn.addEventListener('click', function () { openConsole(); });
    }
    var show = sessionState.loaded && !!roleOf();
    entryBtn.hidden = !show;
    if (!show) return;
    entryBtn.textContent = isAdmin() ? '账号管理' : '操作日志';
    entryBtn.title = isAdmin() ? '账号审批与管理 · 全员操作日志' : '我的操作日志（最近 50 条）';
  }

  function applyRoleUI() {
    bindWriteGuard();
    lockWriteEntries(!!sessionState.loaded && !canWrite());
    updateTopbarEntry();
    renderConsoleShell();
  }

  // -------------------------------------------------------------------------
  // 登录页「申请注册」入口（不改 index.html / app.js，观察到 #loginScreen 后追加）
  // -------------------------------------------------------------------------
  function ensureLoginEntry() {
    var screen = $('loginScreen');
    if (!screen) return false;
    if ($('cvaRegisterEntry')) return true;
    var box = el('div', 'cva-reg-entry');
    var tip = el('span', 'cva-reg-tip', '还没有账号？');
    var btn = el('button', 'cva-reg-link', '申请注册');
    btn.type = 'button';
    btn.id = 'cvaRegisterEntry';
    btn.addEventListener('click', function () { openRegister(); });
    box.appendChild(tip);
    box.appendChild(btn);
    screen.appendChild(box);
    return true;
  }
  function watchLoginScreen() {
    ensureLoginEntry();
    if (!window.MutationObserver) return;
    try {
      var mo = new window.MutationObserver(function () { ensureLoginEntry(); });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (err) { /* 忽略 */ }
  }

  // -------------------------------------------------------------------------
  // 注册页 + 等待审批（契约 §11.3）
  //   POST /api/register → POST /api/register/status 每 5 秒；密码只在内存里，不落盘
  // -------------------------------------------------------------------------
  var REG_SECRET = { password: '' };
  var regClockTimer = 0;

  function buildRegister() {
    if ($('cvaRegisterLayer')) return;
    var layer = el('div', 'cva-overlay cva-dialog-overlay');
    layer.id = 'cvaRegisterLayer';
    layer.hidden = true;
    var dialog = el('div', 'cva-dialog cva-reg-dialog');
    dialog.id = 'cvaRegisterDialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'cvaRegTitle');
    dialog.innerHTML = '<div class="cva-dialog-head">' +
        '<h3 id="cvaRegTitle">申请服务器账号</h3>' +
        '<p id="cvaRegSub">提交后需要管理员审批；通过后回登录页，用同一个账号密码登录。</p>' +
      '</div>' +
      '<div class="cva-dialog-body" id="cvaRegBody"></div>' +
      '<div class="cva-dialog-foot" id="cvaRegFoot"></div>';
    layer.appendChild(dialog);
    document.body.appendChild(layer);
    layer.addEventListener('click', function (event) {
      if (event.target === layer) closeRegister();
    });
    ensureRegStyles();
  }

  function ensureRegStyles() {
    addStyle('cvaStyles3', [
      '.cva-reg-entry{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:12px;font-size:12px;color:var(--text-3)}',
      '.cva-reg-link{padding:0;border:0;background:transparent;color:var(--gold);font-size:12px;cursor:pointer;font-family:inherit;text-decoration:underline;text-underline-offset:2px}',
      '.cva-reg-link:hover{color:#E4C88B}',
      '.cva-input-wide{width:100%;max-width:none}',
      '.cva-reg-dialog{width:min(520px,94vw)}',
      '.cva-reg-wait{display:flex;gap:12px;align-items:flex-start;padding:6px 0 2px}',
      '.cva-reg-wait .cva-spinner{margin-top:2px;flex:none}',
      '.cva-reg-wait-main{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.cva-reg-wait-main .cva-note-inline{margin:0}',
      '.cva-note-bad b{color:#FF8A8D}',
      '.cva-note-bad{display:flex;flex-direction:column;gap:6px}',
      '.cva-entry{white-space:nowrap}',
      '.cva-locked{opacity:.55;cursor:not-allowed}',
    ].join('\n'));
    flushStyles();
  }

  function readRegisterForm() {
    return {
      username: ($('cvaRegUser') && $('cvaRegUser').value ? $('cvaRegUser').value : '').trim(),
      password: $('cvaRegPass') ? $('cvaRegPass').value : '',
      password2: $('cvaRegPass2') ? $('cvaRegPass2').value : '',
      device: ($('cvaRegDevice') && $('cvaRegDevice').value ? $('cvaRegDevice').value : '').trim()
    };
  }

  function renderRegister() {
    buildRegister();
    var body = $('cvaRegBody');
    var foot = $('cvaRegFoot');
    if (!body || !foot) return;
    var stage = state.register.stage;
    if (stage === 'waiting' || stage === 'active' || stage === 'timeout') {
      renderRegisterWaiting(body, foot);
    } else if (stage === 'rejected' || stage === 'disabled' || stage === 'none') {
      renderRegisterRejected(body, foot);
    } else {
      renderRegisterForm(body, foot);
    }
  }

  function renderRegisterForm(body, foot) {
    stopRegClock();
    var lastUser = state.register.username || lsGet('cv.regUser') || '';
    var lastDevice = state.register.device || deviceGuess();
    body.innerHTML =
      '<form class="cva-form" id="cvaRegForm" autocomplete="off" novalidate>' +
        '<div class="full"><label class="cva-label" for="cvaRegUser">用户名</label>' +
          '<input class="cva-input cva-input-wide" id="cvaRegUser" name="username" maxlength="32" ' +
            'placeholder="3~32 位字母、数字、下划线或短横线" autocomplete="username" value="' + esc(lastUser) + '" /></div>' +
        '<div><label class="cva-label" for="cvaRegPass">密码</label>' +
          '<input class="cva-input cva-input-wide" id="cvaRegPass" type="password" maxlength="64" ' +
            'placeholder="至少 6 位" autocomplete="new-password" /></div>' +
        '<div><label class="cva-label" for="cvaRegPass2">确认密码</label>' +
          '<input class="cva-input cva-input-wide" id="cvaRegPass2" type="password" maxlength="64" ' +
            'placeholder="再输入一次" autocomplete="new-password" /></div>' +
        '<div class="full"><label class="cva-label" for="cvaRegDevice">设备</label>' +
          '<input class="cva-input cva-input-wide" id="cvaRegDevice" maxlength="60" ' +
            'placeholder="例如 Windows · Chrome" value="' + esc(lastDevice) + '" /></div>' +
        '<p class="cva-note-inline full" id="cvaRegErr" hidden></p>' +
        '<p class="cva-note-inline full">审批通过前不能登录；同一个 IP 10 分钟内最多提交 5 次。</p>' +
      '</form>';
    foot.innerHTML = '<button class="btn ghost" type="button" id="cvaRegCancel">取消</button>' +
      '<button class="btn primary" type="button" id="cvaRegSubmit">提交申请</button>';
    $('cvaRegCancel').addEventListener('click', function () { closeRegister(); });
    $('cvaRegSubmit').addEventListener('click', submitRegister);
    var form = $('cvaRegForm');
    if (form) {
      form.addEventListener('submit', function (event) { event.preventDefault(); submitRegister(); });
      form.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.keyCode === 13) { event.preventDefault(); submitRegister(); }
      });
    }
  }

  function setRegisterError(text) {
    var node = $('cvaRegErr');
    if (!node) return;
    if (text) { node.textContent = String(text); node.hidden = false; }
    else { node.textContent = ''; node.hidden = true; }
  }

  function submitRegister() {
    var form = readRegisterForm();
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(form.username)) {
      setRegisterError('用户名需为 3~32 位字母、数字、下划线或短横线');
      return;
    }
    if (form.password.length < 6) {
      setRegisterError('密码至少 6 位');
      return;
    }
    if (form.password !== form.password2) {
      setRegisterError('两次输入的密码不一致');
      return;
    }
    var device = form.device || deviceGuess();
    var btn = $('cvaRegSubmit');
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    setRegisterError('');
    apiPost('/api/register', {
      username: form.username,
      password: form.password,
      device: device
    }, { auth: false, timeoutMs: 15000 }).then(function (data) {
      var info = data || {};
      state.register.username = form.username;
      state.register.device = device;
      state.register.stage = 'waiting';
      state.register.reason = '';
      state.register.message = info.message || '已提交申请，请等待管理员审批';
      lsSet('cv.regUser', form.username);
      startRegisterPoll(form.password);
    }).catch(function (err) {
      setRegisterError(errMessage(err));
    }).then(function () {
      var submitBtn = $('cvaRegSubmit');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '提交申请'; }
    });
  }

  function elapsedText() {
    if (!state.register.startedAt) return '';
    return clockText(Date.now() - state.register.startedAt);
  }

  function startRegClock() {
    stopRegClock();
    regClockTimer = window.setInterval(function () {
      var node = $('cvaRegClock');
      if (node) node.textContent = elapsedText();
      else stopRegClock();
    }, 1000);
  }
  function stopRegClock() {
    if (regClockTimer) { window.clearInterval(regClockTimer); regClockTimer = 0; }
  }

  function renderRegisterWaiting(body, foot) {
    var stage = state.register.stage;
    var title = stage === 'active' ? '审批通过' : (stage === 'timeout' ? '等待超时' : '等待管理员审批');
    var note = state.register.message || '已提交申请，请等待管理员审批';
    var head = stage === 'active'
      ? '<span class="cva-badge ok">已通过</span>'
      : '<span class="cva-spinner"></span>';
    var tail = stage === 'active'
      ? '正在返回登录界面，请用刚申请的账号登录。'
      : '保持此窗口打开即可；通过后会自动跳回登录页。';
    body.innerHTML = '<div class="cva-reg-wait">' + head +
        '<div class="cva-reg-wait-main">' +
          '<div class="cva-h2" style="margin:0">' + esc(title) + '</div>' +
          '<div class="cva-note-inline">账号 <b>' + esc(state.register.username) + '</b> · ' + esc(note) + '</div>' +
          '<div class="cva-note-inline">已等待 <span id="cvaRegClock">' + esc(elapsedText() || '00:00') + '</span>' +
            (stage === 'waiting' ? ' · 每 5 秒自动刷新一次' : '') + '</div>' +
          '<p class="cva-note-inline" id="cvaRegStatus">' + esc(tail) + '</p>' +
        '</div>' +
      '</div>';
    foot.innerHTML = '<button class="btn ghost" type="button" id="cvaRegCancel">取消等待</button>' +
      '<button class="btn primary" type="button" id="cvaRegAgain">重新填写</button>';
    $('cvaRegCancel').addEventListener('click', function () { closeRegister(); });
    $('cvaRegAgain').addEventListener('click', function () {
      stopRegisterPoll();
      REG_SECRET.password = '';
      state.register.stage = 'form';
      state.register.message = '';
      renderRegister();
    });
    if (stage === 'waiting') startRegClock();
    else stopRegClock();
  }

  function renderRegisterRejected(body, foot) {
    stopRegClock();
    var stage = state.register.stage;
    var label = stage === 'rejected' ? '申请被拒绝'
      : (stage === 'disabled' ? '账号已停用' : '账号不存在');
    var reason = state.register.reason || '';
    body.innerHTML = '<div class="cva-note-bad">' +
        '<b>' + esc(label) + '</b>' +
        '<span class="cva-note-inline">' + esc(reason || '请联系管理员了解原因') + '</span>' +
        '<p class="cva-note-inline">可以换一个用户名重新提交申请；如果认为这是误判，请让管理员处理。</p>' +
      '</div>';
    foot.innerHTML = '<button class="btn ghost" type="button" id="cvaRegCancel">关闭</button>' +
      '<button class="btn primary" type="button" id="cvaRegAgain">重新申请</button>';
    $('cvaRegCancel').addEventListener('click', function () { closeRegister(); });
    $('cvaRegAgain').addEventListener('click', function () {
      REG_SECRET.password = '';
      state.register.stage = 'form';
      state.register.message = '';
      renderRegister();
    });
  }

  function setRegisterStatus(text, tone) {
    state.register.message = text;
    var node = $('cvaRegStatus');
    if (node) {
      node.textContent = text;
      node.className = 'cva-note-inline' + (tone ? ' cva-' + tone : '');
    }
  }

  function startRegisterPoll(password) {
    stopRegisterPoll();
    REG_SECRET.password = String(password || '');
    state.register.startedAt = Date.now();
    renderRegister();
    pollRegisterOnce();
    state.register.timer = window.setInterval(pollRegisterOnce, REGISTER_POLL_MS);
  }

  function stopRegisterPoll() {
    if (state.register.timer) { window.clearInterval(state.register.timer); state.register.timer = 0; }
  }

  function pollRegisterOnce() {
    if (!state.register.username || !REG_SECRET.password) return;
    if (state.register.startedAt && Date.now() - state.register.startedAt > REGISTER_WAIT_MAX_MS) {
      stopRegisterPoll();
      state.register.stage = 'timeout';
      state.register.message = '等待超过 1 小时仍未审批，可稍后重新提交申请';
      renderRegister();
      return;
    }
    apiPost('/api/register/status', {
      username: state.register.username,
      password: REG_SECRET.password
    }, { auth: false, silent401: true, timeoutMs: 15000 }).then(handleRegisterStatus).catch(function (err) {
      setRegisterStatus(errMessage(err), 'warn');
    });
  }

  function handleRegisterStatus(data) {
    var status = String((data && data.status) || 'pending');
    var reason = data && data.reason ? String(data.reason) : '';
    if (status === 'pending') {
      setRegisterStatus('管理员正在审批，请稍候…');
      return;
    }
    if (status === 'active') {
      stopRegisterPoll();
      state.register.stage = 'active';
      state.register.message = '管理员已通过审批';
      renderRegister();
      finishRegisterLogin();
      return;
    }
    if (status === 'rejected' || status === 'disabled' || status === 'none') {
      stopRegisterPoll();
      REG_SECRET.password = '';
      state.register.stage = status;
      if (status === 'rejected') state.register.reason = reason || '管理员拒绝了该申请';
      else if (status === 'disabled') state.register.reason = reason || '该账号已被停用';
      else state.register.reason = reason || '服务器上没有这个账号，请重新提交申请';
      renderRegister();
      return;
    }
    setRegisterStatus('当前状态：' + status);
  }

  function finishRegisterLogin() {
    var username = state.register.username;
    var password = REG_SECRET.password;
    var userInput = $('loginUser');
    var passInput = $('loginPass');
    if (userInput && username) userInput.value = username;
    if (passInput && password) passInput.value = password;
    toast('账号已通过审批：正在返回登录界面', 'ok');
    window.setTimeout(function () {
      closeRegister(true);
      var screen = $('loginScreen');
      if (screen) screen.hidden = false;
      var loginBtn = $('btnLogin');
      if (loginBtn) { try { loginBtn.focus(); } catch (err) { /* 忽略 */ } }
    }, 1600);
  }

  function openRegister() {
    buildRegister();
    if (state.register.stage === 'waiting' && state.register.username && REG_SECRET.password) {
      startRegisterPoll(REG_SECRET.password);
    }
    if (state.register.stage !== 'rejected' && state.register.stage !== 'disabled') {
      state.register.stage = 'form';
    }
    renderRegister();
    var layer = $('cvaRegisterLayer');
    if (layer) layer.hidden = false;
    flushStyles();
    window.setTimeout(function () {
      var node = $('cvaRegUser');
      if (node && !node.value) { try { node.focus(); } catch (err) { /* 忽略 */ } }
    }, 40);
    emit('cv:register-open');
  }

  function closeRegister(silent) {
    stopRegisterPoll();
    stopRegClock();
    var layer = $('cvaRegisterLayer');
    if (layer) layer.hidden = true;
    REG_SECRET.password = '';
    if (!silent) emit('cv:register-close');
  }

  // -------------------------------------------------------------------------
  // 通用小对话框（确认 / 输入），替代 window.confirm / prompt
  // -------------------------------------------------------------------------
  var dialogState = { onOk: null, validate: null, busy: false };

  function buildDialog() {
    if ($('cvaDialogLayer')) return;
    var layer = el('div', 'cva-overlay cva-dialog-overlay');
    layer.id = 'cvaDialogLayer';
    layer.hidden = true;
    var dialog = el('div', 'cva-dialog');
    dialog.id = 'cvaDialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = '<div class="cva-dialog-head">' +
        '<h3 id="cvaDialogTitle"></h3>' +
        '<p id="cvaDialogDesc"></p>' +
      '</div>' +
      '<div class="cva-dialog-body" id="cvaDialogBody"></div>' +
      '<div class="cva-dialog-foot">' +
        '<button class="btn ghost" type="button" id="cvaDialogCancel">取消</button>' +
        '<button class="btn primary" type="button" id="cvaDialogOk">确定</button>' +
      '</div>';
    layer.appendChild(dialog);
    document.body.appendChild(layer);
    layer.addEventListener('click', function (event) {
      if (event.target === layer) closeDialog();
    });
    $('cvaDialogCancel').addEventListener('click', closeDialog);
    $('cvaDialogOk').addEventListener('click', submitDialog);
    var body = $('cvaDialogBody');
    body.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && event.target && event.target.tagName !== 'TEXTAREA') {
        event.preventDefault();
        submitDialog();
      }
    });
  }

  function fieldHtml(field) {
    var id = 'cvaFld_' + field.name;
    var html = '<div class="' + (field.full ? 'full' : '') + '">' +
      '<label class="cva-label" for="' + id + '">' + esc(field.label) + '</label>';
    if (field.type === 'select') {
      html += '<select class="cva-input cva-input-wide" id="' + id + '" data-fld="' + esc(field.name) + '">';
      for (var i = 0; i < field.options.length; i++) {
        var opt = field.options[i];
        html += '<option value="' + esc(opt.value) + '"' + (opt.value === field.value ? ' selected' : '') + '>' + esc(opt.label) + '</option>';
      }
      html += '</select>';
    } else if (field.type === 'textarea') {
      html += '<textarea class="cva-input cva-input-wide cva-textarea" id="' + id + '" data-fld="' + esc(field.name) + '" maxlength="' + (field.maxlength || 200) + '" rows="3" placeholder="' + esc(field.placeholder || '') + '">' + esc(field.value || '') + '</textarea>';
    } else {
      html += '<input class="cva-input cva-input-wide" id="' + id + '" data-fld="' + esc(field.name) + '" type="' + (field.type === 'password' ? 'password' : 'text') + '" value="' + esc(field.value || '') + '" placeholder="' + esc(field.placeholder || '') + '" maxlength="' + (field.maxlength || 120) + '" autocomplete="off" />';
    }
    if (field.hint) html += '<p class="cva-note-inline">' + esc(field.hint) + '</p>';
    html += '</div>';
    return html;
  }

  function openDialog(options) {
    var opts = options || {};
    buildDialog();
    dialogState.onOk = opts.onSubmit || null;
    dialogState.validate = opts.validate || null;
    dialogState.busy = false;
    var title = $('cvaDialogTitle');
    var desc = $('cvaDialogDesc');
    var body = $('cvaDialogBody');
    var ok = $('cvaDialogOk');
    if (title) title.textContent = opts.title || '确认操作';
    if (desc) { desc.textContent = opts.desc || ''; desc.hidden = !opts.desc; }
    if (ok) {
      ok.textContent = opts.okText || '确定';
      ok.className = 'btn ' + (opts.tone === 'danger' ? 'danger' : 'primary');
      ok.disabled = false;
    }
    var fields = opts.fields || [];
    if (fields.length) {
      var html = '<div class="cva-form">';
      for (var i = 0; i < fields.length; i++) html += fieldHtml(fields[i]);
      html += '<p class="cva-note-inline full" id="cvaDialogErr" hidden></p></div>';
      body.innerHTML = html;
    } else {
      body.innerHTML = '';
    }
    var layer = $('cvaDialogLayer');
    if (layer) layer.hidden = false;
    flushStyles();
    window.setTimeout(function () {
      var first = null;
      try { first = body.querySelector('input,textarea,select'); } catch (err) { first = null; }
      if (first) { try { first.focus(); } catch (err) { /* 忽略 */ } }
      else if (ok) { try { ok.focus(); } catch (err) { /* 忽略 */ } }
    }, 40);
  }

  function collectDialogValues() {
    var out = {};
    var body = $('cvaDialogBody');
    if (!body) return out;
    var nodes = body.querySelectorAll('[data-fld]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      out[node.getAttribute('data-fld')] = node.value == null ? '' : String(node.value).trim();
    }
    return out;
  }

  function dialogError(text) {
    var node = $('cvaDialogErr');
    if (!node) return;
    if (text) { node.textContent = String(text); node.hidden = false; }
    else { node.textContent = ''; node.hidden = true; }
  }

  function submitDialog() {
    if (dialogState.busy) return;
    var values = collectDialogValues();
    if (dialogState.validate) {
      var message = dialogState.validate(values);
      if (message) { dialogError(message); return; }
    }
    dialogError('');
    var handler = dialogState.onOk;
    if (!handler) { closeDialog(); return; }
    var ok = $('cvaDialogOk');
    var result;
    try { result = handler(values); } catch (err) { dialogError(errMessage(err)); return; }
    if (!result || typeof result.then !== 'function') { closeDialog(); return; }
    dialogState.busy = true;
    if (ok) { ok.disabled = true; ok.textContent = '处理中…'; }
    result.then(function () {
      dialogState.busy = false;
      if (ok) { ok.disabled = false; ok.textContent = '确定'; }
      closeDialog();
    }, function (err) {
      dialogState.busy = false;
      if (ok) { ok.disabled = false; ok.textContent = '确定'; }
      dialogError(errMessage(err));
      if (err && err.status === 401) closeDialog();
    });
  }

  function closeDialog() {
    var layer = $('cvaDialogLayer');
    if (layer) layer.hidden = true;
    dialogState.onOk = null;
    dialogState.validate = null;
    dialogState.busy = false;
  }

  // -------------------------------------------------------------------------
  // 控制台外壳（用户管理 / 操作日志 两个分页）
  // -------------------------------------------------------------------------
  function buildConsole() {
    if ($('cvaConsole')) return;
    var layer = el('div', 'cva-overlay');
    layer.id = 'cvaConsole';
    layer.hidden = true;
    var box = el('div', 'cva-console');
    box.id = 'cvaConsoleBox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'cvaConsoleTitle');
    box.innerHTML = '<div class="cva-console-head">' +
        '<div class="cva-console-title"><h2 id="cvaConsoleTitle">账号管理</h2>' +
          '<p id="cvaConsoleSub"></p></div>' +
        '<div class="cva-tabs" id="cvaTabs"></div>' +
        '<button class="cva-x" type="button" id="cvaConsoleClose" title="关闭">✕</button>' +
      '</div>' +
      '<div class="cva-console-body" id="cvaConsoleBody"></div>';
    layer.appendChild(box);
    document.body.appendChild(layer);
    layer.addEventListener('click', function (event) {
      if (event.target === layer) closeConsole();
    });
    $('cvaConsoleClose').addEventListener('click', closeConsole);
    ensureConsoleStyles();
  }

  function ensureConsoleStyles() {
    addStyle('cvaStyles4', [
      '.cva-console-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
      '.cva-spacer{flex:1 1 auto}',
      '.cva-textarea{height:auto;min-height:64px;padding:7px 9px;line-height:1.55;resize:vertical;font-family:inherit}',
      'select.cva-input{appearance:none;-webkit-appearance:none;padding-right:22px;background-image:linear-gradient(45deg,transparent 50%,#7D8B9C 50%),linear-gradient(135deg,#7D8B9C 50%,transparent 50%);background-position:calc(100% - 12px) 13px,calc(100% - 7px) 13px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}',
      '.cva-toolbar .cva-input{min-width:120px}',
      '.cva-meta{font-size:11.5px;color:#7D8B9C;white-space:nowrap}',
      '.cva-meta.busy{color:#EBC55E}',
      '.cva-ucell{display:flex;align-items:center;gap:8px;min-width:0}',
      '.cva-uavatar{width:26px;height:26px;border-radius:8px;flex:none;display:grid;place-items:center;background:rgba(201,164,92,.14);color:#DCBE80;font-size:11.5px;font-weight:700;text-transform:uppercase}',
      '.cva-uname{font-weight:600;color:#E8EDF4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cva-usub{font-size:11px;color:#7D8B9C;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cva-act{display:inline-flex;align-items:center;height:22px;padding:0 8px;margin:0 4px 4px 0;border-radius:6px;border:1px solid #2C3B4E;background:#16212E;color:#A8B6C6;font-size:11.5px;cursor:pointer;font-family:inherit;white-space:nowrap}',
      '.cva-act:hover{color:#E8EDF4;border-color:#3B4E66;background:#1B2836}',
      '.cva-act.good{color:#5ED3A0;border-color:rgba(47,179,122,.35)}',
      '.cva-act.good:hover{background:rgba(47,179,122,.12)}',
      '.cva-act.bad{color:#F08387;border-color:rgba(229,72,77,.32)}',
      '.cva-act.bad:hover{background:rgba(229,72,77,.12)}',
      '.cva-act[disabled]{opacity:.45;cursor:not-allowed}',
      '.cva-act[disabled]:hover{color:#A8B6C6;border-color:#2C3B4E;background:#16212E}',
      '.cva-self-tag{font-size:10.5px;color:#8FB4FF;border:1px solid rgba(61,123,255,.35);border-radius:5px;padding:0 4px;margin-left:4px}',
      '.cva-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:36px 16px;color:#7D8B9C;font-size:12.5px;text-align:center}',
      '.cva-empty b{color:#C9D4E2;font-size:13px}',
    ].join('\n'));
    flushStyles();
  }

  function renderConsoleShell() {
    var tabs = $('cvaTabs');
    if (!tabs) return;
    var items = [];
    if (isAdmin()) items.push({ id: 'users', label: '用户管理' });
    items.push({ id: 'logs', label: '操作日志' });
    tabs.innerHTML = '';
    for (var i = 0; i < items.length; i++) {
      (function (item) {
        var btn = el('button', state.view === item.id ? 'on' : '', item.label);
        btn.type = 'button';
        btn.setAttribute('data-view', item.id);
        btn.addEventListener('click', function () { switchView(item.id); });
        tabs.appendChild(btn);
      })(items[i]);
    }
    var title = $('cvaConsoleTitle');
    if (title) title.textContent = state.view === 'users' ? '账号管理' : '操作日志';
    var sub = $('cvaConsoleSub');
    if (sub) {
      var parts = [];
      if (sessionState.user) parts.push(sessionState.user + ' · ' + roleLabel(roleOf()));
      if (sessionState.expiresAt) parts.push(fmtExpire(sessionState.expiresAt));
      if (sessionState.base) parts.push(sessionState.base);
      sub.textContent = parts.join(' · ');
    }
  }

  function switchView(view) {
    var next = view === 'logs' ? 'logs' : 'users';
    if (next === 'users' && !isAdmin()) next = 'logs';
    state.view = next;
    renderConsole();
    if (next === 'users') loadUsers({ force: true });
    else loadLogs(true);
  }

  function renderConsole() {
    var body = $('cvaConsoleBody');
    if (!body) return;
    renderConsoleShell();
    if (!sessionState.loaded) {
      body.innerHTML = '<div class="cva-empty"><b>登录状态已失效</b><span>请关闭窗口后重新登录</span></div>';
      return;
    }
    if (state.view === 'users' && isAdmin()) renderUsersView(body);
    else renderLogsView(body);
  }

  function openConsole(view) {
    if (!sessionState.loaded) {
      toast('请先登录服务器账号', 'warn');
      return;
    }
    buildConsole();
    if (view === 'users' || view === 'logs') state.view = view;
    if (state.view === 'users' && !isAdmin()) state.view = 'logs';
    var layer = $('cvaConsole');
    if (layer) layer.hidden = false;
    state.consoleOpen = true;
    renderConsole();
    flushStyles();
    if (state.view === 'users') loadUsers({ force: true });
    else loadLogs(true);
    startUsersAuto();
    emit('cv:admin-open', { view: state.view });
  }

  function closeConsole() {
    var layer = $('cvaConsole');
    if (layer) layer.hidden = true;
    state.consoleOpen = false;
    stopUsersAuto();
    emit('cv:admin-close');
  }

  function startUsersAuto() {
    stopUsersAuto();
    state.usersTimer = window.setInterval(function () {
      if (!state.consoleOpen || state.view !== 'users' || !isAdmin()) return;
      if (document.hidden) return;
      loadUsers({ silent: true });
    }, USERS_AUTO_MS);
  }

  function stopUsersAuto() {
    if (state.usersTimer) { window.clearInterval(state.usersTimer); state.usersTimer = 0; }
  }

  // -------------------------------------------------------------------------
  // 用户管理（GET /api/admin/users + approve / reject / role / status / reset-password）
  // -------------------------------------------------------------------------
  var USER_STATUS_FILTERS = [
    ['all', '全部状态'], ['pending', '待审批'], ['active', '正常'], ['disabled', '已停用'], ['rejected', '已拒绝']
  ];

  function roleOptions(role) {
    var out = [];
    for (var i = 0; i < ROLE_ORDER.length; i++) {
      out.push({ value: ROLE_ORDER[i], label: ROLE_TEXT[ROLE_ORDER[i]] + ' · ' + ROLE_DESC[ROLE_ORDER[i]] });
    }
    return out;
  }

  function loadUsers(options) {
    var opts = options || {};
    if (!isAdmin()) return Promise.resolve(null);
    if (state.usersBusy) return Promise.resolve(null);
    state.usersBusy = true;
    setUsersMeta(opts.silent ? '刷新中…' : '加载中…', true);
    return apiGet('/api/admin/users', { timeoutMs: 15000 }).then(function (data) {
      var list = data && Array.isArray(data.users) ? data.users
        : (Array.isArray(data) ? data : []);
      state.users = list;
      state.usersAt = Date.now();
      state.usersBusy = false;
      state.pendingCount = 0;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].status === 'pending') state.pendingCount += 1;
      }
      renderUsersTable();
      if (state.view === 'users') updatePendingTip();
      setUsersMeta('', false);
      emit('cv:users-loaded', { count: list.length, pending: state.pendingCount });
      return list;
    }, function (err) {
      state.usersBusy = false;
      setUsersMeta('加载失败：' + errMessage(err), false);
      if (err && err.status === 401) closeConsole();
      return null;
    });
  }

  function setUsersMeta(text, busy) {
    var node = $('cvaUsersMeta');
    if (!node) return;
    if (busy) {
      node.textContent = text || '加载中…';
      node.className = 'cva-meta busy';
      return;
    }
    var parts = [];
    parts.push('共 ' + state.users.length + ' 个账号');
    if (state.pendingCount) parts.push('待审批 ' + state.pendingCount);
    if (state.usersAt) parts.push(fmtShort(new Date(state.usersAt).toISOString()) + ' 更新');
    node.textContent = parts.join(' · ');
    node.className = 'cva-meta';
  }

  function userById(id) {
    for (var i = 0; i < state.users.length; i++) {
      if (state.users[i] && String(state.users[i].id) === String(id)) return state.users[i];
    }
    return null;
  }

  function matchUser(user, query) {
    if (!query) return true;
    var q = query.toLowerCase();
    var fields = [user.username, user.displayName, user.device, user.ip, user.reason];
    for (var i = 0; i < fields.length; i++) {
      if (fields[i] && String(fields[i]).toLowerCase().indexOf(q) >= 0) return true;
    }
    return false;
  }

  function visibleUsers() {
    var query = String(state.userQuery || '').trim();
    var status = state.userStatus || 'all';
    var list = [];
    for (var i = 0; i < state.users.length; i++) {
      var user = state.users[i];
      if (!user) continue;
      if (status !== 'all' && user.status !== status) continue;
      if (!matchUser(user, query)) continue;
      list.push(user);
    }
    list.sort(function (a, b) {
      var sa = STATUS_ORDER[a.status] == null ? 9 : STATUS_ORDER[a.status];
      var sb = STATUS_ORDER[b.status] == null ? 9 : STATUS_ORDER[b.status];
      if (sa !== sb) return sa - sb;
      var ta = parseTime(a.createdAt) || 0;
      var tb = parseTime(b.createdAt) || 0;
      return ta - tb;
    });
    return list;
  }

  function statusFilterOptions() {
    var html = '';
    for (var i = 0; i < USER_STATUS_FILTERS.length; i++) {
      var item = USER_STATUS_FILTERS[i];
      html += '<option value="' + item[0] + '"' + (state.userStatus === item[0] ? ' selected' : '') + '>' + item[1] + '</option>';
    }
    return html;
  }

  function renderUsersView(body) {
    state.userQuery = state.userQuery || '';
    state.userStatus = state.userStatus || 'all';
    body.innerHTML = '<div class="cva-toolbar">' +
        '<input class="cva-input" id="cvaUserSearch" type="search" placeholder="搜索用户名 / 姓名 / 设备 / IP" value="' + esc(state.userQuery) + '" />' +
        '<select class="cva-input" id="cvaUserStatus">' + statusFilterOptions() + '</select>' +
        '<button class="btn ghost small" type="button" id="cvaUsersRefresh">刷新</button>' +
        '<span class="cva-spacer"></span>' +
        '<span class="cva-meta" id="cvaUsersMeta">—</span>' +
      '</div>' +
      '<div class="cva-note" id="cvaPendingTip" hidden></div>' +
      '<div class="cva-tablewrap"><table class="cva-table">' +
        '<thead><tr><th>账号</th><th>角色</th><th>状态</th><th>设备 · IP</th>' +
          '<th>最近登录</th><th>创建 · 审批</th><th class="cva-actions-col">操作</th></tr></thead>' +
        '<tbody id="cvaUsersBody"></tbody>' +
      '</table></div>';
    var search = $('cvaUserSearch');
    if (search) {
      search.addEventListener('input', function () {
        state.userQuery = search.value || '';
        debounceUsersRender();
      });
      search.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') { search.value = ''; state.userQuery = ''; renderUsersTable(); }
      });
    }
    var status = $('cvaUserStatus');
    if (status) {
      status.addEventListener('change', function () {
        state.userStatus = status.value || 'all';
        renderUsersTable();
      });
    }
    var refresh = $('cvaUsersRefresh');
    if (refresh) refresh.addEventListener('click', function () { loadUsers({ force: true }); });
    var tbody = $('cvaUsersBody');
    if (tbody) tbody.addEventListener('click', onUsersClick);
    renderUsersTable();
    setUsersMeta('', false);
    updatePendingTip();
  }

  var debounceUsersRender = debounce(function () { renderUsersTable(); }, 180);

  function updatePendingTip() {
    var node = $('cvaPendingTip');
    if (!node) return;
    if (!state.pendingCount) { node.hidden = true; node.innerHTML = ''; return; }
    node.hidden = false;
    node.innerHTML = '<b>有 ' + state.pendingCount + ' 个注册申请待审批</b>' +
      '<span>通过后对方即可用原密码登录；拒绝时需要填写原因。</span>' +
      '<button class="btn ghost small" type="button" id="cvaOnlyPending">只看待审批</button>';
    var btn = $('cvaOnlyPending');
    if (btn) btn.addEventListener('click', function () {
      state.userStatus = 'pending';
      var select = $('cvaUserStatus');
      if (select) select.value = 'pending';
      renderUsersTable();
    });
  }

  function renderUsersTable() {
    var tbody = $('cvaUsersBody');
    if (!tbody) return;
    var list = visibleUsers();
    var html = '';
    if (!list.length) {
      html = '<tr><td colspan="7"><div class="cva-empty"><b>' +
        (state.users.length ? '没有匹配的账号' : '还没有账号') + '</b><span>' +
        (state.users.length ? '换个关键词或状态再试' : '注册申请会出现在这里，等待管理员审批') +
        '</span></div></td></tr>';
    } else {
      for (var i = 0; i < list.length; i++) html += userRowHtml(list[i]);
    }
    tbody.innerHTML = html;
    setUsersMeta('', false);
  }

  function userRowHtml(user) {
    var status = user.status || 'pending';
    var tone = STATUS_TONE[status] || 'off';
    var roleCls = user.role === 'admin' ? 'admin' : (user.role === 'editor' ? 'editor' : 'viewer');
    var self = !!sessionState.user && user.username === sessionState.user;
    var initial = String(user.displayName || user.username || '?').slice(0, 2);
    var reason = user.reason
      ? '<div class="cva-usub" title="' + esc(user.reason) + '">原因：' + esc(user.reason) + '</div>' : '';
    var approved = user.approvedBy ? '审批人 ' + esc(user.approvedBy) : '未审批';
    return '<tr class="' + (status === 'pending' ? 'cva-pending' : '') + (self ? ' cva-self' : '') + '">' +
        '<td><div class="cva-ucell"><div class="cva-uavatar">' + esc(initial) + '</div>' +
          '<div style="min-width:0"><div class="cva-uname">' + esc(user.displayName || user.username || '—') +
            (self ? '<span class="cva-self-tag">我</span>' : '') + '</div>' +
            '<div class="cva-usub">' + esc(user.username || '') + ' · ID ' + esc(user.id || '') + '</div></div></div></td>' +
        '<td><span class="cva-badge ' + roleCls + '">' + esc(roleLabel(user.role)) + '</span></td>' +
        '<td><span class="cva-badge ' + tone + '">' + esc(STATUS_TEXT[status] || status) + '</span>' + reason + '</td>' +
        '<td><div class="cva-uname" style="font-weight:400">' + esc(user.device || '未登记') + '</div>' +
          '<div class="cva-usub">' + esc(user.ip || '—') + '</div></td>' +
        '<td><div class="cva-uname" style="font-weight:400">' +
          (user.lastLoginAt ? esc(fmtDateTime(user.lastLoginAt)) : '从未登录') + '</div>' +
          '<div class="cva-usub">登录 ' + Number(user.loginCount || 0) + ' 次</div></td>' +
        '<td><div class="cva-uname" style="font-weight:400">' +
          (user.createdAt ? esc(fmtShort(user.createdAt)) : '—') + '</div>' +
          '<div class="cva-usub">' + approved + '</div></td>' +
        '<td class="cva-actions-col">' + userActionsHtml(user, self) + '</td>' +
      '</tr>';
  }

  function userActionsHtml(user, self) {
    var id = esc(user.id);
    var status = user.status || 'pending';
    var out = '';
    if (status === 'pending' || status === 'rejected') {
      out += '<button class="cva-act good" type="button" data-cva-act="approve" data-id="' + id + '">' +
        (status === 'rejected' ? '改为通过' : '通过') + '</button>';
    }
    if (status === 'pending') {
      out += '<button class="cva-act bad" type="button" data-cva-act="reject" data-id="' + id + '">拒绝</button>';
    }
    if (status === 'active' || status === 'disabled') {
      out += '<button class="cva-act" type="button" data-cva-act="role" data-id="' + id + '">改角色</button>';
      out += '<button class="cva-act" type="button" data-cva-act="reset" data-id="' + id + '">重置密码</button>';
    }
    if (status === 'active') {
      out += '<button class="cva-act bad" type="button" data-cva-act="status" data-id="' + id + '"' +
        (self ? ' disabled title="不能停用当前登录的账号"' : '') + '>停用</button>';
    } else if (status === 'disabled') {
      out += '<button class="cva-act good" type="button" data-cva-act="status" data-id="' + id + '">启用</button>';
    }
    out += '<button class="cva-act" type="button" data-cva-act="logs" data-id="' + id + '">日志</button>';
    return out;
  }

  function onUsersClick(event) {
    var node = event.target;
    while (node && node !== document) {
      if (node.getAttribute && node.getAttribute('data-cva-act')) break;
      node = node.parentNode;
    }
    if (!node || !node.getAttribute) return;
    var act = node.getAttribute('data-cva-act');
    var user = userById(node.getAttribute('data-id') || '');
    if (!user) return;
    if (node.disabled) return;
    if (act === 'approve') askApprove(user);
    else if (act === 'reject') askReject(user);
    else if (act === 'role') askRole(user);
    else if (act === 'status') askToggleStatus(user);
    else if (act === 'reset') askResetPassword(user);
    else if (act === 'logs') showUserLogs(user);
  }

  function userApi(user, action) {
    return '/api/admin/users/' + encodeURIComponent(String(user.id || '')) + '/' + action;
  }

  function refreshUsersSoon() {
    loadUsers({ force: true });
  }

  function handleAuthError(err) {
    if (err && err.status === 401) { clearSession('登录已过期，请重新登录'); return true; }
    return false;
  }

  function askApprove(user) {
    var options = roleOptions(user.role);
    openDialog({
      title: '通过账号申请',
      desc: '为「' + user.username + '」设置角色；通过后对方即可用申请时的密码登录。',
      okText: '通过审批',
      fields: [{ name: 'role', label: '角色', type: 'select', value: user.role || 'editor', full: true, options: options }],
      onSubmit: function (values) {
        return apiPost(userApi(user, 'approve'), { role: values.role }).then(function () {
          toast('已通过「' + user.username + '」的申请', 'ok');
          refreshUsersSoon();
        }, function (err) {
          if (handleAuthError(err)) return;
          throw err;
        });
      }
    });
  }

  function askReject(user) {
    openDialog({
      title: '拒绝账号申请',
      desc: '「' + user.username + '」会看到你填写的拒绝原因。',
      okText: '拒绝申请',
      tone: 'danger',
      fields: [{ name: 'reason', label: '拒绝原因', type: 'textarea', full: true, value: '', maxlength: 200,
        placeholder: '例如：不是本团队成员 / 请联系管理员确认身份' }],
      validate: function (values) {
        if (!values.reason) return '请填写拒绝原因，申请人会看到这条说明';
        if (values.reason.length > 200) return '拒绝原因不要超过 200 字';
        return '';
      },
      onSubmit: function (values) {
        return apiPost(userApi(user, 'reject'), { reason: values.reason }).then(function () {
          toast('已拒绝「' + user.username + '」的申请', 'ok');
          refreshUsersSoon();
        }, function (err) {
          if (handleAuthError(err)) return;
          throw err;
        });
      }
    });
  }

  function askRole(user) {
    openDialog({
      title: '调整角色',
      desc: '「' + user.username + '」当前角色：' + roleLabel(user.role) + '。至少需要保留一个可用的管理员。',
      okText: '保存角色',
      fields: [{ name: 'role', label: '新角色', type: 'select', value: user.role, full: true,
        options: roleOptions(user.role) }],
      validate: function () { return ''; },
      onSubmit: function (values) {
        return apiPost(userApi(user, 'role'), { role: values.role }).then(function () {
          toast('「' + user.username + '」的角色已改为' + roleLabel(values.role), 'ok');
          refreshUsersSoon();
        }, function (err) {
          if (handleAuthError(err)) return;
          throw err;
        });
      }
    });
  }

  function askToggleStatus(user) {
    var disable = user.status === 'active';
    openDialog({
      title: disable ? '停用账号' : '启用账号',
      desc: disable
        ? '停用后「' + user.username + '」立刻不能登录，已登录的会话会在下次请求时被拒绝。'
        : '启用后「' + user.username + '」可以用原密码登录。',
      okText: disable ? '停用' : '启用',
      tone: disable ? 'danger' : 'primary',
      onSubmit: function () {
        return apiPost(userApi(user, 'status'), { status: disable ? 'disabled' : 'active' }).then(function () {
          toast(disable ? '已停用「' + user.username + '」' : '已启用「' + user.username + '」', 'ok');
          refreshUsersSoon();
        }, function (err) {
          if (handleAuthError(err)) return;
          throw err;
        });
      }
    });
  }

  function askResetPassword(user) {
    openDialog({
      title: '重置密码',
      desc: '重置「' + user.username + '」的密码：旧会话立即失效，对方需要用新密码重新登录。',
      okText: '重置密码',
      fields: [
        { name: 'password', label: '新密码', type: 'password', value: '', maxlength: 64, placeholder: '至少 6 位' },
        { name: 'password2', label: '确认新密码', type: 'password', value: '', maxlength: 64, placeholder: '再输入一次' }
      ],
      validate: function (values) {
        if (values.password.length < 6) return '密码至少 6 位';
        if (values.password !== values.password2) return '两次输入的密码不一致';
        return '';
      },
      onSubmit: function (values) {
        return apiPost(userApi(user, 'reset-password'), { password: values.password }).then(function () {
          toast('已重置「' + user.username + '」的密码', 'ok');
          refreshUsersSoon();
        }, function (err) {
          if (handleAuthError(err)) return;
          throw err;
        });
      }
    });
  }

  function showUserLogs(user) {
    state.logFilter.user = user.username || '';
    state.view = 'logs';
    renderConsole();
    loadLogs(true);
  }

  // -------------------------------------------------------------------------
  // 操作日志（GET /api/audit?limit=&user=&action=&from=&to=，契约 §12）
  //   admin 可筛选全员日志；其它角色只能看自己最近 50 条（服务端强制）
  // -------------------------------------------------------------------------
  var LOG_LIMITS = [50, 100, 200, 500, 1000, 2000];
  var logSeq = 0;

  function toIso(value) {
    var text = String(value || '').trim();
    if (!text) return '';
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) {
      var ms = parseTime(text);
      return ms == null ? '' : new Date(ms).toISOString();
    }
    return text;
  }

  function activeLogFilter() {
    var filter = state.logFilter;
    return {
      user: isAdmin() ? String(filter.user || '').trim() : '',
      action: isAdmin() ? String(filter.action || '') : '',
      from: isAdmin() ? toIso(filter.from) : '',
      to: isAdmin() ? toIso(filter.to) : '',
      limit: isAdmin() ? Number(filter.limit) || 200 : 50
    };
  }

  function loadLogs(resetPage) {
    if (resetPage) state.logPage = 1;
    var filter = activeLogFilter();
    var seq = ++logSeq;
    state.logsBusy = true;
    setLogsMeta('加载中…', true);
    var params = { limit: filter.limit };
    if (filter.user) params.user = filter.user;
    if (filter.action) params.action = filter.action;
    if (filter.from) params.from = filter.from;
    if (filter.to) params.to = filter.to;
    return apiGet('/api/audit' + qs(params), { timeoutMs: 20000 }).then(function (data) {
      if (seq !== logSeq) return null;
      state.logsBusy = false;
      var info = data || {};
      var entries = Array.isArray(info.entries) ? info.entries
        : (Array.isArray(info) ? info : []);
      state.logs = entries;
      state.logsTotal = Number(info.total) || entries.length;
      state.logsAt = Date.now();
      renderLogsTable();
      setLogsMeta('', false);
      emit('cv:logs-loaded', { count: entries.length, total: state.logsTotal });
      return entries;
    }, function (err) {
      if (seq !== logSeq) return null;
      state.logsBusy = false;
      setLogsMeta('加载失败：' + errMessage(err), false);
      if (err && err.status === 401) clearSession('登录已过期，请重新登录');
      return null;
    });
  }

  function setLogsMeta(text, busy) {
    var node = $('cvaLogsMeta');
    if (!node) return;
    if (busy) {
      node.textContent = text || '加载中…';
      node.className = 'cva-meta busy';
      return;
    }
    var filter = activeLogFilter();
    var parts = [];
    parts.push('共 ' + state.logsTotal + ' 条');
    if (state.logs.length && state.logs.length < state.logsTotal) parts.push('已取最近 ' + state.logs.length + ' 条');
    if (!isAdmin()) parts.push('仅本人 · 最近 50 条');
    else if (filter.user || filter.action || filter.from || filter.to) parts.push('已筛选');
    if (state.logsAt) parts.push(fmtShort(new Date(state.logsAt).toISOString()) + ' 刷新');
    node.textContent = parts.join(' · ');
    node.className = 'cva-meta';
  }

  function logActionMeta(action) {
    var meta = ACTION_META[action];
    if (!meta) return { label: action || '—', tone: '' };
    return { label: meta[0], tone: meta[1] };
  }

  function actionFilterOptions() {
    var html = '<option value="">全部动作</option>';
    for (var i = 0; i < ACTION_ORDER.length; i++) {
      var key = ACTION_ORDER[i];
      var meta = ACTION_META[key];
      html += '<option value="' + key + '"' + (state.logFilter.action === key ? ' selected' : '') + '>' +
        (meta ? meta[0] : key) + '</option>';
    }
    return html;
  }

  function limitFilterOptions() {
    var html = '';
    var current = Number(state.logFilter.limit) || 200;
    for (var i = 0; i < LOG_LIMITS.length; i++) {
      var value = LOG_LIMITS[i];
      html += '<option value="' + value + '"' + (current === value ? ' selected' : '') + '>' + value + ' 条</option>';
    }
    return html;
  }

  function datetimeValue(value) {
    if (!value) return '';
    var text = String(value);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return text;
    var ms = parseTime(text);
    if (ms == null) return '';
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function ensureLogStyles() {
    addStyle('cvaStyles5', [
      '.cva-log-time{white-space:nowrap;font-variant-numeric:tabular-nums;font-size:12px}',
      '.cva-log-detail{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cva-log-target{font-size:11.5px;color:#A8B6C6;word-break:break-all}',
      '.cva-log-fail{color:#F08387}',
      '.cva-pager .cva-spacer{flex:1}',
      '.cva-filterbar .cva-input{height:28px;font-size:12px}',
      '.cva-filterbar input[type="datetime-local"]{min-width:172px}',
      '.cva-log-actor{display:flex;align-items:center;gap:6px;white-space:nowrap}',
      '.cva-log-target{font-size:11.5px;color:#A8B6C6;word-break:break-all}',
      '.cva-log-detail{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cva-log-fail{color:#F08387}',
      '.cva-table td.num{text-align:right;font-variant-numeric:tabular-nums}',
    ].join('\n'));
    flushStyles();
  }

  function renderLogsView(body) {
    ensureLogStyles();
    var admin = isAdmin();
    var filter = state.logFilter;
    var html = '<div class="cva-filterbar">';
    if (admin) {
      html += '<input class="cva-input" id="cvaLogUser" placeholder="用户名或用户 ID" value="' +
        esc(filter.user || '') + '" />';
      html += '<select class="cva-input" id="cvaLogAction">' + actionFilterOptions() + '</select>';
      html += '<input class="cva-input" id="cvaLogFrom" type="datetime-local" title="起始时间" value="' +
        esc(datetimeValue(filter.from)) + '" />';
      html += '<input class="cva-input" id="cvaLogTo" type="datetime-local" title="结束时间" value="' +
        esc(datetimeValue(filter.to)) + '" />';
      html += '<select class="cva-input" id="cvaLogLimit">' + limitFilterOptions() + '</select>';
      html += '<button class="btn ghost small" type="button" id="cvaLogQuery">查询</button>';
      html += '<button class="btn ghost small" type="button" id="cvaLogReset">重置</button>';
    }
    html += '<span class="cva-spacer"></span><span class="cva-meta" id="cvaLogsMeta">—</span></div>';
    html += '<div class="cva-note">' + (admin
      ? '管理员可查看全员日志；用户名与动作按完全匹配过滤，时间区间取本地时间。'
      : '当前账号不是管理员：只能查看自己的最近 50 条操作，筛选不可用。') + '</div>';
    html += '<div class="cva-tablewrap"><table class="cva-table"><thead><tr>' +
      '<th>时间</th><th>账号</th><th>动作</th><th>对象</th><th>详情</th><th>IP</th>' +
      '<th style="text-align:right">耗时</th></tr></thead>' +
      '<tbody id="cvaLogsBody"></tbody></table></div>';
    html += '<div class="cva-pager"><span id="cvaLogsPageText">—</span>' +
      '<span class="cva-spacer"></span>' +
      '<button class="btn ghost small" type="button" id="cvaLogsPrev">上一页</button>' +
      '<button class="btn ghost small" type="button" id="cvaLogsNext">下一页</button></div>';
    body.innerHTML = html;
    if (admin) {
      var userInput = $('cvaLogUser');
      if (userInput) userInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.keyCode === 13) applyLogFilters();
      });
      var query = $('cvaLogQuery');
      if (query) query.addEventListener('click', applyLogFilters);
      var reset = $('cvaLogReset');
      if (reset) reset.addEventListener('click', function () {
        state.logFilter.user = '';
        state.logFilter.action = '';
        state.logFilter.from = '';
        state.logFilter.to = '';
        state.logFilter.limit = 200;
        renderConsole();
        loadLogs(true);
      });
    }
    var prev = $('cvaLogsPrev');
    if (prev) prev.addEventListener('click', function () { turnLogPage(-1); });
    var next = $('cvaLogsNext');
    if (next) next.addEventListener('click', function () { turnLogPage(1); });
    renderLogsTable();
    setLogsMeta('', false);
  }

  function applyLogFilters() {
    state.logFilter.user = $('cvaLogUser') ? $('cvaLogUser').value : '';
    state.logFilter.action = $('cvaLogAction') ? $('cvaLogAction').value : '';
    state.logFilter.from = $('cvaLogFrom') ? $('cvaLogFrom').value : '';
    state.logFilter.to = $('cvaLogTo') ? $('cvaLogTo').value : '';
    state.logFilter.limit = $('cvaLogLimit') ? Number($('cvaLogLimit').value) || 200 : 200;
    loadLogs(true);
  }

  function turnLogPage(delta) {
    var pages = logPageCount();
    var next = state.logPage + delta;
    if (next < 1) next = 1;
    if (next > pages) next = pages;
    if (next === state.logPage) return;
    state.logPage = next;
    renderLogsTable();
  }

  function logPageCount() {
    return Math.max(1, Math.ceil(state.logs.length / state.logPageSize));
  }

  function logRowHtml(entry) {
    var row = entry || {};
    var meta = logActionMeta(row.action);
    var failed = row.ok === false || row.action === 'login_failed';
    var roleCls = 'cva-badge ' +
      (row.role === 'admin' ? 'admin' : row.role === 'editor' ? 'editor' : 'viewer');
    var detail = row.detail == null ? '' : String(row.detail);
    var html = '<tr>';
    html += '<td class="cva-log-time">' + esc(fmtDateTime(row.at)) + '</td>';
    html += '<td><div class="cva-log-actor"><span>' + esc(row.username || '—') + '</span>' +
      (row.role ? '<span class="' + roleCls + '">' + esc(roleLabel(row.role)) + '</span>' : '') + '</div></td>';
    html += '<td><span class="cva-tag' + (failed ? ' cva-log-fail' : '') + '">' + esc(meta.label) + '</span></td>';
    html += '<td><div class="cva-log-target">' + (row.target ? esc(row.target) : '—') + '</div></td>';
    html += '<td><div class="cva-log-detail" title="' + esc(detail) + '">' +
      (detail ? esc(detail) : '—') + '</div></td>';
    html += '<td class="cva-log-target">' + (row.ip ? esc(row.ip) : '—') + '</td>';
    html += '<td class="num">' + (row.ms == null ? '—' : esc(String(row.ms)) + ' ms') + '</td>';
    html += '</tr>';
    return html;
  }

  function renderLogsTable() {
    var body = $('cvaLogsBody');
    if (!body) return;
    var total = state.logs.length;
    var size = state.logPageSize || 50;
    var pages = logPageCount();
    if (state.logPage > pages) state.logPage = pages;
    var start = (state.logPage - 1) * size;
    var slice = state.logs.slice(start, start + size);
    if (!slice.length) {
      body.innerHTML = '<tr><td colspan="7"><div class="cva-empty">' +
        (isAdmin() ? '暂无操作日志' : '暂无记录：非管理员仅显示本人最近 50 条操作') +
        '</div></td></tr>';
    } else {
      var html = '';
      for (var i = 0; i < slice.length; i++) html += logRowHtml(slice[i]);
      body.innerHTML = html;
    }
    var pageText = $('cvaLogsPageText');
    if (pageText) {
      if (total) {
        pageText.textContent = '第 ' + state.logPage + ' / ' + pages + ' 页 · ' +
          (start + 1) + '–' + (start + slice.length) + ' / 共 ' + state.logsTotal + ' 条';
      } else {
        pageText.textContent = '共 0 条';
      }
    }
    var prev = $('cvaLogsPrev');
    if (prev) prev.disabled = state.logPage <= 1;
    var next = $('cvaLogsNext');
    if (next) next.disabled = state.logPage >= pages;
  }

  // -------------------------------------------------------------------------
  // 启动：样式、权限态、登录页注册入口、定时刷新、外部事件
  // -------------------------------------------------------------------------
  function layerOpen(id) {
    var node = $(id);
    return !!node && node.hidden === false;
  }

  function bindEscape() {
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' && event.keyCode !== 27) return;
      if (layerOpen('cvaDialogLayer')) {
        if (!dialogState.busy) closeDialog();
        event.stopPropagation();
        return;
      }
      if (layerOpen('cvaRegisterLayer')) {
        closeRegister(false);
        return;
      }
      if (state.consoleOpen) {
        closeConsole();
      }
    });
  }

  function safeRefresh(reason) {
    if (!getAdapter()) return;
    if (!hasToken()) return;
    refreshSession().then(function () {
      return null;
    }, function (err) {
      if (err && err.status === 401) return;
      /* 网络抖动不打扰用户，等下一次刷新 */
    });
  }

  function hasToken() {
    var adapter = getAdapter();
    if (adapter && typeof adapter.token === 'function') {
      try { return !!adapter.token(); } catch (err) { return false; }
    }
    return !!lsGet(TOKEN_KEY);
  }

  function watchLoginState() {
    var screen = $('loginScreen');
    if (!screen || !window.MutationObserver) return;
    var lastHidden = !!screen.hidden;
    var observer = new MutationObserver(function () {
      var hidden = !!screen.hidden;
      if (hidden === lastHidden) return;
      lastHidden = hidden;
      if (hidden) {
        safeRefresh('login-success');
        return;
      }
      // 登录页重新出现：清掉管理端视角，避免残留上个账号的权限
      if (sessionState.role) clearSession(sessionState.error || '');
    });
    observer.observe(screen, { attributes: true, attributeFilter: ['hidden', 'class'] });
    if (lastHidden) safeRefresh('boot');
  }

  function startSessionPoll() {
    window.setInterval(function () {
      if (document.hidden) return;
      if (!hasToken()) return;
      if (state.consoleOpen && state.usersBusy) return;
      if (sessionState.role) safeRefresh('poll');
      else if (!sessionState.loaded) safeRefresh('poll-first');
    }, 60000);
  }

  function bindWindowEvents() {
    window.addEventListener('cv:must-login', function () {
      clearSession('登录已过期，请重新登录');
    });
    window.addEventListener('cv:session', function (event) {
      var detail = event && event.detail;
      if (detail && (detail.role || detail.username || detail.user)) setSession(detail);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (state.consoleOpen && state.view === 'users' && isAdmin()) loadUsers({ silent: true });
    });
  }

  function init() {
    injectStyles();
    bindWriteGuard();
    bindEscape();
    watchLoginScreen();
    watchLoginState();
    bindWindowEvents();
    startSessionPoll();
    state.ready = true;
    flushStyles();
    emit('cv:admin-ready', { version: VERSION });
  }

  window.CVAdminUI = {
    version: VERSION,
    setSession: setSession,
    clearSession: clearSession,
    refreshSession: refreshSession,
    setBase: setBase,
    openUsers: function () { openConsole('users'); },
    openAudit: function () { openConsole('logs'); },
    openRegister: openRegister,
    closeAll: function () { closeDialog(); closeRegister(true); closeConsole(); },
    session: function () { return normalizeSession(sessionState); },
    state: state
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

