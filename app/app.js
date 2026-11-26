// CertVault v1 · 前端接线层（app.js）
// 职责：把 index.html 的界面接到 core.js（纯逻辑）与 store.js（文件系统能力）上。
// 约束：1) 只使用契约 §5 列出的 id；2) 浮层显隐统一用 .open 类；
//      3) 所有异常转成中文 toast，绝不白屏；4) 未连接文件夹时用内置 17 条演示数据渲染，
//      任何写操作先引导用户选择数据文件夹（Store.pick）。
// 依赖：core.js（契约 §3）与 store.js（契约 §4），不在本文件重复实现逻辑。
// 注意：本文件刻意不使用模板字符串，避免与构建/注入流程冲突；字符串拼接统一用 + 号。

// 依赖加载方式：core.js 与 store.js 以 classic script 方式先于本文件加载，
// 分别把纯逻辑与文件系统能力挂在 window.CVCore / window.CVStore 上。
// 原因：Edge/Chrome 在 file:// 协议下会拦截外部 type=module 脚本（CORS），
// 改用 classic script + 全局命名空间后，双击 index.html 即可运行、无需启动参数。
(function () {
  'use strict';

  const coreApi = window.CVCore;
  const storeApi = window.CVStore;
  if (!coreApi || !storeApi) {
    const bar = document.getElementById('lockBanner');
    if (bar) bar.hidden = false;
    throw new Error('依赖脚本未加载：core.js / store.js 必须先于 app.js 以 classic script 引入');
  }

  const { DEFAULT_REMIND_DAYS, todayStr, statusOf, summarize, normalizeRecord, toCsv, fromCsv, mergeImport, REGIONS, REGION_GEO, REGION_ALIAS, guessRegion, normalizeRegion } = coreApi;
  const { Store, downloadText, pickTextFile } = storeApi;

  // 服务器（NAS）模式适配器：可选加载；未加载时行为与本地文件夹模式完全一致
  const httpApi = window.CVStoreHttp || null;
  // 多地址探测与地址簿（契约 §9）：可选加载；缺失时退化为 t2 的单地址探测
  const endpointsApi = window.CVServerEndpoints || null;

// ---------- 常量 ----------
const DEFAULT_SETTINGS = {
  trayMinimize: true,
  autostart: false,
  popupIntervalHours: 12,
  backupBeforeDanger: true,
  lastPopupAt: null,
  lastOpen: null,
  colWidths: null, // 列宽自定义（{ ck: 40, url: 260, ... }，null = 全部默认）
};
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 与 store.addImages 的单张 8MB 限制保持一致
const MAX_IMAGES = 8; // 每条记录最多 8 张截图（与 excel.js PHOTO_MAX 同口径，避免导出静默丢图）
const DAILY_BACKUP_MS = 24 * 60 * 60 * 1000; // 超过 24 小时没有备份时，启动自动留一份 daily
const TOAST_MS = 2600;
const CLIPBOARD_CLEAR_MS = 30000;
const REMIND_CHECK_MS = 15 * 60 * 1000;
const BOM = '\ufeff';

// 浮层 id：需要 scrim 遮罩的那几个
const SCRIM_LAYERS = ['drawer', 'settingsPanel', 'logPanel', 'modal', 'remindModal', 'cvDialog'];

// ---------- 全局状态（仅内存，不落盘） ----------
const state = {
  mode: 'demo', // demo = 演示数据；fs = 已连接数据文件夹
  store: null,
  records: [],
  settings: Object.assign({}, DEFAULT_SETTINGS),
  audit: [],
  filter: 'all', // all | over | soon | none
  view: 'table', // table | map
  region: '', // 地区筛选（短名，如 内蒙古）
  q: '',
  selected: new Set(),
  showPwd: false,
  openId: null,
  editId: null,
  existingImages: [],
  pendingUploads: [],
  removedImages: [],
  objectUrls: [],
  thumbGen: 0,
  drawerGen: 0,
  drawerUrls: [],
  lastActive: null,
  lastBackup: '',
  remindTimer: 0,
  saving: false,
  deleting: false,
};

const overlayStack = [];
let toastTimer = 0;
let ctxTargetId = null;
let serverBase = ''; // 服务器模式基址（'' = 未启用服务器模式）
let serverConfig = null; // /api/config/public 或 /api/health 返回的服务器信息

const $ = (id) => document.getElementById(id);

// ---------- 通用小工具 ----------
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 取网址的域名部分做副标题（去掉协议与 www.）
function hostOf(url) {
  let text = String(url || '').trim();
  if (!text) return '';
  text = text.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  text = text.replace(/^www\./i, '');
  const cut = text.split('/')[0].split('?')[0].split('#')[0];
  return cut;
}

// 密码掩码：按长度给 6~10 个圆点，不泄漏真实长度
function mask(value) {
  const text = String(value == null ? '' : value);
  if (!text) return '';
  const dots = Math.max(6, Math.min(10, text.length));
  return new Array(dots + 1).join('•');
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// 秒级时间显示；withDate = true 时带日期
function fmtTime(value, withDate) {
  const date = value instanceof Date ? value : new Date(value);
  if (!date || Number.isNaN(date.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  const clock = pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  if (!withDate) return clock;
  return todayStr(date) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

// YYYYMMDD-HHmm，用于导出文件名
function stampNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
}

function toast(message, actionLabel, action) {
  const el = $('toast');
  if (!el) return;
  el.textContent = '';
  const text = document.createElement('span');
  text.textContent = String(message == null ? '' : message);
  el.appendChild(text);
  if (actionLabel && typeof action === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toastact';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      el.classList.remove('open');
      action();
    });
    el.appendChild(btn);
    el.classList.add('hasact');
  } else {
    el.classList.remove('hasact');
  }
  el.classList.add('open');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.remove('open');
    toastTimer = 0;
  }, TOAST_MS);
}

// 统一异常出口：中文 toast + 在 <html> 上留痕（便于无头自检定位）
function reportError(err) {
  const message = err && err.message ? err.message : String(err || '未知异常');
  document.documentElement.setAttribute('data-cv-error', message.slice(0, 300));
  toast('出错了：' + message);
}

// 事件绑定包装：同步抛错和 Promise 拒绝都走 reportError
function on(target, type, handler, options) {
  if (!target) return;
  target.addEventListener(type, (event) => {
    try {
      const result = handler(event);
      if (result && typeof result.catch === 'function') result.catch(reportError);
    } catch (err) {
      reportError(err);
    }
  }, options);
}

// ---------- 浮层（.open 类 + scrim） ----------
function needsScrim(el) {
  return !!el && SCRIM_LAYERS.indexOf(el.id) >= 0;
}

function syncScrim() {
  const scrim = $('scrim');
  if (!scrim) return;
  const visible = overlayStack.some((el) => needsScrim(el));
  scrim.classList.toggle('open', visible);
}

function showOverlay(el) {
  if (!el) return;
  el.classList.add('open');
  if (el.getAttribute('aria-hidden') === 'true') el.setAttribute('aria-hidden', 'false');
  if (overlayStack.indexOf(el) < 0) overlayStack.push(el);
  syncScrim();
}

function hideOverlay(el) {
  if (!el) return;
  el.classList.remove('open');
  if (el.getAttribute('aria-hidden') === 'false') el.setAttribute('aria-hidden', 'true');
  const index = overlayStack.indexOf(el);
  if (index >= 0) overlayStack.splice(index, 1);
  syncScrim();
}

// 关闭最上层浮层；确认框按「取消」走，避免 Promise 悬空
function closeTopOverlay() {
  const el = overlayStack[overlayStack.length - 1];
  if (!el) return false;
  if (el.id === 'ctxMenu') {
    hideCtxMenu();
    return true;
  }
  if (el.id === 'cvDialog') {
    const cancel = el.querySelector('[data-role="cancel"]');
    if (cancel) cancel.click();
    return true;
  }
  if (el.id === 'drawer') { closeDrawer(); return true; }
  if (el.id === 'modal') { closeEditor(); return true; }
  hideOverlay(el);
  return true;
}

function revokeObjectUrls() {
  state.objectUrls.forEach((url) => {
    try { URL.revokeObjectURL(url); } catch (err) { /* 忽略 */ }
  });
  state.objectUrls = [];
}

// ---------- 内置演示数据（取自 prototype/v3.html，共 17 条） ----------
// expiryOff = 相对今天的自然日偏移：演示数据永远保持「逾期 / 提醒中 / 未登记」三态可见。
const DEMO_RAW = [
  { name: "示例平台 01 · 招标信息网", url: "https://demo-01.example.com/", account: "demo01", password: "demo-pass-01", caPassword: "", expiryOff: null, remindDays: 60, note: "演示数据", shots: 0 },
  { name: "示例平台 02 · 公共资源交易", url: "https://demo-02.example.com/", account: "demo02", password: "demo-pass-02", caPassword: "ca-demo-02", expiryOff: null, remindDays: 60, note: "演示数据", shots: 1 },
  { name: "示例平台 03 · 产权交易", url: "https://demo-03.example.com/", account: "demo03", password: "demo-pass-03", caPassword: "", expiryOff: null, remindDays: 60, note: "演示数据", shots: 1 },
  { name: "示例平台 04 · 电子招投标", url: "https://demo-04.example.com/", account: "demo04", password: "", caPassword: "", expiryOff: null, remindDays: 60, note: "演示数据", shots: 0 },
  { name: "示例平台 05 · 项目管理", url: "https://demo-05.example.com/", account: "demo05", password: "demo-pass-05", caPassword: "", expiryOff: null, remindDays: 60, note: "演示数据", shots: 1 },
  { name: "示例平台 06 · 认证中心", url: "https://demo-06.example.com/", account: "demo06", password: "demo-pass-06", caPassword: "", expiryOff: null, remindDays: 60, note: "演示数据", shots: 0 },
  { name: "示例平台 07 · 认证服务", url: "https://demo-07.example.com/", account: "demo07", password: "demo-pass-07", caPassword: "", expiryOff: null, remindDays: 60, note: "演示数据", shots: 0 },
  { name: "示例平台 08 · 招标代理", url: "https://demo-08.example.com/", account: "demo08", password: "demo-pass-08", caPassword: "", expiryOff: null, remindDays: 60, note: "演示数据", shots: 0 },
  { name: "示例平台 09 · 合同签订", url: "https://demo-09.example.com/", account: "demo09", password: "demo-pass-09", caPassword: "", expiryOff: null, remindDays: 60, note: "演示数据", shots: 1 },
  { name: "示例平台 10 · 电力采购", url: "https://demo-10.example.com/", account: "demo10", password: "demo-pass-10", caPassword: "ca-demo-10", expiryOff: -276, remindDays: 60, note: "演示数据", shots: 0, remindOff: true },
  { name: "示例平台 11 · 电子商务", url: "https://demo-11.example.com/", account: "demo11", password: "demo-pass-11", caPassword: "", expiryOff: -276, remindDays: 60, note: "演示数据", shots: 0 },
  { name: "示例平台 12 · 采购平台", url: "https://demo-12.example.com/", account: "demo12", password: "", caPassword: "", expiryOff: -197, remindDays: 60, note: "演示数据", shots: 2 },
  { name: "示例平台 13 · 公共资源", url: "https://demo-13.example.com/", account: "demo13", password: "demo-pass-13", caPassword: "", expiryOff: -59, remindDays: 60, note: "演示数据", shots: 0 },
  { name: "示例平台 14 · 电子交易", url: "https://demo-14.example.com/", account: "demo14", password: "demo-pass-14", caPassword: "", expiryOff: -13, remindDays: 60, note: "演示数据", shots: 0 },
  { name: "示例平台 15 · 集团门户", url: "https://demo-15.example.com/", account: "demo15", password: "demo-pass-15", caPassword: "ca-demo-15", expiryOff: 27, remindDays: 60, note: "演示数据", shots: 1 },
  { name: "示例平台 16 · 政府采购", url: "https://demo-16.example.com/", account: "demo16", password: "demo-pass-16", caPassword: "ca-demo-16", expiryOff: 37, remindDays: 60, note: "演示数据", shots: 1 },
  { name: "示例平台 17 · 电子交易（二）", url: "https://demo-17.example.com/", account: "demo17", password: "demo-pass-17", caPassword: "ca-demo-17", expiryOff: 39, remindDays: 60, note: "演示数据", shots: 0 },
];

// 演示数据的地区（显式指定，保证首屏地图有内容；新增记录走每条的「识别」按钮或手动选择）
const DEMO_REGION = {
  "示例平台 01 · 招标信息网": "上海",
  "示例平台 02 · 公共资源交易": "江苏",
  "示例平台 03 · 产权交易": "内蒙古",
  "示例平台 04 · 电子招投标": "江苏",
  "示例平台 05 · 项目管理": "河南",
  "示例平台 06 · 认证中心": "北京",
  "示例平台 07 · 认证服务": "北京",
  "示例平台 08 · 招标代理": "广东",
  "示例平台 09 · 合同签订": "江苏",
  "示例平台 10 · 电力采购": "内蒙古",
  "示例平台 11 · 电子商务": "内蒙古",
  "示例平台 12 · 采购平台": "北京",
  "示例平台 13 · 公共资源": "广西",
  "示例平台 14 · 电子交易": "湖南",
  "示例平台 15 · 集团门户": "浙江",
  "示例平台 16 · 政府采购": "辽宁",
  "示例平台 17 · 电子交易（二）": "北京",
};

// 相对今天偏移 n 天的 YYYY-MM-DD（用中午避开夏令时边界）
function dateOffset(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + Number(n));
  return todayStr(d);
}

function buildDemoRecords() {
  return DEMO_RAW.map((item, index) => {
    const images = [];
    for (let k = 0; k < (item.shots || 0); k += 1) {
      images.push({
        file: 'demo-' + (index + 1) + '-' + (k + 1) + '.png',
        w: 0,
        h: 0,
        size: 0,
        addedAt: '',
      });
    }
    return normalizeRecord({
      id: 'r_demo' + String(index + 1).padStart(2, '0'),
      name: item.name,
      url: item.url,
      account: item.account,
      password: item.password,
      caPassword: item.caPassword,
      expiry: item.expiryOff === null ? '' : dateOffset(item.expiryOff),
      remindDays: item.remindDays,
      note: item.note,
      region: item.region || DEMO_REGION[item.name] || guessRegion(item.name, item.url, item.note),
      images,
      remindOff: item.remindOff === true,
    });
  });
}

// ---------- 渲染：KPI / 筛选 / 表格 / 状态栏 / 顶栏 ----------
function renderKpis() {
  const sum = summarize(state.records, new Date());
  $('kpiTotal').textContent = String(sum.total);
  $('kpiOver').textContent = String(sum.over);
  $('kpiSoon').textContent = String(sum.soon);
  $('kpiNone').textContent = String(sum.none);
  // 卡片本身就是筛选项：与顶部标签联动高亮
  Array.prototype.forEach.call(document.querySelectorAll('.kpi'), (card) => {
    const key = card.getAttribute('data-kpi');
    const on = state.filter !== 'all' && key === state.filter;
    card.classList.toggle('on', on);
    card.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

// KPI 卡片被点击：切到台账并把对应状态作为筛选
function applyKpiFilter(key) {
  if (!key) return;
  state.filter = key === 'all' ? 'all' : key;
  closeRegionMenu();
  if (state.view !== 'table') setView('table');
  renderKpis();
  renderTabs();
  renderTable();
  renderStatusBar();
  const label = { all: '全部', over: '已逾期', soon: '提醒中', none: '未登记' }[state.filter] || '全部';
  toast('筛选：' + label + '（' + getFilteredLength(state.filter) + ' 条）');
}

function getFilteredLength(filterKey) {
  const keep = state.filter;
  state.filter = filterKey;
  const n = getFiltered().length;
  state.filter = keep;
  return n;
}

function renderTabs() {
  const sum = summarize(state.records, new Date());
  const counts = { all: sum.total, over: sum.over, soon: sum.soon, none: sum.none };
  const tabs = document.querySelectorAll('#tabs .tab');
  Array.prototype.forEach.call(tabs, (tab) => {
    const key = tab.getAttribute('data-filter');
    tab.classList.toggle('on', key === state.filter);
    const cnt = tab.querySelector('.cnt');
    if (cnt) cnt.textContent = String(counts[key] || 0);
  });
}

// 当前搜索 + 筛选后的记录（行号 = 过滤后下标 + 1）
function getFiltered() {
  const now = new Date();
  const keyword = state.q.trim().toLowerCase();
  return state.records.filter((rec) => {
    if (state.filter !== 'all' && statusOf(rec, now).key !== state.filter) return false;
    if (state.region && regionShort(rec.region) !== state.region) return false;
    if (!keyword) return true;
    const hay = [rec.name, rec.url, rec.account, rec.note, rec.expiry, rec.region].join(' ').toLowerCase();
    return hay.indexOf(keyword) >= 0;
  });
}

function badgeHtml(rec) {
  const st = statusOf(rec, new Date());
  if (st.key === 'none') return '<span class="badge none">未登记</span>';
  if (st.key === 'over') return '<span class="badge over">逾期 <span class="d">' + (-st.days) + ' 天</span></span>';
  if (st.key === 'soon') return '<span class="badge soon">提醒 <span class="d">' + st.days + ' 天</span></span>';
  return '<span class="badge ok">正常 <span class="d">' + st.days + ' 天</span></span>';
}

// 复制按钮（data-field 供表格事件委托识别，行号+字段名决定复制什么）
function cpBtn(field, label) {
  const text = label || '复制';
  return '<button class="cp" type="button" data-field="' + field + '" title="' + text + '" aria-label="' + text + '">' +
    '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>' +
    '</button>';
}

// 密码 / CA 口令单元格：掩码 + 复制按钮
function secretHtml(value, field) {
  const text = String(value == null ? '' : value);
  if (!text) return '<span class="muted">—</span>';
  const shown = state.showPwd ? esc(text) : mask(text);
  return '<span class="secret"><span class="val">' + shown + '</span>' + cpBtn(field, '复制') + '</span>';
}

function rowHtml(rec, index) {
  const selected = state.selected.has(rec.id);
  const url = String(rec.url || '').trim();
  const host = hostOf(url);
  const urlCell = url
    ? '<span class="cpcell"><a href="' + esc(url) + '" target="_blank" rel="noopener" title="' + esc(url) + '">' + esc(url) + '</a>' +
      cpBtn('url', '复制网址') + '</span>'
    : '<span class="muted">—</span>';
  const accountCell = rec.account
    ? '<span class="cpcell"><span class="mono" title="' + esc(rec.account) + '">' + esc(rec.account) + '</span>' +
      cpBtn('account', '复制账户') + '</span>'
    : '<span class="muted">—</span>';
  const expiryCell = rec.expiry ? '<span class="mono">' + esc(rec.expiry) + '</span>' : '<span class="muted">—</span>';
  const shotCount = Array.isArray(rec.images) ? rec.images.length : 0;
  const shotCell = shotCount
    ? '<span class="shot"><span class="tb"></span><span class="c">' + shotCount + '</span></span>'
    : '<span class="muted">—</span>';
  const noteCell = rec.note ? esc(rec.note) : '<span class="muted">—</span>';
  const remindCell = rec.remindOff
    ? '<td class="remind off">已关闭</td>'
    : '<td class="remind">' + esc(rec.remindDays) + ' 天</td>';
  const tds = [
    '<td class="ck"><input type="checkbox" class="rowchk" aria-label="选择该行"' + (selected ? ' checked' : '') + ' /></td>',
    '<td class="idx">' + (index + 1) + '</td>',
    '<td class="name"><span class="n">' + esc(rec.name) + '</span>' +
      (host ? '<span class="u">' + esc(host) + '</span>' : '') + '</td>',
    '<td class="url" title="' + esc(url) + '">' + urlCell + '</td>',
    '<td class="mono" title="' + esc(rec.account) + '">' + accountCell + '</td>',
    '<td>' + secretHtml(rec.password, 'password') + '</td>',
    '<td>' + secretHtml(rec.caPassword, 'caPassword') + '</td>',
    '<td class="mono">' + expiryCell + '</td>',
    '<td>' + badgeHtml(rec) + '</td>',
    remindCell,
    '<td>' + shotCell + '</td>',
    '<td title="' + esc(rec.note) + '">' + noteCell + '</td>',
  ];
  return '<tr data-id="' + esc(rec.id) + '"' + (selected ? ' class="sel"' : '') + '>' + tds.join('') + '</tr>';
}

function renderTable() {
  const rows = getFiltered();
  const tbody = $('tbody');
  if (tbody) tbody.innerHTML = rows.map((rec, index) => rowHtml(rec, index)).join('');
  const empty = $('emptyState');
  if (empty) {
    empty.hidden = rows.length > 0;
    if (rows.length === 0) {
      const kw = String(state.q || '').trim();
      const parts = [];
      if (state.region) parts.push('地区「' + state.region + '」');
      if (kw) parts.push('关键词「' + kw + '」');
      if (state.filter && state.filter !== 'all') {
        const label = { over: '已逾期', soon: '提醒中', none: '未登记', ok: '正常' }[state.filter] || '';
        if (label) parts.push('状态「' + label + '」');
      }
      if (state.records.length === 0) {
        empty.textContent = '还没有记录。点左上角「新增」录入第一条，或用「Excel 导入」批量导入。';
      } else if (parts.length) {
        empty.textContent = '没有符合 ' + parts.join(' + ') + ' 的记录。点筛选条上的 × 或「全部」取消条件。';
      } else {
        empty.textContent = '没有匹配的记录。试试换个筛选条件或清空搜索。';
      }
    }
  }
  syncChkAll();
  updateToolbar();
}

function syncChkAll() {
  const box = document.querySelector('#table .chk-all');
  if (!box) return;
  const rows = getFiltered();
  let selectedVisible = 0;
  rows.forEach((rec) => { if (state.selected.has(rec.id)) selectedVisible += 1; });
  box.checked = rows.length > 0 && selectedVisible === rows.length;
  box.indeterminate = selectedVisible > 0 && selectedVisible < rows.length;
}

function updateToolbar() {
  const n = state.selected.size;
  const edit = $('btnEdit');
  const del = $('btnDelete');
  const cancelRemind = $('btnCancelRemind');
  const restoreRemind = $('btnRestoreRemind');
  if (edit) edit.disabled = n !== 1;
  if (del) del.disabled = n === 0;
  if (cancelRemind) cancelRemind.disabled = n === 0;
  if (restoreRemind) restoreRemind.disabled = n === 0;
}

function totalImageCount() {
  let count = 0;
  let bytes = 0;
  state.records.forEach((rec) => {
    const list = Array.isArray(rec.images) ? rec.images : [];
    count += list.length;
    list.forEach((img) => { bytes += Number(img.size) || 0; });
  });
  return { count, bytes };
}

function renderStatusBar() {
  $('sbCount').textContent = String(state.records.length);
  $('sbSel').textContent = String(state.selected.size);
  const filteredBox = $('sbFiltered');
  if (filteredBox) {
    const shown = getFiltered().length;
    const filtered = shown !== state.records.length;
    filteredBox.hidden = !filtered;
    if (filtered) $('sbFilteredN').textContent = String(shown);
  }
  $('sbDir').textContent = state.mode === 'fs' && state.store
    ? (state.store.kind === 'http' ? state.store.base : state.store.folderName)
    : '演示数据';
  const images = totalImageCount();
  $('sbImages').textContent = images.count + ' 张' + (images.bytes > 0 ? ' · ' + fmtSize(images.bytes) : '');
  const safe = $('sbSafe');
  if (state.mode === 'fs') {
    safe.textContent = '✓ 可安全拷走';
    safe.title = '所有数据都在所选文件夹内，整个文件夹拷走即可迁移';
  } else {
    safe.textContent = '演示模式 · 不写盘';
    safe.title = '当前显示内置演示数据，保存前需要先选择数据文件夹';
  }
  const active = $('sbLastActive');
  active.textContent = state.lastActive ? fmtTime(state.lastActive) : '—';
  active.title = state.lastActive ? fmtTime(state.lastActive, true) : '';
}

function setLockBanner(show) {
  const el = $('lockBanner');
  if (el) el.hidden = !show;
}

function renderChip() {
  const chip = $('folderChip');
  const reconnect = $('btnReconnect');
  if (!chip) return;
  const pending = state.store && state.store.needsPermission;
  if (state.mode === 'fs' && state.store && !pending) {
    const isHttp = state.store.kind === 'http';
    chip.textContent = (isHttp ? '服务器：' : '数据文件夹：') + state.store.folderName;
    chip.title = isHttp
      ? '服务器地址：' + state.store.base + '（数据存放在 NAS 上）'
      : '数据目录：' + state.store.folderName + '（整个文件夹可拷走）';
    if (reconnect) reconnect.hidden = true;
    setLockBanner(false);
  } else if (pending) {
    chip.textContent = '演示数据 · 待授权';
    chip.title = '上次的数据文件夹需要重新授权，点右上角「重新授权」继续';
    if (reconnect) reconnect.hidden = false;
    setLockBanner(true);
  } else {
    chip.textContent = '演示数据 · 未连接文件夹';
    chip.title = '当前显示内置的 17 条示例数据，写入前需要选择数据文件夹';
    if (reconnect) reconnect.hidden = true;
    setLockBanner(false);
  }
}

// 待处理（逾期 / 提醒中，且未关闭提醒）的记录
function dueRecords() {
  const now = new Date();
  return state.records.filter((rec) => {
    const st = statusOf(rec, now);
    return (st.key === 'over' || st.key === 'soon') && rec.remindOff !== true;
  });
}

function renderBell() {
  const count = dueRecords().length;
  const badge = $('bellBadge');
  if (badge) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
  const btn = $('bellBtn');
  if (btn) btn.title = count ? '到期提醒：' + count + ' 条待处理' : '到期提醒（暂无到期记录）';
}

function renderAll() {
  document.documentElement.setAttribute('data-cv-mode', state.mode);
  renderChip();
  renderServerBadges();
  renderKpis();
  renderTabs();
  renderTable();
  applyColWidths();
  renderRegionChip();
  renderView();
  renderStatusBar();
  renderBell();
  updateToolbar();
}

// ---------- 地图视图（v1.1）：按「地区」字段做省域分布 ----------
const MAP_COLOR = {
  over: 'rgba(229,72,77,.62)',
  soon: 'rgba(224,178,60,.60)',
  ok: 'rgba(47,179,122,.55)',
  none: 'rgba(107,122,140,.50)',
  blank: '#1B2736',
};
let mapChart = null;

// 数据里统一存短名（北京 / 内蒙古）；导入的历史数据可能是全名，两种都兼容
function regionShort(value) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) return '';
  return normalizeRegion(text);
}

function regionStats() {
 const now = new Date();
  const map = new Map();
  state.records.forEach((rec) => {
    const key = regionShort(rec.region);
    if (!key) return;
    let entry = map.get(key);
    if (!entry) {
      entry = { name: key, total: 0, over: 0, soon: 0, ok: 0, none: 0, records: [] };
      map.set(key, entry);
    }
    const st = statusOf(rec, now);
    entry.total += 1;
    entry[st.key] = (entry[st.key] || 0) + 1;
    entry.records.push(rec);
  });
  return map;
}

function worstStatus(entry) {
  if (!entry) return '';
  if (entry.over) return 'over';
  if (entry.soon) return 'soon';
  if (entry.ok) return 'ok';
  if (entry.none) return 'none';
  return '';
}

function renderRegionChip() {
  const chip = $('regionChip');
  if (!chip) return;
  const text = $('regionChipText');
  if (state.region) {
    const count = state.records.filter((rec) => regionShort(rec.region) === state.region).length;
    if (text) text.textContent = '地区：' + state.region + '（' + count + ' 条）';
    chip.hidden = false;
  } else {
    chip.hidden = true;
  }
}

function renderView() {
  const isMap = state.view === 'map';
  const mapView = $('mapView');
  const tableWrap = document.querySelector('.tablewrap');
  if (mapView) mapView.hidden = !isMap;
  if (tableWrap) tableWrap.hidden = isMap;
  const seg = $('viewSeg');
  if (seg) {
    Array.prototype.forEach.call(seg.querySelectorAll('button'), (btn) => {
      const active = btn.getAttribute('data-view') === state.view;
      btn.classList.toggle('on', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }
  if (isMap) renderMap();
}

function setView(view) {
  state.view = view === 'map' ? 'map' : 'table';
  renderView();
}

function pickRegion(short) {
  const next = regionShort(short);
  state.region = state.region === next ? '' : next;
  renderRegionChip();
  renderTabs();
  renderTable();
  renderStatusBar();
  renderView();
}

function renderRegionList(stats) {
  const list = $('regionList');
  if (!list) return;
  const title = $('msTitle');
  const back = $('regionBack');
  const foot = $('mapFoot');
  const rows = Array.from(stats.values()).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const located = rows.reduce((sum, item) => sum + item.total, 0);
  const mt = $('mapTotal');
  if (mt) {
    mt.hidden = Boolean(state.region);
    mt.textContent = state.region ? '' : '已定位 ' + located + ' / ' + state.records.length + ' 条';
  }
  list.innerHTML = '';

  // 选中某个地区：右侧直接列出该地区的每条 CA，点开即看详情
  if (state.region) {
    if (title) title.textContent = '地区明细：' + state.region;
    if (back) back.hidden = false;
    if (foot) foot.textContent = '点一条看这笔 CA 的详情；再点地图上同一省份可取消筛选。';
    const rank = { over: 0, soon: 1, ok: 2, none: 3 };
    const recs = state.records
      .filter((rec) => regionShort(rec.region) === state.region)
      .slice()
      .sort((a, b) => {
        const sa = statusOf(a, new Date());
        const sb = statusOf(b, new Date());
        return (rank[sa.key] - rank[sb.key]) || String(a.name).localeCompare(String(b.name));
      });
    if (!recs.length) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.style.padding = '10px 12px';
      li.textContent = '这个地区还没有记录';
      list.appendChild(li);
      return;
    }
    recs.forEach((rec) => {
      const st = statusOf(rec, new Date());
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rrow detail';
      const nm = document.createElement('span');
      nm.className = 'nm';
      const dot = document.createElement('i');
      dot.className = 'sd';
      dot.style.background = st.key === 'over' ? 'var(--red)' : st.key === 'soon' ? 'var(--amber)' : st.key === 'ok' ? 'var(--green)' : 'var(--gray)';
      const name = document.createElement('b');
      name.textContent = rec.name || '（未命名）';
      nm.appendChild(dot);
      nm.appendChild(name);
      const meta = document.createElement('span');
      meta.className = 'meta';
      const bits = [rec.account, rec.expiry].filter(Boolean);
      meta.textContent = bits.length ? bits.join(' · ') : '未填账户 / 有效期';
      const bs = document.createElement('span');
      bs.className = 'bs';
      bs.innerHTML = badgeHtml(rec);
      btn.appendChild(nm);
      btn.appendChild(meta);
      btn.appendChild(bs);
      btn.addEventListener('click', () => openDrawer(rec.id));
      li.appendChild(btn);
      list.appendChild(li);
    });
    return;
  }

  if (title) title.textContent = '按地区汇总';
  if (back) back.hidden = true;
  if (foot) foot.textContent = '没有填写「地区」的记录不会出现在地图上，可在编辑弹窗里补。';
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.style.padding = '10px 12px';
    li.textContent = '还没有填写「地区」的记录';
    list.appendChild(li);
    return;
  }
  rows.forEach((entry) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rrow' + (state.region === entry.name ? ' on' : '');
    const nm = document.createElement('span');
    nm.className = 'nm';
    const dot = document.createElement('i');
    dot.className = 'sd';
    const worst = worstStatus(entry);
    dot.style.background = worst === 'over' ? 'var(--red)' : worst === 'soon' ? 'var(--amber)' : worst === 'ok' ? 'var(--green)' : 'var(--gray)';
    const name = document.createElement('b');
    name.textContent = entry.name;
    nm.appendChild(dot);
    nm.appendChild(name);
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = entry.total + ' 条';
    const bar = document.createElement('span');
    bar.className = 'barwrap';
    ['over', 'soon', 'ok', 'none'].forEach((key) => {
      if (!entry[key]) return;
      const seg = document.createElement('i');
      seg.className = key;
      seg.style.flex = String(entry[key]);
      bar.appendChild(seg);
    });
    btn.appendChild(nm);
    btn.appendChild(cnt);
    btn.appendChild(bar);
    btn.addEventListener('click', () => pickRegion(entry.name));
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function renderMap() {
  const box = $('mapCanvas');
  if (!box) return;
  if (!window.echarts || !window.CV_CHINA_GEO) {
    box.innerHTML = '<div style="padding:48px 24px;text-align:center;color:#99A7B8">地图组件未加载（vendor 下的 echarts.min.js / china-geo.js 缺失）。台账、提醒等其余功能不受影响。</div>';
    return;
  }
  const stats = regionStats();
  if (!mapChart) {
    window.echarts.registerMap('cvChina', window.CV_CHINA_GEO);
    mapChart = window.echarts.init(box, null, { renderer: 'canvas' });
    mapChart.on('click', (params) => {
      if (!params || !params.name) return;
      const short = regionShort(params.name);
      if (REGIONS.indexOf(short) < 0) return;
      pickRegion(short);
    });
  }
  const data = REGIONS.map((short) => {
    const entry = stats.get(short);
    return {
      name: REGION_GEO[short],
      value: entry ? entry.total : 0,
      itemStyle: { areaColor: MAP_COLOR[entry ? worstStatus(entry) : 'blank'] },
    };
  });
  mapChart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(16,24,36,.96)',
      borderColor: '#2B3A4D',
      borderWidth: 1,
      padding: [8, 11],
      textStyle: { color: '#E8EDF4', fontSize: 12 },
      formatter: (params) => {
        const short = regionShort(params.name);
        const entry = stats.get(short);
        if (!entry) return '<b>' + short + '</b><br/><span style="color:#6B7A8C">暂无记录</span>';
        const parts = [];
        if (entry.over) parts.push('<span style="color:#E5484D">已逾期 ' + entry.over + '</span>');
        if (entry.soon) parts.push('<span style="color:#E0B23C">提醒中 ' + entry.soon + '</span>');
        if (entry.ok) parts.push('<span style="color:#2FB37A">正常 ' + entry.ok + '</span>');
        if (entry.none) parts.push('<span style="color:#6B7A8C">未登记 ' + entry.none + '</span>');
        const names = entry.records.slice(0, 6).map((rec) => rec.name).filter(Boolean);
        const tail = entry.total > 6 ? '<br/>…' : '';
        return '<b>' + short + '</b>（' + entry.total + ' 条）<br/>' + parts.join(' · ') +
          (names.length ? '<div style="margin-top:6px;color:#99A7B8;max-width:280px;line-height:1.5">' + names.join('<br/>') + tail + '</div>' : '');
      },
    },
    series: [{
      type: 'map',
      map: 'cvChina',
      roam: true,
      zoom: 1,
      layoutCenter: ['50%', '50%'],
      layoutSize: '142%',
      selectedMode: false,
      label: {
        show: true,
        color: '#9FB0C6',
        fontSize: 10,
        formatter: (params) => {
          const short = regionShort(params.name);
          const entry = stats.get(short);
          return entry ? short + ' ' + entry.total : '';
        },
      },
      itemStyle: { areaColor: '#1B2736', borderColor: '#2B3A4D', borderWidth: 0.8 },
      emphasis: {
        label: { color: '#FFFFFF' },
        itemStyle: { areaColor: '#2A3A4F', borderColor: '#C9A45C', borderWidth: 1.2 },
      },
      data,
    }],
  }, true);
  if (mapChart.resize) mapChart.resize();
  renderRegionList(stats);
}

// ---------- 地区：可搜索组合框（输入即过滤，支持键盘上下选择） ----------
let regionHl = -1;

function regionMenuItems(keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return REGIONS.slice();
  return REGIONS.filter((name) => {
    const full = REGION_GEO[name] || '';
    return name.toLowerCase().indexOf(kw) >= 0 || full.toLowerCase().indexOf(kw) >= 0 ||
      (REGION_ALIAS[name] || []).join(' ').toLowerCase().indexOf(kw) >= 0;
  });
}

function renderRegionMenu(keyword) {
  const menu = $('fRegionMenu');
  if (!menu) return;
  const items = regionMenuItems(keyword);
  regionHl = items.length ? 0 : -1;
  if (!items.length) {
    menu.innerHTML = '<div class="comboEmpty">没有匹配的省份，可以直接手动输入</div>';
    return;
  }
  let html = '';
  items.forEach((name, index) => {
    html += '<button type="button" class="comboItem' + (index === regionHl ? ' hl' : '') + '" role="option" data-region="' + esc(name) + '">' +
      '<span>' + esc(name) + '</span><small>' + esc(REGION_GEO[name] || '') + '</small></button>';
  });
  menu.innerHTML = html;
}

function openRegionMenu() {
  const menu = $('fRegionMenu');
  const input = $('fRegion');
  if (!menu || !input) return;
  renderRegionMenu(input.value);
  menu.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function closeRegionMenu() {
  const menu = $('fRegionMenu');
  const input = $('fRegion');
  if (menu) menu.hidden = true;
  if (input) input.setAttribute('aria-expanded', 'false');
}

function pickRegionOption(name) {
  const input = $('fRegion');
  if (!input) return;
  input.value = name || '';
  closeRegionMenu();
}

function regionMenuKeydown(event) {
  const menu = $('fRegionMenu');
  const input = $('fRegion');
  if (!menu || !input) return;
  const items = menu.querySelectorAll('.comboItem');
  if (event.key === 'Escape') { closeRegionMenu(); return; }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (menu.hidden) { openRegionMenu(); return; }
    event.preventDefault();
    if (!items.length) return;
    regionHl = (regionHl + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    Array.prototype.forEach.call(items, (el, i) => el.classList.toggle('hl', i === regionHl));
    const hl = items[regionHl];
    if (hl && hl.scrollIntoView) hl.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (event.key === 'Enter') {
    if (menu.hidden) { openRegionMenu(); return; }
    event.preventDefault();
    const target = items[regionHl >= 0 ? regionHl : 0];
    if (target) pickRegionOption(target.getAttribute('data-region'));
  }
}

function fillRegionOptions() {
  renderRegionMenu('');
}

function guessRegionIntoForm() {
  const nameEl = $('fName');
  const urlEl = $('fUrl');
  const noteEl = $('fNote');
  const guess = guessRegion(nameEl ? nameEl.value : '', urlEl ? urlEl.value : '', noteEl ? noteEl.value : '');
  if (!guess) {
    toast('名称 / 网址 / 备注里没有识别到省份，请手动选择');
    return;
  }
  setFormValue('fRegion', guess);
  toast('已识别为：' + guess);
}

// ---------- 服务器模式（NAS）接入：?server=1 / 地址簿 / 同源 API ----------
// 只增加入口分支与登录遮罩，不改动既有业务函数；登录成功后复用 connectStore()，state.mode 仍是 'fs'。
function isHttpUrl(value) {
  const text = String(value == null ? '' : value).toLowerCase();
  return text.indexOf('http://') === 0 || text.indexOf('https://') === 0;
}

function bindLoginEvents() {
  on($('btnLogin'), 'click', handleLoginSubmit);
  const submitOnEnter = function (event) {
    if (event.key === 'Enter' || event.keyCode === 13) handleLoginSubmit();
  };
  on($('loginPass'), 'keydown', submitOnEnter);
  on($('loginServer'), 'keydown', submitOnEnter);
  on($('btnLoginLocal'), 'click', function () {
    // 明确选择本地模式：清掉服务器会话，回到演示/文件夹流程
    activateLocalMode();
    toast('已切换到本地模式');
  });
}

function showLoginScreen(message, base) {
  const screen = $('loginScreen');
  if (!screen) return;
  const serverInput = $('loginServer');
  if (serverInput && base) serverInput.value = base;
  const sub = $('loginSub');
  if (sub) sub.textContent = serverBase ? '登录到 ' + serverBase : '连接飞牛 NAS 上的 CertVault 服务';
  const errBox = $('loginError');
  if (errBox) {
    if (message) {
      errBox.textContent = String(message);
      errBox.hidden = false;
    } else {
      errBox.textContent = '';
      errBox.hidden = true;
    }
  }
  const offline = $('offlineScreen');
  if (offline) offline.hidden = true;
  screen.hidden = false;
  const user = $('loginUser');
  if (user && !user.value) {
    window.setTimeout(function () {
      try { user.focus(); } catch (err) { /* 忽略 */ }
    }, 40);
  }
}

function hideLoginScreen() {
  const screen = $('loginScreen');
  if (screen) screen.hidden = true;
  const errBox = $('loginError');
  if (errBox) {
    errBox.textContent = '';
    errBox.hidden = true;
  }
  const pass = $('loginPass');
  if (pass) pass.value = '';
}

async function handleLoginSubmit() {
  if (!httpApi) {
    toast('服务器适配器未加载：请确认 app/store-http.js 存在');
    return;
  }
  const serverInput = $('loginServer');
  let base = serverInput ? String(serverInput.value || '').trim() : '';
  if (!base) base = serverBase || (window.location.protocol.indexOf('http') === 0 ? window.location.origin : '');
  base = httpApi.normalizeBase(base);
  if (!isHttpUrl(base)) {
    showLoginScreen('服务器地址需要以 http:// 或 https:// 开头，例如 http://192.168.1.10:8090');
    return;
  }
  const user = ($('loginUser') && $('loginUser').value ? $('loginUser').value : '').trim();
  const pass = $('loginPass') ? $('loginPass').value : '';
  if (!user) {
    showLoginScreen('请输入账号');
    return;
  }
  if (!pass) {
    showLoginScreen('请输入密码');
    return;
  }
  const keepBox = $('loginKeep');
  const keep = !keepBox || keepBox.checked;
  let ttl = 3600;
  if (keep) {
    const ttlBox = $('loginTtl');
    const value = ttlBox ? Number(ttlBox.value) : 604800;
    ttl = value > 0 ? value : 604800;
  }
  const btn = $('btnLogin');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '登录中…';
  }
  try {
    const data = await httpApi.login(base, { user: user, password: pass, ttlSeconds: ttl });
    serverBase = base;
    rememberEndpoint(base);
    if (endpointsApi && typeof endpointsApi.setActive === 'function') endpointsApi.setActive(base);
    applyLoginSession(data || {}, user, keep, ttl);
    let config = null;
    try {
      const info = await httpApi.health(base);
      if (info && info.name) config = { name: String(info.name) };
    } catch (healthErr) {
      config = null;
    }
    serverConfig = config;
    await connectStore(httpApi.create(base, config || {}));
    hideLoginScreen();
    hideOfflineScreen();
    await refreshSessionInfo();
    startSessionTimer();
    renderServerBadges();
    toast('已登录服务器：' + state.store.folderName);
  } catch (err) {
    const msg = err && err.message ? err.message : '登录失败，请检查账号与密码';
    showLoginScreen(msg, base);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  }
}

// 收到 401 时由 store-http.js 回调：清 token 已在适配器里做，这里负责停计时并把登录遮罩叫回来
function handleServerUnauthorized() {
  if (!serverBase) return;
  setLockBanner(false);
  expireSession('登录已过期，请重新登录');
}

// ---------- 会话信息 / 顶栏徽标（契约 §10） ----------
let sessionInfo = null;
let sessionTimer = 0;
let endpointTestResults = Object.create(null); // base -> {ok, ms, reason}
let editingEndpoint = '';

const PERMANENT_TTL = 315360000;
const TTL_LABELS = { 86400: '1 天', 604800: '7 天', 2592000: '30 天', 315360000: '永久' };

function ttlLabel(ttl) {
  return TTL_LABELS[Number(ttl)] || (Number(ttl) >= PERMANENT_TTL ? '永久' : '7 天');
}

function readTtlPref() {
  try {
    const value = Number(window.localStorage.getItem('cv.ttl'));
    if (value > 0) return value;
  } catch (err) { /* 隐私模式可能禁用 localStorage */ }
  return 604800;
}

function saveTtlPref(ttl) {
  try { window.localStorage.setItem('cv.ttl', String(Number(ttl) || 604800)); } catch (err) { /* 忽略 */ }
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return isFinite(value) ? value : 0;
  const text = String(value).trim();
  const num = Number(text);
  if (text !== '' && isFinite(num)) return num;
  const parsed = Date.parse(text);
  return isNaN(parsed) ? 0 : parsed;
}

function isServerMode() {
  return !!(serverBase && state.store && state.store.kind === 'http');
}

function sessionUserName(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return String(value.username || value.displayName || value.name || value.id || '');
}

function formatRemaining(expiresAt, ttlSeconds) {
  if (Number(ttlSeconds) >= PERMANENT_TTL) return '永久';
  const ms = toMs(expiresAt) - Date.now();
  if (!expiresAt || ms <= 0) return '已过期';
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return minutes + ' 分钟';
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return hours + ' 小时';
  return Math.ceil(hours / 24) + ' 天';
}

function renderServerBadges() {
  const modeChip = $('serverModeChip');
  const acctChip = $('accountChip');
  const sessChip = $('sessionChip');
  if (!modeChip || !acctChip || !sessChip) return;
  if (!isServerMode()) {
    modeChip.hidden = true;
    acctChip.hidden = true;
    sessChip.hidden = true;
    return;
  }
  const kind = endpointsApi && typeof endpointsApi.hostKind === 'function'
    ? endpointsApi.hostKind(serverBase)
    : (httpApi && httpApi.isPrivateHost(serverBase) ? 'lan' : 'domain');
  modeChip.hidden = false;
  modeChip.textContent = kind === 'lan' ? '🏠 局域网' : '🌐 域名';
  modeChip.title = '当前地址：' + serverBase + (kind === 'lan' ? '（局域网直连）' : '（公网/域名访问）');

  const info = sessionInfo || {};
  acctChip.hidden = false;
  acctChip.textContent = info.user ? '账号：' + info.user : '账号：—';
  acctChip.title = info.role ? '角色：' + info.role : '正在读取会话信息';

  sessChip.hidden = false;
  const remaining = formatRemaining(info.expiresAt, info.ttlSeconds);
  sessChip.textContent = '会话剩余 ' + remaining;
  const left = toMs(info.expiresAt) - Date.now();
  sessChip.classList.toggle('warn', remaining !== '永久' && left > 0 && left < 24 * 3600 * 1000);
  sessChip.title = info.expiresAt ? '到期时间：' + fmtTime(new Date(toMs(info.expiresAt)), true) : '会话到期时间未知';
}

function stopSessionTimer() {
  if (sessionTimer) {
    window.clearInterval(sessionTimer);
    sessionTimer = 0;
  }
}

function startSessionTimer() {
  stopSessionTimer();
  if (!isServerMode()) return;
  sessionTimer = window.setInterval(function () {
    if (!isServerMode()) { stopSessionTimer(); renderServerBadges(); return; }
    if (sessionInfo && sessionInfo.expiresAt && toMs(sessionInfo.expiresAt) <= Date.now()) {
      expireSession('登录已过期，请重新登录');
      return;
    }
    renderServerBadges();
  }, 30000);
}

function expireSession(message) {
  stopSessionTimer();
  if (httpApi) httpApi.clearToken();
  sessionInfo = null;
  renderServerBadges();
  hideOfflineScreen();
  showLoginScreen(message || '登录已过期，请重新登录', serverBase);
}

async function refreshSessionInfo() {
  if (!(serverBase && httpApi && typeof httpApi.session === 'function' && httpApi.token())) return null;
  try {
    const data = await httpApi.session(serverBase);
    const userObj = data && data.user;
    sessionInfo = {
      user: sessionUserName(userObj) || sessionUserName(data && data.username) || ((sessionInfo && sessionInfo.user) || ''),
      role: (data && data.role) || (userObj && userObj.role) || ((sessionInfo && sessionInfo.role) || ''),
      expiresAt: toMs(data && data.expiresAt) || ((sessionInfo && sessionInfo.expiresAt) || 0),
      ttlSeconds: Number(data && data.ttlSeconds) || ((sessionInfo && sessionInfo.ttlSeconds) || readTtlPref()),
      idleTimeoutSeconds: data && data.idleTimeoutSeconds
    };
    renderServerBadges();
    if (isServerMode()) fillServerSettings();
    return sessionInfo;
  } catch (err) {
    if (err && err.status === 401) { expireSession('登录已过期，请重新登录'); return null; }
    if (window.console && typeof window.console.warn === 'function') {
      window.console.warn('[CertVault] 读取会话信息失败：' + (err && err.message ? err.message : err));
    }
    return null;
  }
}

// 登录成功后立即写 token（store-http.js 已写），这里只记录会话展示信息与“关闭即退出”标记
function applyLoginSession(data, user, keep, ttl) {
  const info = data || {};
  sessionInfo = {
    user: sessionUserName(info.user) || (info.user && info.user.username) || user || '',
    role: (info.role || (info.user && info.user.role)) ? String(info.role || info.user.role) : '',
    expiresAt: toMs(info.expiresAt),
    ttlSeconds: Number(info.ttlSeconds) || Number(ttl) || 0,
    idleTimeoutSeconds: info.idleTimeoutSeconds
  };
  try {
    if (keep) {
      window.localStorage.removeItem('cv.ephemeral');
      window.sessionStorage.removeItem('cv.sessionAlive');
    } else {
      window.localStorage.setItem('cv.ephemeral', '1');
      window.sessionStorage.setItem('cv.sessionAlive', '1');
    }
  } catch (err) { /* 存储不可用时交给浏览器默认策略 */ }
  saveTtlPref(Number(ttl) || 604800);
  renderServerBadges();
}

// 取消“保持登录”时，关闭浏览器/标签后下一次启动清掉旧 token（同一标签内刷新仍有效）
function clearStaleEphemeralToken() {
  if (!httpApi) return;
  try {
    if (window.localStorage.getItem('cv.ephemeral') !== '1') return;
    if (window.sessionStorage.getItem('cv.sessionAlive') === '1') return;
    if (httpApi.token()) httpApi.clearToken();
    window.localStorage.removeItem('cv.ephemeral');
  } catch (err) { /* 忽略 */ }
}

// 本地模式：清掉服务器会话，回到内置演示数据
function activateLocalMode() {
  hideLoginScreen();
  hideOfflineScreen();
  stopSessionTimer();
  serverBase = '';
  serverConfig = null;
  sessionInfo = null;
  if (httpApi) httpApi.clearToken();
  state.store = null;
  state.mode = 'demo';
  state.records = buildDemoRecords();
  state.lastActive = new Date();
  renderAll();
  applyHash();
}

// 地址簿读写统一走 server-endpoints.js；脚本缺失时退回 store-http.js 的最小实现
function readEndpointBook() {
  if (endpointsApi && typeof endpointsApi.endpoints === 'function') return endpointsApi.endpoints();
  if (httpApi && typeof httpApi.endpoints === 'function') return httpApi.endpoints();
  return [];
}

function rememberEndpoint(base) {
  if (!base) return;
  if (endpointsApi && typeof endpointsApi.addEndpoint === 'function') endpointsApi.addEndpoint(base);
  else if (httpApi && typeof httpApi.addEndpoint === 'function') httpApi.addEndpoint(base);
}

// ---------- 设置面板 · 服务器区（契约 §9/§10） ----------
function setServerStatus(text) {
  const el = $('svrStatus');
  if (el) el.textContent = text || '—';
}

function renderServerList() {
  const ul = $('svrList');
  if (!ul) return;
  const list = readEndpointBook();
  ul.textContent = '';
  if (!list.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '地址簿为空：请先添加 NAS 地址';
    ul.appendChild(empty);
    return;
  }
  list.forEach(function (base) {
    const li = document.createElement('li');
    const url = document.createElement('span');
    url.className = 'u mono';
    url.textContent = base;
    url.title = base;
    const st = document.createElement('span');
    st.className = 'st';
    const test = endpointTestResults[base];
    if (test) {
      st.textContent = test.ok ? '✓ ' + test.ms + ' ms' : '✗ ' + (test.reason || '连接失败');
      st.classList.add(test.ok ? 'ok' : 'bad');
    } else if (base === serverBase) {
      st.textContent = '当前';
      st.classList.add('ok');
    } else {
      st.textContent = '未检测';
    }
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'mini';
    edit.textContent = '修改';
    edit.setAttribute('data-act', 'edit');
    edit.setAttribute('data-base', base);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'mini';
    del.textContent = '删除';
    del.setAttribute('data-act', 'remove');
    del.setAttribute('data-base', base);
    li.appendChild(url);
    li.appendChild(st);
    li.appendChild(edit);
    li.appendChild(del);
    ul.appendChild(li);
  });
}

function fillServerSettings() {
  const card = $('serverCard');
  if (!card) return;
  const active = isServerMode();
  card.hidden = !active;
  if (!active) return;
  const current = $('svrCurrent');
  if (current) { current.textContent = serverBase; current.title = serverBase; }
  const info = sessionInfo || {};
  const acct = $('svrAccount');
  if (acct) acct.textContent = info.user ? (info.user + (info.role ? '（' + info.role + '）' : '')) : '—';
  const sess = $('svrSession');
  if (sess) {
    sess.textContent = info.expiresAt
      ? '剩余 ' + formatRemaining(info.expiresAt, info.ttlSeconds) + ' · ' + fmtTime(new Date(toMs(info.expiresAt)), true)
      : '—';
  }
  const ttl = $('svrTtl');
  if (ttl) {
    let value = info.ttlSeconds || readTtlPref();
    if (!TTL_LABELS[value]) value = readTtlPref();
    if (!TTL_LABELS[value]) value = 604800;
    ttl.value = String(value);
  }
  renderServerList();
}

function addServerAddress() {
  const input = $('svrNew');
  const raw = input ? String(input.value || '').trim() : '';
  if (!raw) { toast('请先输入服务器地址'); return; }
  const base = endpointsApi ? endpointsApi.normalizeBase(raw) : (httpApi ? httpApi.normalizeBase(raw) : raw);
  if (!isHttpUrl(base)) { toast('服务器地址需要以 http:// 或 https:// 开头'); return; }
  if (endpointsApi) {
    if (editingEndpoint) endpointsApi.updateEndpoint(editingEndpoint, base);
    else endpointsApi.addEndpoint(base);
  } else if (httpApi) {
    httpApi.addEndpoint(base);
  }
  const wasEditing = editingEndpoint;
  editingEndpoint = '';
  if (input) input.value = '';
  const btn = $('btnSvrAdd');
  if (btn) btn.textContent = '添加';
  renderServerList();
  setServerStatus((wasEditing ? '已修改：' : '已添加：') + base);
  toast('服务器地址已保存');
}

function onServerListClick(event) {
  const btn = event.target && event.target.closest ? event.target.closest('button[data-act]') : null;
  if (!btn) return;
  const base = btn.getAttribute('data-base') || '';
  const act = btn.getAttribute('data-act');
  if (act === 'edit') {
    editingEndpoint = base;
    const input = $('svrNew');
    if (input) { input.value = base; input.focus(); }
    const add = $('btnSvrAdd');
    if (add) add.textContent = '保存';
    setServerStatus('修改后点「保存」；删除当前地址不会中断已建立的连接');
    return;
  }
  if (act !== 'remove') return;
  if (endpointsApi) endpointsApi.removeEndpoint(base);
  else if (httpApi) httpApi.removeEndpoint(base);
  delete endpointTestResults[base];
  if (editingEndpoint === base) {
    editingEndpoint = '';
    const add = $('btnSvrAdd');
    if (add) add.textContent = '添加';
    const input = $('svrNew');
    if (input) input.value = '';
  }
  renderServerList();
  setServerStatus(base === serverBase ? '已从地址簿移除（当前会话仍连接 ' + base + '）' : '已移除：' + base);
  toast('已从地址簿移除');
}

async function testServerAddresses() {
  if (!endpointsApi) { toast('多地址探测脚本未加载：请确认 app/server-endpoints.js 存在'); return; }
  const list = endpointsApi.endpoints();
  if (!list.length) { toast('地址簿为空，请先添加地址'); return; }
  const btn = $('btnSvrTest');
  if (btn) { btn.disabled = true; btn.textContent = '检测中…'; }
  setServerStatus('正在并行检测 ' + list.length + ' 个地址…');
  try {
    const results = await endpointsApi.probeAll(list, { timeoutMs: 1200 });
    endpointTestResults = Object.create(null);
    results.forEach(function (item) { endpointTestResults[item.base] = item; });
    renderServerList();
    const okCount = results.filter(function (item) { return item.ok; }).length;
    setServerStatus('检测完成：' + okCount + ' / ' + list.length + ' 个地址可用');
    toast('地址检测完成：' + okCount + ' / ' + list.length + ' 可用');
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    setServerStatus('检测失败：' + message);
    toast('地址检测失败：' + message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '检测全部'; }
  }
}

async function changeSessionTtl() {
  const sel = $('svrTtl');
  const ttl = sel ? Number(sel.value) || 604800 : 604800;
  saveTtlPref(ttl);
  if (!(serverBase && httpApi && httpApi.token())) {
    toast('已记录会话时长偏好，下次登录生效');
    return;
  }
  if (sel) sel.disabled = true;
  try {
    const data = await httpApi.extendSession(serverBase, ttl);
    if (sessionInfo) {
      sessionInfo.ttlSeconds = ttl;
      sessionInfo.expiresAt = toMs(data && data.expiresAt) || sessionInfo.expiresAt;
    }
    await refreshSessionInfo();
    renderServerBadges();
    fillServerSettings();
    toast('会话时长已更新为 ' + ttlLabel(ttl));
  } catch (err) {
    toast('会话时长更新失败：' + (err && err.message ? err.message : err));
  } finally {
    if (sel) sel.disabled = false;
  }
}

async function logoutServer() {
  if (!serverBase) return;
  const btn = $('btnSvrLogout');
  if (btn) { btn.disabled = true; btn.textContent = '退出中…'; }
  try {
    if (httpApi) await httpApi.logout(serverBase);
  } catch (err) {
    if (httpApi) httpApi.clearToken();
  }
  sessionInfo = null;
  stopSessionTimer();
  state.store = null;
  state.mode = 'demo';
  state.records = buildDemoRecords();
  state.lastActive = new Date();
  hideOverlay($('settingsPanel'));
  renderAll();
  showLoginScreen('已退出登录', serverBase);
  toast('已退出登录');
  if (btn) { btn.disabled = false; btn.textContent = '退出登录'; }
}

// ---------- 全部地址不可达时的连接页（契约 §9.3） ----------
function showOfflineScreen(results, candidates) {
  const screen = $('offlineScreen');
  if (!screen) return;
  hideLoginScreen();
  const list = $('offlineList');
  if (list) {
    list.textContent = '';
    (results || []).forEach(function (item) {
      const li = document.createElement('li');
      const url = document.createElement('span');
      url.className = 'u mono';
      url.textContent = item.base;
      url.title = item.base;
      const st = document.createElement('span');
      st.className = 'st';
      if (item.ok) { st.textContent = '✓ ' + item.ms + ' ms'; st.classList.add('ok'); }
      else st.textContent = '✗ ' + (item.reason || '连接失败');
      li.appendChild(url);
      li.appendChild(st);
      list.appendChild(li);
    });
    if (!(results || []).length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '地址簿为空，请填写 NAS 地址';
      list.appendChild(empty);
    }
  }
  const sub = $('offlineSub');
  if (sub) sub.textContent = '已尝试 ' + ((results && results.length) || 0) + ' 个地址，均无法连接';
  const addr = $('offlineAddr');
  if (addr) {
    const first = candidates && candidates.length ? candidates[0] : serverBase;
    if (first) addr.value = first;
  }
  screen.hidden = false;
}

function hideOfflineScreen() {
  const screen = $('offlineScreen');
  if (screen) screen.hidden = true;
}

async function retryOffline() {
  const addr = $('offlineAddr');
  const raw = addr ? String(addr.value || '').trim() : '';
  if (raw) {
    const base = endpointsApi ? endpointsApi.normalizeBase(raw) : (httpApi ? httpApi.normalizeBase(raw) : raw);
    if (!isHttpUrl(base)) { toast('服务器地址需要以 http:// 或 https:// 开头'); return; }
    serverBase = base;
    rememberEndpoint(base);
  }
  hideOfflineScreen();
  const handled = await initServerMode(true);
  if (!handled) toast('服务器仍不可达，已保持本地模式');
}

// 启动入口：?server=1 或地址簿命中或页面本身由服务端托管时，启用服务器模式。
// force=true 表示“重试”按钮：跳过 5 分钟探测缓存；返回 true 表示服务器分支已接管。
async function initServerMode(force) {
  if (!httpApi) return false;
  let explicit = false;
  let paramBase = '';
  try {
    const params = new URLSearchParams(window.location.search || '');
    const raw = params.get('server');
    if (raw === '1') explicit = true;
    else if (raw && isHttpUrl(raw)) { explicit = true; paramBase = raw; }
    const rawBase = params.get('base');
    if (rawBase && isHttpUrl(rawBase)) paramBase = rawBase;
  } catch (err) { /* 老浏览器不支持 URLSearchParams：当作没有参数 */ }

  // 契约 §9.5：地址簿持久化（网页 localStorage('cv.endpoints') / 桌面 host.json.endpoints）
  if (endpointsApi && typeof endpointsApi.hydrate === 'function') {
    try { await endpointsApi.hydrate(!!force); } catch (err) { /* 地址簿读取失败不阻断连接 */ }
  }

  const sameOrigin = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  const candidates = [];
  const addCandidate = function (value) {
    const clean = httpApi.normalizeBase(value);
    if (clean && candidates.indexOf(clean) < 0) candidates.push(clean);
  };
  if (paramBase) addCandidate(paramBase);
  if (explicit && sameOrigin) addCandidate(window.location.origin);
  readEndpointBook().forEach(addCandidate);
  if (!explicit && !readEndpointBook().length) {
    if (!sameOrigin) return false; // file:// 且没有参数：完全走本地文件夹模式
    addCandidate(window.location.origin);
  }
  if (!candidates.length) {
    if (explicit) {
      showLoginScreen('请输入服务器地址后登录');
      return true;
    }
    return false;
  }

  let picked = null;
  try {
    picked = endpointsApi && typeof endpointsApi.pick === 'function'
      ? await endpointsApi.pick(candidates, { force: !!force })
      : await httpApi.pickEndpoint(candidates);
  } catch (err) {
    if (explicit) {
      serverBase = candidates[0];
      showOfflineScreen(err && err.results, candidates);
      return true;
    }
    // 地址簿里的地址全部不可达：安静退回本地模式，避免打断离线使用
    toast('服务器地址暂时连不上，已切换回本地模式');
    return false;
  }

  serverBase = picked.base;
  serverConfig = picked.config || null;
  rememberEndpoint(picked.base);
  if (endpointsApi && typeof endpointsApi.setActive === 'function') endpointsApi.setActive(serverBase);
  if (!httpApi.token()) {
    showLoginScreen('', picked.base);
    return true;
  }
  try {
    await connectStore(httpApi.create(picked.base, serverConfig || {}));
    hideLoginScreen();
    hideOfflineScreen();
    await refreshSessionInfo();
    startSessionTimer();
    renderServerBadges();
    return true;
  } catch (err) {
    if (err && err.status === 401) {
      showLoginScreen('登录已过期，请重新登录', picked.base);
      return true;
    }
    reportError(err);
    return explicit;
  }
}

if (httpApi && typeof httpApi.setUnauthorizedHandler === 'function') {
  httpApi.setUnauthorizedHandler(handleServerUnauthorized);
  if (typeof httpApi.setNetworkFailureHandler === 'function') {
    httpApi.setNetworkFailureHandler(function (err, url) {
      // 契约 §9.4：网络级失败（非 4xx/5xx）说明地址可能不可用，交给地址探测器标记并重探一次
      if (window.console && typeof window.console.warn === 'function') {
        window.console.warn('[CertVault] 网络请求失败：' + url + ' · ' + (err && err.message ? err.message : err));
      }
      if (endpointsApi && typeof endpointsApi.noteNetworkFailure === 'function') {
        try { endpointsApi.noteNetworkFailure(url || serverBase); } catch (e) { /* 探测失败不覆盖原始错误 */ }
      }
    });
  }
}

if (endpointsApi) {
  if (typeof endpointsApi.setReprobeHandler === 'function') {
    endpointsApi.setReprobeHandler(function () {
      toast('服务器连接中断，正在重新探测可用地址…');
    });
  }
  if (typeof endpointsApi.setEndpointChangeHandler === 'function') {
    endpointsApi.setEndpointChangeHandler(async function (picked) {
      if (!picked || !picked.base || picked.base === serverBase) return;
      serverBase = picked.base;
      serverConfig = picked.config || serverConfig;
      rememberEndpoint(serverBase);
      if (endpointsApi && typeof endpointsApi.setActive === 'function') endpointsApi.setActive(serverBase);
      if (!httpApi || !httpApi.token()) {
        showLoginScreen('', serverBase);
        return;
      }
      try {
        await connectStore(httpApi.create(serverBase, serverConfig || {}));
        hideLoginScreen();
        hideOfflineScreen();
        await refreshSessionInfo();
        startSessionTimer();
        renderServerBadges();
        toast('已切换到可用地址：' + serverBase);
      } catch (err) {
        if (err && err.status === 401) { expireSession('登录已过期，请重新登录'); return; }
        reportError(err);
      }
    });
  }
  if (typeof endpointsApi.setOfflineHandler === 'function') {
    endpointsApi.setOfflineHandler(function (err) {
      showOfflineScreen(err && err.results, err && err.candidates);
    });
  }
}

// ---------- 数据装载 / 连接文件夹 ----------
function findByRecord(id) {
  const target = state.records.filter((rec) => rec.id === id);
  return target.length ? target[0] : null;
}

async function loadFsData() {
  if (!state.store) return;
  const raw = await state.store.readRecords();
  const list = Array.isArray(raw) ? raw : [];
  state.records = list.map((rec) => normalizeRecord(rec));
  state.selected = new Set(Array.from(state.selected).filter((id) => findByRecord(id)));
  state.settings = await state.store.readSettings();
  state.audit = await state.store.readAudit();
  // 上次写入被中断时 store 会用残留 .tmp 恢复并补写正式文件，这里告诉用户一声
  if (state.store.lastRecovered) {
    const recovered = state.store.lastRecovered;
    state.store.lastRecovered = null;
    logAudit('recover', '检测到上次写入中断，已从 .tmp 恢复 ' + recovered);
    toast('检测到上次写入中断，已自动恢复：' + recovered);
  }
  // 首次连接写入 lastOpen（契约 §2 settings 字段）
  if (!state.settings.lastOpen) {
    state.settings.lastOpen = new Date().toISOString();
    try { await state.store.writeSettings(state.settings); } catch (err) { /* 失败不阻塞主流程 */ }
  }
}

async function connectStore(store) {
  state.store = store;
  state.mode = 'fs';
  await loadFsData();
  renderAll();
  scheduleDailyBackup();
}

// 启动/切换文件夹后静默检查：距最近一份备份超过 24 小时且有记录时，自动留一份 daily
function scheduleDailyBackup() {
  maybeDailyBackup().catch(() => { /* 自动备份失败不打扰用户 */ });
}

async function maybeDailyBackup() {
  if (!(state.mode === 'fs' && state.store && !state.store.needsPermission)) return;
  if (!state.records.length) return;
  const info = await state.store.backupInfo();
  if (info.latestAt && (Date.now() - info.latestAt) < DAILY_BACKUP_MS) return;
  const name = await state.store.backup('daily');
  if (!name) return;
  state.lastBackup = name;
  await logAudit('backup', '自动每日备份 ' + name);
  toast('已自动备份数据：' + name);
}

// 深链：index.html#map 直接进地图；#region=内蒙古 直接筛地区（截图 / 分享定位用）
function applyHash() {
  const hash = (window.location.hash || '').replace(/^#/, '');
  if (!hash) return;
  let view = '';
  let region = '';
  hash.split('&').forEach((part) => {
    if (!part) return;
    if (part === 'map' || part === 'table') { view = part; return; }
    const index = part.indexOf('=');
    if (index <= 0) return;
    const key = part.slice(0, index);
    const value = decodeURIComponent(part.slice(index + 1));
    if (key === 'view') view = value;
    if (key === 'region') region = regionShort(value);
  });
  if (region) state.region = region;
  if (view === 'map' || view === 'table') state.view = view;
  if (region || view) renderAll();
}

// 给可能被浏览器策略挂起的 API 加超时，避免启动流程永远停在 await 上（表现为白屏）
function withTimeout(promise, ms, message) {
  let timer = 0;
  const timeout = new Promise((resolve, reject) => {
    timer = window.setTimeout(() => { reject(new Error(message)); }, ms);
  });
  const race = Promise.race([promise, timeout]).then(
    (value) => { window.clearTimeout(timer); return value; },
    (err) => { window.clearTimeout(timer); throw err; }
  );
  return race;
}

async function boot() {
  bindEvents();
  // 第一步：先用内置演示数据渲染首屏（契约 §6.1：未连接文件夹 = 演示模式）。
  // 先渲染再尝试恢复句柄，可保证后续恢复失败/超时也不会白屏。
  state.mode = 'demo';
  state.records = buildDemoRecords();
  state.lastActive = new Date();
  clearStaleEphemeralToken();
  renderAll();
  applyHash();
  // 供 index.html 的 classic 看门狗判断启动成功
  window.__CV_BOOTED__ = true;
  document.documentElement.setAttribute('data-cv-ready', '1');
  document.documentElement.setAttribute('data-cv-mode', state.mode);
  // 第二步：服务器模式优先（?server=1 / 地址簿 / 同源 API）；命中后不再恢复本地文件夹
  const serverHandled = await initServerMode();
  if (!serverHandled) {
    // 尝试恢复上次选择的数据文件夹（file:// 下 IndexedDB 可能被策略挂起，故加超时兜底）
    try {
      if (Store.supported()) {
        const restored = await withTimeout(Store.restore(), 4000, '恢复数据文件夹超时，已退回演示数据');
        if (restored) {
          state.store = restored;
          if (restored.needsPermission) {
            // 有句柄但浏览器要求重新授权：保持演示数据并显示重连横幅
            setLockBanner(true);
          } else {
            state.mode = 'fs';
            try {
              await loadFsData();
            } catch (err) {
              state.mode = 'demo';
              state.store = null;
              state.records = buildDemoRecords();
              reportError(err);
            }
            state.lastActive = new Date();
            renderAll();
            applyHash();
            scheduleDailyBackup();
          }
        }
      }
    } catch (err) {
      // 恢复句柄失败且原因不是超时：说明 IndexedDB/句柄异常，提示用户；
      // 超时属于受限环境下的预期降级（如无头浏览器），保持演示模式且不弹错误，避免误导。
      const reason = err && err.message ? String(err.message) : String(err);
      if (reason.indexOf('超时') < 0) reportError(err);
    }
  }
  document.documentElement.setAttribute('data-cv-mode', state.mode);
  // 第三步：到期提醒（演示模式不自动弹窗，避免遮挡首屏；点铃铛可手动预览）
  window.setTimeout(() => { checkReminders(false); }, 1500);
  if (state.remindTimer) window.clearInterval(state.remindTimer);
  state.remindTimer = window.setInterval(() => { checkReminders(false); }, REMIND_CHECK_MS);
}

// 写操作前的连接引导：未连接时先确认、再调 Store.pick()（必须保留用户手势）
async function ensureConnected() {
  if (state.mode === 'fs' && state.store && !state.store.needsPermission) return true;
  if (serverBase) {
    // 服务器模式下尚未登录 / 登录已过期：回到登录遮罩，不弹「选择数据文件夹」
    if (!httpApi || !httpApi.token()) {
      showLoginScreen('登录后服务器才允许读写，请先登录', serverBase);
      return false;
    }
    // 有 token 但 store 暂时断开（例如刚切换地址）：尝试静默重连一次
    try {
      await connectStore(httpApi.create(serverBase, serverConfig || {}));
      return true;
    } catch (err) {
      if (err && err.status === 401) { expireSession('登录已过期，请重新登录'); return false; }
      toast('连接服务器失败：' + (err && err.message ? err.message : err));
      return false;
    }
  }
  if (!Store.supported()) {
    toast('当前浏览器不支持选择数据文件夹，请用新版 Edge 或 Chrome 打开');
    return false;
  }
  if (state.store && state.store.needsPermission) return grantReconnect();
  const confirmed = await confirmDialog(
    '需要先连接数据文件夹',
    '<p>当前显示的是内置 <b>17 条演示数据</b>，还没有选择数据文件夹，写入操作无法保存。</p>' +
      '<p class="hint">请选择一个文件夹作为数据目录（建议新建一个空文件夹，例如「CertVault 数据」）。' +
      '文件夹会被记住，下次打开自动恢复。</p>',
    '选择数据文件夹',
    '继续看演示'
  );
  if (!confirmed) return false;
  try {
    const store = await Store.pick();
    await connectStore(store);
    toast('已连接数据文件夹：' + store.folderName);
    return true;
  } catch (err) {
    toast(err && err.message ? err.message : '选择数据文件夹失败');
    return false;
  }
}

async function grantReconnect() {
  if (!state.store) return false;
  try {
    const granted = await state.store.grant();
    if (!granted) {
      toast('未获得读写权限，仍停留在演示数据');
      return false;
    }
    await loadFsData();
    renderAll();
    toast('已重新授权数据文件夹：' + state.store.folderName);
    return true;
  } catch (err) {
    toast(err && err.message ? err.message : '重新授权失败');
    return false;
  }
}

// ---------- 通用确认框（动态创建，复用 #cvDialog） ----------
function ensureDialog() {
  let dlg = $('cvDialog');
  if (dlg) return dlg;
  dlg = document.createElement('div');
  dlg.className = 'modal sm';
  dlg.id = 'cvDialog';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.innerHTML =
    '<div class="mhead"><h2 id="cvDialogTitle">提示</h2></div>' +
    '<div class="mbody" id="cvDialogBody"></div>' +
    '<div class="mfoot">' +
    '<button class="btn ghost" type="button" data-role="cancel">取消</button>' +
    '<button class="btn primary" type="button" data-role="ok">确定</button>' +
    '</div>';
  document.body.appendChild(dlg);
  return dlg;
}

function confirmDialog(title, bodyHtml, okText, cancelText, danger) {
  return new Promise((resolve) => {
    const dlg = ensureDialog();
    const titleEl = $('cvDialogTitle');
    const bodyEl = $('cvDialogBody');
    const ok = dlg.querySelector('[data-role="ok"]');
    const cancel = dlg.querySelector('[data-role="cancel"]');
    if (titleEl) titleEl.textContent = title || '提示';
    if (bodyEl) bodyEl.innerHTML = bodyHtml || '';
    ok.textContent = okText || '确定';
    cancel.textContent = cancelText || '取消';
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      hideOverlay(dlg);
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    showOverlay(dlg);
    ok.focus();
  });
}

// ---------- 审计日志 ----------
async function logAudit(action, detail) {
  if (!(state.mode === 'fs' && state.store && !state.store.needsPermission)) return;
  try {
    const entry = await state.store.audit({ action, detail });
    state.audit = state.audit.concat([entry]);
  } catch (err) {
    // 日志失败不阻塞主流程，只在控制台之外的 toast 里提示一次
    toast('操作成功，但写入操作日志失败：' + (err && err.message ? err.message : err));
  }
}

function auditLabel(action) {
  const map = {
    add: '新增记录',
    edit: '修改记录',
    delete: '删除记录',
    import: '导入 CSV',
    export: '导出 CSV',
    backup: '备份数据',
    remind: '提醒设置',
    connect: '连接数据文件夹',
  };
  return map[action] || action;
}

// ---------- 行选择 ----------
function toggleSelect(id, force) {
  if (!id) return;
  const has = state.selected.has(id);
  const next = force === undefined ? !has : !!force;
  if (next) state.selected.add(id);
  else state.selected.delete(id);
  updateSelectionUi();
}

function selectAllVisible(checked) {
  const rows = getFiltered();
  rows.forEach((rec) => {
    if (checked) state.selected.add(rec.id);
    else state.selected.delete(rec.id);
  });
  updateSelectionUi();
}

function updateSelectionUi() {
  const tbody = $('tbody');
  if (tbody) {
    const rows = tbody.querySelectorAll('tr[data-id]');
    Array.prototype.forEach.call(rows, (tr) => {
      const id = tr.getAttribute('data-id');
      const selected = state.selected.has(id);
      tr.classList.toggle('sel', selected);
      const box = tr.querySelector('.rowchk');
      if (box) box.checked = selected;
    });
  }
  syncChkAll();
  updateToolbar();
  renderStatusBar();
}

// ---------- 详情抽屉 ----------
function makeButton(text, className, handler) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = text;
  on(btn, 'click', handler);
  return btn;
}

function renderDrawer(rec) {
  const st = statusOf(rec, new Date());
  $('drawerTitle').textContent = rec.name || '（未命名平台）';
  const subParts = [];
  if (rec.url) subParts.push('<a href="' + esc(rec.url) + '" target="_blank" rel="noopener">' + esc(rec.url) + '</a>');
  subParts.push('<span class="badge ' + st.key + '">' + esc(st.label) + '</span>');
  if (rec.remindOff) subParts.push('<span class="muted">提醒已关闭</span>');
  $('drawerSub').innerHTML = subParts.join(' · ');

  const urlLine = rec.url
    ? '<a href="' + esc(rec.url) + '" target="_blank" rel="noopener">' + esc(rec.url) + '</a>'
    : '<span class="muted">未填写</span>';
  const accountLine = rec.account ? esc(rec.account) : '<span class="muted">未填写</span>';
  const pwdLine = rec.password ? '<span class="mono">' + (state.showPwd ? esc(rec.password) : mask(rec.password)) + '</span>' : '<span class="muted">未填写</span>';
  const caLine = rec.caPassword ? '<span class="mono">' + (state.showPwd ? esc(rec.caPassword) : mask(rec.caPassword)) + '</span>' : '<span class="muted">未填写</span>';
  const shots = Array.isArray(rec.images) ? rec.images : [];

  let html = '';
  html += '<div class="card"><h3>平台与账户</h3><div class="kv">';
  html += '<div class="k">平台名称</div><div class="v">' + esc(rec.name) + '</div>';
  html += '<div class="k">网址</div><div class="v">' + urlLine + '</div>';
  html += '<div class="k">地区</div><div class="v">' + (rec.region ? esc(rec.region) : '<span class="muted">未填写</span>') + '</div>';
  html += '<div class="k">账户</div><div class="v mono">' + accountLine + '</div>';
  html += '<div class="k">密码</div><div class="v">' + pwdLine + '</div>';
  html += '<div class="k">CA 口令</div><div class="v">' + caLine + '</div>';
  html += '<div class="k">备注</div><div class="v">' + (rec.note ? esc(rec.note) : '<span class="muted">—</span>') + '</div>';
  html += '</div><div class="row-actions">';
  html += '<button class="mini" type="button" data-drawer-act="copy-pwd">复制密码</button>';
  html += '<button class="mini" type="button" data-drawer-act="copy-ca">复制 CA 口令</button>';
  html += '<button class="mini" type="button" data-drawer-act="toggle-pwd">' + (state.showPwd ? '隐藏密码' : '显示密码') + '</button>';
  html += '</div></div>';

  html += '<div class="card"><h3>到期与提醒</h3><div class="kv">';
  html += '<div class="k">截止有效期</div><div class="v mono">' + (rec.expiry ? esc(rec.expiry) : '<span class="muted">未登记</span>') + '</div>';
  html += '<div class="k">到期状态</div><div class="v">' + badgeHtml(rec) + '</div>';
  html += '<div class="k">剩余天数</div><div class="v">' + (st.key === 'none' ? '<span class="muted">未登记有效期</span>' : esc(st.text)) + '</div>';
  html += '<div class="k">提醒天数</div><div class="v">' + esc(rec.remindDays) + ' 天（提前通知）</div>';
  html += '<div class="k">提醒开关</div><div class="v">' + (rec.remindOff ? '<span class="muted">已关闭（不参与弹窗）</span>' : '开启') + '</div>';
  html += '<div class="k">更新时间</div><div class="v">' + esc(fmtTime(rec.updatedAt, true)) + '</div>';
  html += '</div></div>';

  html += '<div class="card"><h3>平台操作截图（' + shots.length + '）</h3>';
  if (shots.length) html += '<div class="gallery" id="drawerGallery"></div>';
  else html += '<p class="hint">还没有截图。编辑记录后拖入或选择图片，截图会保存到 images 目录。</p>';
  html += '</div>';
  $('drawerBody').innerHTML = html;

  if (shots.length) buildGalleryTiles(shots);
  const foot = $('drawerFoot');
  foot.innerHTML = '';
  foot.appendChild(makeButton('编辑记录', 'btn primary', () => { closeDrawer(); openEditor(rec.id); }));
  foot.appendChild(makeButton(rec.remindOff ? '恢复提醒' : '取消提醒', 'btn ghost', () => { setRemind([rec.id], !rec.remindOff); }));
  foot.appendChild(makeButton('删除', 'btn danger', () => { deleteRecords([rec.id]); }));
}

function buildGalleryTiles(shots) {
  const wrap = $('drawerGallery');
  if (!wrap) return;
  wrap.innerHTML = '';
  shots.forEach((meta) => {
    const tile = document.createElement('div');
    tile.className = 'ph';
    tile.title = meta.file || '截图';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = meta.file || '截图';
    tile.appendChild(tag);
    tile.addEventListener('click', () => {
      if (tile.__cvUrl) openLightbox(tile.__cvUrl, meta.file);
      else toast('演示数据不含真实截图文件');
    });
    wrap.appendChild(tile);
  });
}

async function loadDrawerImages(rec) {
  const wrap = $('drawerGallery');
  if (!wrap) return;
  state.drawerGen += 1;
  const gen = state.drawerGen;
  const shots = Array.isArray(rec.images) ? rec.images : [];
  for (let i = 0; i < shots.length; i += 1) {
    if (gen !== state.drawerGen || state.openId !== rec.id) return;
    const meta = shots[i];
    const tile = wrap.children[i];
    if (!tile) return;
    if (state.mode !== 'fs' || !state.store) {
      const hint = document.createElement('span');
      hint.textContent = '演示截图';
      hint.style.fontSize = '10.5px';
      tile.appendChild(hint);
      continue;
    }
    let blob = null;
    try { blob = await state.store.imageBlob(rec.id, meta.file); } catch (err) { blob = null; }
    if (gen !== state.drawerGen) return;
    if (!blob) {
      const hint = document.createElement('span');
      hint.textContent = '文件缺失';
      hint.style.fontSize = '10.5px';
      tile.appendChild(hint);
      continue;
    }
    const url = URL.createObjectURL(blob);
    state.drawerUrls.push(url);
    tile.__cvUrl = url;
    const img = document.createElement('img');
    img.src = url;
    img.alt = meta.file;
    tile.insertBefore(img, tile.firstChild);
  }
}

function openLightbox(src, name) {
  if (!src) return;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;z-index:90;background:rgba(6,10,16,.92);display:grid;place-items:center;padding:26px;cursor:zoom-out';
  const img = document.createElement('img');
  img.src = src;
  img.alt = name || '截图';
  img.style.cssText = 'max-width:100%;max-height:100%;border-radius:10px;box-shadow:0 24px 70px rgba(0,0,0,.6);background:#111B27';
  box.appendChild(img);
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(box);
}

function openDrawer(id) {
  const rec = findByRecord(id);
  if (!rec) return;
  state.openId = id;
  renderDrawer(rec);
  showOverlay($('drawer'));
  const task = loadDrawerImages(rec);
  if (task && task.catch) task.catch(reportError);
}

function closeDrawer() {
  state.openId = null;
  state.drawerGen += 1;
  hideOverlay($('drawer'));
  state.drawerUrls.forEach((url) => {
    try { URL.revokeObjectURL(url); } catch (err) { /* 忽略 */ }
  });
  state.drawerUrls = [];
}

// ---------- 编辑弹窗 ----------
function editorImages(rec) {
  return rec && Array.isArray(rec.images) ? rec.images.slice() : [];
}

function setFormValue(id, value) {
  const el = $(id);
  if (el) el.value = value == null ? '' : String(value);
}

function openEditor(id) {
  const rec = id ? findByRecord(id) : null;
  state.editId = rec ? rec.id : null;
  state.existingImages = editorImages(rec);
  state.pendingUploads = [];
  state.removedImages = [];
  state.thumbGen += 1;
  revokeObjectUrls();
  $('modalTitle').textContent = rec ? '编辑记录' : '新增记录';
  setFormValue('fName', rec ? rec.name : '');
  setFormValue('fUrl', rec ? rec.url : '');
  setFormValue('fAccount', rec ? rec.account : '');
  setFormValue('fPassword', rec ? rec.password : '');
  setFormValue('fCaPassword', rec ? rec.caPassword : '');
  setFormValue('fExpiry', rec ? rec.expiry : '');
  setFormValue('fRemindDays', rec ? rec.remindDays : DEFAULT_REMIND_DAYS);
  setFormValue('fNote', rec ? rec.note : '');
  setFormValue('fRegion', rec ? regionShort(rec.region) : '');
  updateRemain();
  renderThumbs();
  showOverlay($('modal'));
  window.setTimeout(() => {
    const input = $('fName');
    if (input) input.focus();
  }, 30);
}

function clearEditorFields() {
  ['fName', 'fUrl', 'fAccount', 'fPassword', 'fCaPassword', 'fExpiry', 'fNote', 'fRegion'].forEach((id) => setFormValue(id, ''));
  setFormValue('fRemindDays', DEFAULT_REMIND_DAYS);
  updateRemain();
}

function resetEditorDraft() {
  state.existingImages = [];
  state.pendingUploads = [];
  state.removedImages = [];
  state.thumbGen += 1;
  revokeObjectUrls();
  renderThumbs();
}

function closeEditor() {
  state.editId = null;
  hideOverlay($('modal'));
  resetEditorDraft();
}

function updateRemain() {
  const field = $('fRemain');
  if (!field) return;
  const expiryEl = $('fExpiry');
  const remindEl = $('fRemindDays');
  const expiry = expiryEl ? expiryEl.value : '';
  const remindRaw = remindEl ? remindEl.value : '';
  const remindDays = remindRaw === '' ? DEFAULT_REMIND_DAYS : remindRaw;
  const st = statusOf({ expiry, remindDays }, new Date());
  let text = '未登记';
  if (st.days !== null) text = st.days < 0 ? '已逾期 ' + (-st.days) + ' 天' : '剩余 ' + st.days + ' 天';
  field.value = text;
}

function makeThumbTile(name, onRemove) {
  const tile = document.createElement('div');
  tile.className = 'thumb';
  const file = document.createElement('span');
  file.className = 'f';
  file.textContent = name;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'x';
  remove.title = '移除这张截图';
  remove.textContent = '✕';
  remove.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onRemove();
  });
  tile.appendChild(remove);
  tile.appendChild(file);
  return tile;
}

async function loadThumbImage(tile, recordId, fileName, gen) {
  if (state.mode !== 'fs' || !state.store || !recordId) return;
  let blob = null;
  try { blob = await state.store.imageBlob(recordId, fileName); } catch (err) { blob = null; }
  if (!blob || gen !== state.thumbGen) return;
  const url = URL.createObjectURL(blob);
  state.objectUrls.push(url);
  const img = document.createElement('img');
  img.src = url;
  img.alt = fileName;
  tile.insertBefore(img, tile.firstChild);
}

function renderThumbs() {
  const wrap = $('thumbList');
  if (!wrap) return;
  revokeObjectUrls();
  wrap.innerHTML = '';
  const gen = state.thumbGen;
  const existing = state.existingImages.filter((img) => state.removedImages.indexOf(img.file) < 0);
  existing.forEach((meta) => {
    const tile = makeThumbTile(meta.file, () => {
      state.removedImages.push(meta.file);
      renderThumbs();
    });
    wrap.appendChild(tile);
    const task = loadThumbImage(tile, state.editId, meta.file, gen);
    if (task && task.catch) task.catch(reportError);
  });
  state.pendingUploads.forEach((file) => {
    const tile = makeThumbTile(file.name, () => {
      state.pendingUploads = state.pendingUploads.filter((item) => item !== file);
      renderThumbs();
    });
    wrap.appendChild(tile);
    const url = URL.createObjectURL(file);
    state.objectUrls.push(url);
    const img = document.createElement('img');
    img.src = url;
    img.alt = file.name;
    tile.insertBefore(img, tile.firstChild);
  });
}

function addPendingFiles(files) {
  const list = Array.prototype.slice.call(files || []);
  if (!list.length) return;
  const skipped = [];
  // 每条记录最多 MAX_IMAGES 张：已保留的 + 待上传的都要算进来
  let room = MAX_IMAGES - state.pendingUploads.length;
  if (state.editId) {
    const rec = findByRecord(state.editId);
    if (rec && Array.isArray(rec.images)) {
      const kept = rec.images.filter((img) => state.removedImages.indexOf(img.file) < 0).length;
      room -= kept;
    }
  }
  if (room < 0) room = 0;
  list.forEach((file) => {
    if (!file || !file.type || file.type.indexOf('image/') !== 0) {
      skipped.push((file && file.name ? file.name : '未知文件') + '（不是图片）');
      return;
    }
    if (Number(file.size) > MAX_UPLOAD_BYTES) {
      skipped.push((file.name || '图片') + '（超过 8MB）');
      return;
    }
    if (room <= 0) {
      skipped.push((file.name || '图片') + '（每条最多 ' + MAX_IMAGES + ' 张）');
      return;
    }
    room -= 1;
    state.pendingUploads.push(file);
  });
  renderThumbs();
  if (skipped.length) toast('已跳过：' + skipped.slice(0, 3).join('、'));
  else toast('已添加 ' + list.length + ' 张截图预览');
  if (state.mode !== 'fs') toast('演示模式：截图会在连接数据文件夹后保存');
}

// ---------- 新增 / 编辑保存 ----------
function collectForm() {
  return {
    name: $('fName').value.trim(),
    url: $('fUrl').value.trim(),
    account: $('fAccount').value.trim(),
    password: $('fPassword').value,
    caPassword: $('fCaPassword').value,
    expiry: $('fExpiry').value,
    remindDays: $('fRemindDays').value,
    note: $('fNote').value,
    region: $('fRegion') ? $('fRegion').value : '',
  };
}

async function saveRecord(andNext) {
  if (state.saving) return;
  const form = collectForm();
  if (!form.name) {
    toast('请先填写平台名称');
    const nameInput = $('fName');
    if (nameInput) nameInput.focus();
    return;
  }
  state.saving = true;
  try {
    if (!(await ensureConnected())) return;
    const existing = state.editId ? findByRecord(state.editId) : null;
    const record = normalizeRecord({
      name: form.name,
      url: form.url,
      account: form.account,
      password: form.password,
      caPassword: form.caPassword,
      expiry: form.expiry,
      remindDays: form.remindDays,
      note: form.note,
      region: form.region,
      id: existing ? existing.id : undefined,
      createdAt: existing ? existing.createdAt : undefined,
      remindOff: existing ? existing.remindOff : false,
      images: [],
    });
    // 新截图先写盘（addImages 内部会跳过超 8MB 或非图片）
    let newImages = [];
    if (state.pendingUploads.length) {
      newImages = await state.store.addImages(record.id, state.pendingUploads);
    }
    const kept = existing ? editorImages(existing).filter((img) => state.removedImages.indexOf(img.file) < 0) : [];
    record.images = kept.concat(newImages || []);
    record.updatedAt = new Date().toISOString();
    // 先算出新列表并写盘，成功后再替换内存（写盘失败时界面与磁盘保持一致）
    let next;
    if (existing) {
      next = state.records.slice();
      const index = next.findIndex((item) => item.id === existing.id);
      if (index >= 0) next[index] = record;
      else next.push(record);
    } else {
      next = state.records.concat([record]);
    }
    try {
      await state.store.writeRecords(next);
    } catch (err) {
      // 写盘失败：清掉刚上传的截图，避免留下没有记录指向的孤儿文件
      for (let i = 0; i < newImages.length; i += 1) {
        try { await state.store.deleteImage(record.id, newImages[i].file); } catch (e) { /* 清不掉就留给体检 */ }
      }
      throw err;
    }
    state.records = next;
    // 写盘成功后再删用户移除的旧截图
    if (existing && state.removedImages.length) {
      for (let i = 0; i < state.removedImages.length; i += 1) {
        try { await state.store.deleteImage(existing.id, state.removedImages[i]); } catch (err) { /* 文件不存在不影响保存 */ }
      }
    }
    await logAudit(existing ? 'edit' : 'add', record.name + (existing ? '（编辑）' : '（新增）'));
    state.lastActive = new Date();
    resetEditorDraft();
    if (andNext) {
      state.editId = null;
      $('modalTitle').textContent = '新增记录';
      clearEditorFields();
      toast('已保存，继续录入下一条');
      const nameInput = $('fName');
      if (nameInput) nameInput.focus();
    } else {
      state.editId = null;
      hideOverlay($('modal'));
      toast(existing ? '已保存修改' : '已新增 1 条记录');
    }
    renderAll();
    checkReminders(false);
  } finally {
    state.saving = false;
  }
}

// ---------- 删除 ----------
async function deleteRecords(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return;
  if (state.deleting) return;
  const names = list.map((id) => { const rec = findByRecord(id); return rec ? rec.name : id; });
  const shortNames = names.slice(0, 3).join('、') + (names.length > 3 ? ' 等 ' + names.length + ' 条' : '');
  const confirmed = await confirmDialog(
    '删除确认',
    '<p>将删除：<b>' + esc(shortNames) + '</b></p>' +
      '<p class="hint">删除前会自动备份 certvault.json；记录下的截图文件也会一并删除，操作不可撤销。</p>',
    '删除',
    '取消',
    true
  );
  if (!confirmed) return;
  state.deleting = true;
  try {
    if (!(await ensureConnected())) return;
    const backupName = await backupQuietly('delete');
    if (backupName) state.lastBackup = backupName;
    // 先写库（记录已移除），成功后再删图片目录：写库失败时图片还在，记录也还在
    const next = state.records.filter((rec) => list.indexOf(rec.id) < 0);
    await state.store.writeRecords(next);
    state.records = next;
    for (let i = 0; i < list.length; i += 1) {
      const rec = findByRecord(list[i]);
      if (rec && Array.isArray(rec.images) && rec.images.length) {
        try { await state.store.deleteRecordImages(rec.id); } catch (err) { /* 目录不存在则忽略 */ }
      }
    }
    state.selected.clear();
    await logAudit('delete', '删除 ' + list.length + ' 条：' + names.slice(0, 3).join('、'));
    state.lastActive = new Date();
    if (state.openId && list.indexOf(state.openId) >= 0) closeDrawer();
    renderAll();
    toast('已删除 ' + list.length + ' 条记录');
  } finally {
    state.deleting = false;
  }
}

// 统一备份入口：失败给出提示但不抛出（避免阻断主流程）
async function backupQuietly(reason) {
  if (!(state.mode === 'fs' && state.store && !state.store.needsPermission)) return '';
  if (state.settings.backupBeforeDanger === false) return '';
  try {
    const name = await state.store.backup(reason);
    return name || '';
  } catch (err) {
    toast('备份失败，已继续操作：' + (err && err.message ? err.message : err));
    return '';
  }
}

// ---------- 取消 / 恢复提醒 ----------
async function setRemind(ids, off) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) {
    toast('请先勾选记录');
    return;
  }
  if (!(await ensureConnected())) return;
  const targets = list.filter((id) => findByRecord(id));
  if (!targets.length) {
    toast('所选记录不在当前数据中（演示数据不会保存）');
    return;
  }
  const nowIso = new Date().toISOString();
  const nextRecords = state.records.map((rec) => {
    if (targets.indexOf(rec.id) < 0) return rec;
    const next = Object.assign({}, rec);
    next.remindOff = off === true;
    next.updatedAt = nowIso;
    return next;
  });
  await state.store.writeRecords(nextRecords);
  state.records = nextRecords;
  await logAudit('remind', (off ? '取消提醒 ' : '恢复提醒 ') + targets.length + ' 条');
  state.lastActive = new Date();
  renderAll();
  if (state.openId && targets.indexOf(state.openId) >= 0) {
    const rec = findByRecord(state.openId);
    if (rec) {
      renderDrawer(rec);
      const task = loadDrawerImages(rec);
      if (task && task.catch) task.catch(reportError);
    }
  }
  toast(off ? '已取消提醒（这批记录不再弹窗）' : '已恢复提醒');
}

// ---------- CSV 导入 / 导出 ----------
const PV_LABEL = {
  name: '平台名称', url: '网址', account: '账户', password: '密码', caPassword: 'CA 口令',
  expiry: '截止有效期', remindDays: '提醒天数', note: '备注', region: '地区',
};
const PV_SECRET = { password: true, caPassword: true };

// 覆盖明细里的值展示：密码类只显示「已填写 / 空」，其余过长截断
function pvValue(field, value) {
  if (PV_SECRET[field]) return value ? '已填写' : '空';
  const text = value === null || value === undefined ? '' : String(value);
  if (!text) return '空';
  return text.length > 40 ? text.slice(0, 40) + '…' : text;
}

function pvDetails(summary, innerHtml) {
  return '<details class="pvd"><summary>' + esc(summary) + '</summary><div class="pvdbody">' + innerHtml + '</div></details>';
}

function buildPreviewHtml(fileName, totalRows, preview) {
  const errors = preview.errors || [];
  const updates = preview.updates || [];
  const addedNames = preview.addedNames || [];
  let html = '<p>文件：<b>' + esc(fileName) + '</b>，可解析数据 <b>' + totalRows + '</b> 行</p>';
  html += '<div class="rlist">';
  html += '<div class="ritem"><span class="nm"><b>新增 ' + preview.added + ' 条</b><small>匹配不到现有记录</small></span><span class="rt">+</span></div>';
  html += '<div class="ritem"><span class="nm"><b>覆盖 ' + preview.updated + ' 条</b><small>按「网址 + 账户」匹配到已有记录，展开看改了哪些字段；空单元格不会覆盖原值</small></span><span class="rt">~</span></div>';
  const unchanged = preview.unchanged || 0;
  if (unchanged > 0) {
    html += '<div class="ritem"><span class="nm"><b>无变化 ' + unchanged + ' 条</b><small>匹配到已有记录，但内容与表里一致，不会写入</small></span><span class="rt">=</span></div>';
  }
  html += '<div class="ritem"><span class="nm"><b>错误 ' + errors.length + ' 条</b><small>错误行会被跳过，不影响其余数据，展开看行号与原因</small></span><span class="rt">!</span></div>';
  html += '</div>';

  // 覆盖明细：每条被覆盖记录改了哪几个字段（旧值 → 新值）
  if (preview.updated > 0) {
    if (!updates.length) {
      html += '<p class="hint">覆盖记录与现有内容一致，没有字段发生变化。</p>';
    } else {
      let inner = '<div class="rlist">';
      updates.forEach((item) => {
        const changes = (item.changed || []).map((ch) => {
          const label = PV_LABEL[ch.field] || ch.field;
          return '<span class="pvchg"><i>' + esc(label) + '</i> <s>' + esc(pvValue(ch.field, ch.before)) + '</s> → <b>' + esc(pvValue(ch.field, ch.after)) + '</b></span>';
        }).join('');
        inner += '<div class="pvu"><div class="pvuhead"><b>' + esc(item.name || '（未命名）') + '</b>' +
          (item.account ? '<small>' + esc(item.account) + '</small>' : '') +
          (changes ? '' : '<small>内容无变化</small>') + '</div>' +
          (changes ? '<div class="pvchgs">' + changes + '</div>' : '') + '</div>';
      });
      if ((preview.updated || 0) > updates.length) {
        inner += '<div class="ritem"><span class="nm"><small>其余 ' + (preview.updated - updates.length) + ' 条覆盖明细已省略</small></span></div>';
      }
      inner += '</div>';
      html += pvDetails('覆盖明细（' + preview.updated + ' 条，看改动）', inner);
    }
  }

  // 新增明细：列前 15 条名字，方便核对导入的是哪几笔
  if (addedNames.length) {
    let inner = '<div class="rlist">';
    addedNames.slice(0, 15).forEach((item) => {
      inner += '<div class="ritem"><span class="nm"><b>' + esc(item.name || '（未填平台名称）') + '</b>' +
        (item.account ? '<small>' + esc(item.account) + '</small>' : '') + '</span><span class="rt">新增</span></div>';
    });
    if (addedNames.length > 15) inner += '<div class="ritem"><span class="nm"><small>其余 ' + (addedNames.length - 15) + ' 条新增已省略</small></span></div>';
    inner += '</div>';
    html += pvDetails('新增明细（' + addedNames.length + ' 条）', inner);
  }

  // 错误明细：行号 + 原因
  if (errors.length) {
    let inner = '<div class="rlist">';
    errors.slice(0, 50).forEach((item, index) => {
      const line = item && item.line !== undefined ? item.line : index + 1;
      inner += '<div class="ritem"><span class="nm"><small>第 ' + esc(line) + ' 行</small></span><span class="rt">' + esc(item && item.message ? item.message : '格式错误') + '</span></div>';
    });
    if (errors.length > 50) inner += '<div class="ritem"><span class="nm"><small>其余 ' + (errors.length - 50) + ' 条错误已省略</small></span></div>';
    inner += '</div>';
    html += pvDetails('错误明细（' + errors.length + ' 行）', inner);
  }
  return html;
}


const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLSX_COLWIDTHS = [{ wch: 26 }, { wch: 34 }, { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 34 }, { wch: 12 }];

function hasXlsx() {
  return typeof XLSX !== 'undefined' && XLSX && XLSX.utils;
}

// 把 core.toCsv 的文本转成真正的 .xlsx 字节（全部按文本落盘，避免手机号/口令被 Excel 改写）
function buildWorkbookBytes(csvText, sheetName) {
  const wb = XLSX.read(csvText, { type: 'string', raw: true });
  const first = wb.SheetNames[0];
  const ws = wb.Sheets[first];
  ws['!cols'] = XLSX_COLWIDTHS;
  // 提醒天数是纯数字，转成数字单元格（其余列一律保持文本，避免 Excel 改写账号/口令/日期）
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (let r = range.s.r + 1; r <= range.e.r; r += 1) {
    const addr = XLSX.utils.encode_cell({ r: r, c: 6 });
    const cell = ws[addr];
    if (cell && cell.v !== '' && cell.v != null && /^\d+$/.test(String(cell.v))) {
      ws[addr] = { t: 'n', v: Number(cell.v) };
    }
  }
  if (sheetName && sheetName !== first) {
    wb.Sheets[sheetName] = ws;
    wb.SheetNames[0] = sheetName;
    delete wb.Sheets[first];
  }
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
}

// 优先用 ExcelJS（能把截图嵌进表格）；不可用时退回 SheetJS（纯文本表格，无图）
async function exportWorkbookBytes(records, sheetName) {
  const api = window.CVExcel;
  if (api && typeof api.exportWorkbook === 'function' && api.hasExcelJs()) {
    try {
      const bytes = await api.exportWorkbook(records, state.mode === 'fs' ? state.store : null, sheetName);
      if (bytes && bytes.length) return bytes;
    } catch (err) {
      reportError(err);
    }
  }
  return buildWorkbookBytes(toCsv(records), sheetName);
}

// 保存字节：桌面版走原生「另存为」，浏览器版退回下载
async function saveBytes(name, bytes, mime) {
  if (window.CVDesktop && window.CVDesktop.available) {
    const res = await window.CVDesktop.saveAs(name, bytes);
    if (!res || !res.path) return null;
    return { name: res.name || name, path: res.path };
  }
  const blob = new Blob([bytes], { type: mime || XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  return { name: name, path: '' };
}

// 读取导入文件：桌面版走原生「打开」，浏览器版退回 file input
async function readImportFile() {
  if (window.CVDesktop && window.CVDesktop.available) {
    const picked = await window.CVDesktop.openFile('excel');
    if (!picked) return null;
    return { name: picked.name, bytes: picked.bytes };
  }
  const file = await pickTextFile('.xlsx,.xls,.csv');
  if (!file) return null;
  return { name: file.name, file: file };
}

async function workbookToCsvText(source) {
  if (source.bytes) {
    const wb = XLSX.read(source.bytes, { type: 'array', cellDates: false });
    const first = wb.SheetNames[0];
    if (!first) throw new Error('文件里没有工作表');
    return XLSX.utils.sheet_to_csv(wb.Sheets[first]);
  }
  if (/\.xlsx?$/i.test(source.name)) {
    const buf = new Uint8Array(await source.file.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'array', cellDates: false });
    const first = wb.SheetNames[0];
    if (!first) throw new Error('文件里没有工作表');
    return XLSX.utils.sheet_to_csv(wb.Sheets[first]);
  }
  return source.file.text();
}

// 表格里内嵌的截图（ExcelJS 可从 xlsx 的浮动图片里取回）
async function readImportShots(source) {
  const api = window.CVExcel;
  if (!api || typeof api.readImportImages !== 'function' || !api.hasExcelJs()) return [];
  try {
    return await api.readImportImages(source);
  } catch (err) {
    return [];
  }
}

async function importCsv() {
  let source = null;
  try {
    source = await readImportFile();
  } catch (err) {
    toast('打开文件失败：' + (err && err.message ? err.message : err));
    return;
  }
  if (!source) return;
  let text = '';
  try {
    text = await workbookToCsvText(source);
  } catch (err) {
    toast('读取表格失败：' + (err && err.message ? err.message : err));
    return;
  }
  let parsed;
  try {
    parsed = fromCsv(text);
  } catch (err) {
    toast('表格解析失败：' + (err && err.message ? err.message : err));
    return;
  }
  const preview = mergeImport(state.records, parsed.records, parsed.errors);
  const confirmed = await confirmDialog('导入预检', buildPreviewHtml(source.name, parsed.records.length, preview), '确认导入', '取消', false);
  if (!confirmed) return;
  if (!(await ensureConnected())) return;
  const fresh = mergeImport(state.records, parsed.records, parsed.errors);
  if (fresh.added + fresh.updated === 0) {
    toast('没有可导入的改动（' + fresh.errors.length + ' 行错误，' + (fresh.unchanged || 0) + ' 条与现有内容一致）');
    return;
  }
  const backupName = await backupQuietly('import');
  if (backupName) state.lastBackup = backupName;
  await state.store.writeRecords(fresh.records);
  state.records = fresh.records;
  let importedShots = 0;
  try {
    const shotRows = await readImportShots(source);
    if (shotRows.length && window.CVExcel) {
      const outcome = await window.CVExcel.attachImages(shotRows, state.records, state.store);
      importedShots = outcome.count;
      if (importedShots) {
        state.records = outcome.records;
        await state.store.writeRecords(state.records);
      }
    }
  } catch (err) {
    reportError(err);
  }
  await logAudit('import', '导入 ' + source.name + '：新增 ' + fresh.added + ' / 覆盖 ' + fresh.updated + ' / 错误 ' + fresh.errors.length + (importedShots ? ' / 截图 ' + importedShots + ' 张' : ''));
  state.lastActive = new Date();
  renderAll();
  const importWhere = storeRootPath();
  toast('导入完成：新增 ' + fresh.added + ' 条，覆盖 ' + fresh.updated + ' 条' + (importedShots ? '，截图 ' + importedShots + ' 张' : ''), importWhere ? '打开数据文件夹' : '', () => openFolderHint(importWhere));
}

async function exportCsv() {
  if (!state.records.length) {
    toast('当前没有可导出的记录');
    return;
  }
  if (!hasXlsx()) {
    toast('Excel 组件未加载：请确认 app/vendor/xlsx.full.min.js 存在');
    return;
  }
  const name = 'CertVault-导出-' + stampNow() + '.xlsx';
  let result;
  try {
    result = await saveBytes(name, await exportWorkbookBytes(state.records, 'CA 台账'), XLSX_MIME);
  } catch (err) {
    toast('导出失败：' + (err && err.message ? err.message : err));
    return;
  }
  if (!result) { toast('已取消导出'); return; }
  await logAudit('export', '导出 ' + state.records.length + ' 条 → ' + result.name);
  state.lastActive = new Date();
  renderStatusBar();
  const where = result.path || '';
  // 老数据可能一条超过 8 张，导出只带前 8 张：明确告知，避免用户以为丢图
  const overflow = state.records.filter((rec) => Array.isArray(rec.images) && rec.images.length > MAX_IMAGES).length;
  const extra = overflow ? '（' + overflow + ' 条记录截图超过 ' + MAX_IMAGES + ' 张，仅导出前 ' + MAX_IMAGES + ' 张）' : '';
  if (state.mode !== 'fs') {
    toast('已导出演示数据：' + result.name + extra, where ? '打开所在文件夹' : '', () => openFolderHint(where));
  } else {
    toast('已导出 ' + state.records.length + ' 条记录：' + result.name + extra, where ? '打开所在文件夹' : '', () => openFolderHint(where));
  }
}

async function exportTemplate() {
  if (!hasXlsx()) {
    toast('Excel 组件未加载：请确认 app/vendor/xlsx.full.min.js 存在');
    return;
  }
  const name = 'CertVault-导入模板.xlsx';
  let result;
  try {
    result = await saveBytes(name, await exportWorkbookBytes([], '导入模板'), XLSX_MIME);
  } catch (err) {
    toast('导出模板失败：' + (err && err.message ? err.message : err));
    return;
  }
  if (!result) { toast('已取消导出'); return; }
  await logAudit('export', '导出 Excel 导入模板');
  const tplWhere = result.path || '';
  toast('已导出导入模板：' + result.name + '（仅表头，可直接填写）', tplWhere ? '打开所在文件夹' : '', () => openFolderHint(tplWhere));
}

// ---------- 显示密码 ----------
function toggleShowPwd() {
  state.showPwd = !state.showPwd;
  const btn = $('btnShowPwd');
  if (btn) {
    btn.classList.toggle('primary', state.showPwd);
    const label = btn.querySelector('.lbl');
    if (label) label.textContent = state.showPwd ? '隐藏密码' : '显示密码';
    btn.setAttribute('aria-pressed', state.showPwd ? 'true' : 'false');
    btn.title = state.showPwd ? '当前为明文显示（仅本次会话，不写盘）' : '仅在内存中临时明文显示，不改动数据';
  }
  renderTable();
  if (state.openId) {
    const rec = findByRecord(state.openId);
    if (rec) {
      renderDrawer(rec);
      const task = loadDrawerImages(rec);
      if (task && task.catch) task.catch(reportError);
    }
  }
  toast(state.showPwd ? '已明文显示密码（仅本次会话，不写盘）' : '已恢复密码掩码');
}

// ---------- 设置面板 ----------
function setSwitch(id, value) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle('on', !!value);
  el.setAttribute('aria-checked', value ? 'true' : 'false');
}

function fillSettings() {
  const s = state.settings;
  setSwitch('stTray', s.trayMinimize);
  setSwitch('stAutostart', s.autostart);
  const interval = $('stInterval');
  if (interval) interval.value = String(s.popupIntervalHours);
  const root = $('stRoot');
  if (root) {
    if (state.mode === 'fs' && state.store) {
      const abs = storeRootPath();
      root.textContent = abs || state.store.folderName;
      root.title = abs || '';
    } else {
      root.textContent = '未连接（演示模式）';
      root.title = '';
    }
  }
  const dbSize = $('stDbSize');
  if (dbSize) dbSize.textContent = state.records.length + ' 条记录';
  const images = totalImageCount();
  const imgInfo = $('stImgInfo');
  if (imgInfo) imgInfo.textContent = images.count + ' 张' + (images.bytes > 0 ? ' · ' + fmtSize(images.bytes) : '');
  const backup = $('stBackup');
  if (backup) backup.textContent = state.lastBackup || '—（本次会话尚未备份）';
  refreshBackupInfo();
  const dangerBox = document.querySelector('[data-setting="backupBeforeDanger"]');
  if (dangerBox) {
    dangerBox.classList.toggle('on', s.backupBeforeDanger !== false);
    dangerBox.setAttribute('aria-checked', s.backupBeforeDanger !== false ? 'true' : 'false');
  }
  fillServerSettings();
}

// 备份目录概况（份数 / 占用 / 最近一份），设置面板显示用
async function refreshBackupInfo() {
  const el = $('stBackupInfo');
  if (!el) return;
  if (!(state.mode === 'fs' && state.store && !state.store.needsPermission)) {
    el.textContent = '备份目录：未连接文件夹';
    return;
  }
  try {
    const info = await state.store.backupInfo();
    if (!info.count) {
      el.textContent = '备份目录为空：危险操作前会自动备份，也可点「立即备份」';
      return;
    }
    el.textContent = '共 ' + info.count + ' 份 · ' + fmtSize(info.bytes) + ' · 最近 ' + info.latest + ' · 只保留最近 10 份';
  } catch (err) {
    el.textContent = '备份目录读取失败';
  }
}

async function persistSettings() {
  if (state.mode === 'fs' && state.store && !state.store.needsPermission) {
    try {
      await state.store.writeSettings(state.settings);
      return true;
    } catch (err) {
      toast('保存设置失败：' + (err && err.message ? err.message : err));
      return false;
    }
  }
  toast('演示模式：设置仅在本次会话生效，连接数据文件夹后才会保存');
  return false;
}

async function toggleSetting(key) {
  if (!(await ensureConnected())) return;
  state.settings[key] = !state.settings[key];
  fillSettings();
  await persistSettings();
}

async function changeInterval(value) {
  if (!(await ensureConnected())) return;
  state.settings.popupIntervalHours = Number(value) || 0;
  await persistSettings();
  toast('提醒间隔已更新');
}

function openSettings() {
  fillSettings();
  showOverlay($('settingsPanel'));
}

// 数据文件夹的绝对路径：桌面版桥接句柄带 _path，浏览器版拿不到真实路径
function storeRootPath() {
  const handle = state.store && state.store.handle;
  if (!handle) return '';
  if (typeof handle._path === 'string' && handle._path) return handle._path;
  if (typeof handle.path === 'string' && handle.path) return handle.path;
  return '';
}

function isDesktopHost() {
  return !!(window.CVDesktop && window.CVDesktop.available && typeof window.CVDesktop.openFolder === 'function');
}

// 在资源管理器里打开数据文件夹（传文件路径则定位该文件）
async function openFolderHint(target) {
  const arg = typeof target === 'string' ? target : '';
  if (state.store && state.store.kind === 'http') {
    toast('服务器模式：数据存放在 NAS（' + state.store.base + '），无需打开本地文件夹');
    return;
  }
  const path = arg || storeRootPath();
  if (!path) {
    toast(state.mode === 'fs' ? '拿不到文件夹路径，请手动打开数据文件夹' : '演示模式未连接数据文件夹');
    return;
  }
  if (isDesktopHost()) {
    try {
      await window.CVDesktop.openFolder(path);
      toast('已在资源管理器中打开：' + path);
    } catch (err) {
      toast('打开文件夹失败：' + (err && err.message ? err.message : err));
    }
    return;
  }
  toast('浏览器版无法直接打开资源管理器，请手动打开：' + path);
}

async function checkData() {
  if (!(state.mode === 'fs' && state.store && !state.store.needsPermission)) {
    toast('演示模式没有数据文件可检查');
    return;
  }
  try {
    const raw = await state.store.readRecords();
    const list = Array.isArray(raw) ? raw : [];
    const images = totalImageCount();
    toast('数据检查完成：certvault.json 可读，共 ' + list.length + ' 条记录、' + images.count + ' 张截图');
    fillSettings();
  } catch (err) {
    toast('数据检查失败：' + (err && err.message ? err.message : err));
  }
}

async function backupNow() {
  if (!(await ensureConnected())) return;
  try {
    const name = await state.store.backup('manual');
    state.lastBackup = name || '';
    await logAudit('backup', '手动备份 ' + (name || ''));
    fillSettings();
    toast(name ? '已备份：' + name : '备份完成（内容没有变化）');
  } catch (err) {
    toast('备份失败：' + (err && err.message ? err.message : err));
  }
}

// ---------- 审计日志面板 ----------
async function openLogPanel() {
  if (state.mode === 'fs' && state.store && !state.store.needsPermission) {
    try { state.audit = await state.store.readAudit(); } catch (err) { /* 读取失败时用内存缓存 */ }
  }
  renderLog();
  showOverlay($('logPanel'));
}

function renderLog() {
  const list = $('logList');
  if (!list) return;
  const entries = (state.audit || []).slice(-200).reverse();
  if (!entries.length) {
    list.innerHTML = '<li><b>暂无操作记录</b><span>新增、修改、删除、导入、导出与备份都会记录在这里</span></li>';
    return;
  }
  list.innerHTML = entries.map((entry) => {
    const label = auditLabel(entry && entry.action);
    const detail = entry && entry.detail ? ' · ' + entry.detail : '';
    return '<li><b>' + esc(label) + '</b><span>' + esc(fmtTime(entry && entry.ts, true)) + esc(detail) + '</span></li>';
  }).join('');
}

// ---------- 复制字段（右键菜单 / 密码列 / 抽屉） ----------
const FIELD_LABELS = {
  name: '平台名称',
  url: '网址',
  account: '账户',
  password: '密码',
  ca: 'CA 口令',
  expiry: '截止有效期',
};

async function copyText(value, label) {
  const text = String(value == null ? '' : value);
  if (!text) {
    toast('该字段为空，没有可复制的内容');
    return;
  }
  let copied = false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (err) {
      copied = false;
    }
  }
  if (!copied) copied = fallbackCopy(text);
  if (!copied) {
    toast('复制失败，请手动选中复制');
    return;
  }
  toast('已复制：' + (label || '内容'));
  scheduleClipboardClear(text);
}

function fallbackCopy(text) {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch (err) {
    return false;
  }
}

// 30 秒后若剪贴板仍是刚复制的敏感内容，尝试静默清空（契约 §6.7）
function scheduleClipboardClear(text) {
  window.setTimeout(async () => {
    if (!navigator.clipboard || !navigator.clipboard.readText) return;
    try {
      const current = await navigator.clipboard.readText();
      if (current === text) await navigator.clipboard.writeText('');
    } catch (err) {
      // 无读取权限时无法确认，静默放弃
    }
  }, CLIPBOARD_CLEAR_MS);
}

function copyRecordField(id, field) {
  const rec = findByRecord(id);
  if (!rec) return;
  const map = {
    name: rec.name,
    url: rec.url,
    account: rec.account,
    password: rec.password,
    ca: rec.caPassword,
    expiry: rec.expiry,
  };
  return copyText(map[field], FIELD_LABELS[field] || field);
}

// ---------- 右键菜单 ----------
function showCtxMenu(id, x, y) {
  const menu = $('ctxMenu');
  if (!menu) return;
  ctxTargetId = id;
  showOverlay(menu);
  menu.style.left = '0px';
  menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function hideCtxMenu() {
  const menu = $('ctxMenu');
  if (!menu) return;
  hideOverlay(menu);
  ctxTargetId = null;
}

async function handleCtxAction(act) {
  const id = ctxTargetId;
  hideCtxMenu();
  if (!id) return;
  if (act === 'edit') {
    openEditor(id);
    return;
  }
  if (act === 'delete') {
    await deleteRecords([id]);
    return;
  }
  await copyRecordField(id, act);
}

// ---------- 到期提醒弹窗 ----------
function cooldownHours() {
  const hours = Number(state.settings.popupIntervalHours);
  return Number.isFinite(hours) && hours >= 0 ? hours : 12;
}

// lastPopupAt + popupIntervalHours 判断是否允许再次弹窗（0 = 每天一次）
function shouldPopup(now) {
  const raw = state.settings.lastPopupAt;
  if (!raw) return true;
  const last = new Date(raw);
  if (Number.isNaN(last.getTime())) return true;
  if (last.getTime() > now.getTime()) return false; // 未来时间戳：直接抑制
  const hours = cooldownHours();
  if (hours === 0) return todayStr(last) !== todayStr(now);
  return (now.getTime() - last.getTime()) >= hours * 3600 * 1000;
}

// policy: ok=按设置间隔；later=1 小时后再提醒；today=今天不再提醒
async function writeLastPopup(policy) {
  const hours = cooldownHours();
  const now = new Date();
  let last = now;
  if (policy === 'today') {
    last = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  } else if (policy === 'later') {
    if (hours > 0) last = new Date(now.getTime() + 3600 * 1000 - hours * 3600 * 1000);
    else last = now;
  }
  state.settings.lastPopupAt = last.toISOString();
  await persistSettings();
}

function openRemindModal(list) {
  const items = (list || dueRecords()).slice();
  const count = $('remindCount');
  if (count) count.textContent = String(items.length);
  const wrap = $('remindList');
  if (wrap) {
    if (!items.length) {
      wrap.innerHTML = '<div class="ritem"><span class="nm"><b>没有需要提醒的记录</b><small>所有记录都在正常范围内</small></span></div>';
    } else {
      const now = new Date();
      wrap.innerHTML = items.map((rec) => {
        const st = statusOf(rec, now);
        return '<div class="ritem">' +
          '<span class="nm"><b>' + esc(rec.name) + '</b><small>' + (rec.expiry ? '截止 ' + esc(rec.expiry) : '未登记有效期') + (rec.url ? ' · ' + esc(hostOf(rec.url)) : '') + '</small></span>' +
          '<span class="rt"><span class="badge ' + st.key + '">' + esc(st.label) + '</span><span class="hint">' + esc(st.text) + '</span></span>' +
          '</div>';
      }).join('');
    }
  }
  showOverlay($('remindModal'));
}

function checkReminders(manual) {
  const due = dueRecords();
  if (!due.length) {
    if (manual) toast('当前没有到期或即将到期的记录');
    return;
  }
  if (!manual) {
    if (state.mode !== 'fs') return; // 演示模式不自动弹窗，避免遮挡首屏
    if (!shouldPopup(new Date())) return;
  }
  openRemindModal(due);
}

async function onRemindLater() {
  hideOverlay($('remindModal'));
  await writeLastPopup('later');
  toast('1 小时后再提醒');
}

async function onRemindToday() {
  hideOverlay($('remindModal'));
  await writeLastPopup('today');
  toast('今天不再提醒');
}

async function onRemindOk() {
  hideOverlay($('remindModal'));
  await writeLastPopup('ok');
  toast('好的，按设置的间隔再提醒');
}

// ---------- 表格交互 ----------
function onTableClick(event) {
  const target = event.target;
  if (!target || !target.closest) return;
  const tr = target.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.getAttribute('data-id');
  const cp = target.closest('.cp');
  if (cp) {
    copyRecordField(id, cp.getAttribute('data-field') || 'password');
    return;
  }
  if (target.closest('a')) return; // 网址链接照常打开，不打开抽屉
  const box = target.closest('.rowchk');
  if (box) {
    toggleSelect(id, box.checked);
    return;
  }
  // 行体单击 = 打开 / 切换详情抽屉。
  // 说明：契约 §6.3 原文是「行点击切换选中」，集成验收时 Lead 拍板改为「勾选框负责多选、行体负责查看详情」，
  // 否则查看详情只能靠双击、用户发现不了；选中状态与工具条逻辑不受影响（勾选框仍走 toggleSelect）。
  openDrawer(id);
}

function onTableDblClick(event) {
  const target = event.target;
  if (!target || !target.closest) return;
  const tr = target.closest('tr[data-id]');
  if (!tr) return;
  openDrawer(tr.getAttribute('data-id'));
}

function onTableContextMenu(event) {
  const target = event.target;
  if (!target || !target.closest) return;
  const tr = target.closest('tr[data-id]');
  if (!tr) return;
  event.preventDefault();
  showCtxMenu(tr.getAttribute('data-id'), event.clientX, event.clientY);
}

// ---------- 表格列宽调节（v1.6）：拖表头分隔线改列宽，双击复位，记忆到 settings.colWidths ----------
const COL_KEYS = ['ck', 'idx', 'name', 'url', 'acc', 'pwd', 'ca', 'exp', 'status', 'remind', 'shot', 'note'];
const COL_LABELS = {
  ck: '勾选', idx: '序号', name: '平台名称', url: '网址', acc: '账户', pwd: '密码',
  ca: 'CA 口令', exp: '截止有效期', status: '到期状态', remind: '提醒', shot: '截图', note: '备注',
};
const COL_MIN_W = 56; // 拖到更窄会截断内容，留一个下限
const COL_NOTE_MIN_W = 130; // 备注列自适应，自定义列宽时至少留这么宽
const COL_DEFAULTS = {}; // 首屏实测的默认宽度，双击复位用
let colDrag = null;

function colEl(key) {
  return document.querySelector('#table col.c-' + key);
}

function tableEl() {
  return document.querySelector('#table');
}

function recordColDefaults() {
  const ths = document.querySelectorAll('#table thead th');
  for (let i = 0; i < ths.length; i += 1) {
    const key = COL_KEYS[i];
    if (!key) continue;
    ths[i].setAttribute('data-col', key);
    const w = Math.round(ths[i].getBoundingClientRect().width);
    if (w > 0 && !COL_DEFAULTS[key]) COL_DEFAULTS[key] = w;
  }
}

function savedColWidths() {
  const widths = state.settings && state.settings.colWidths;
  return widths && typeof widths === 'object' ? widths : null;
}

// 自定义列宽后表格可能超出容器：给 #table 一个 min-width，让 .tablewrap 出现横向滚动条
function updateTableMinWidth(force) {
  const table = tableEl();
  if (!table) return;
  const widths = savedColWidths();
  const custom = force || (widths && Object.keys(widths).length > 0);
  if (!custom) { table.style.minWidth = ''; return; }
  // 备注列是自适应宽度：加宽别的列时它会被挤没，所以给它留一个最小可视宽度
  const ths = table.querySelectorAll('thead th');
  let sum = 0;
  for (let i = 0; i < ths.length; i += 1) {
    if (ths[i].getAttribute('data-col') === 'note') continue;
    sum += ths[i].getBoundingClientRect().width;
  }
  table.style.minWidth = sum > 0 ? Math.round(sum + COL_NOTE_MIN_W) + 'px' : '';
}

function applyColWidths() {
  const widths = savedColWidths();
  COL_KEYS.forEach((key) => {
    const col = colEl(key);
    if (!col) return;
    const w = widths ? Number(widths[key]) : 0;
    col.style.width = w >= COL_MIN_W ? w + 'px' : '';
  });
  updateTableMinWidth(false);
}

function saveColWidthsQuiet() {
  // 拖拽结束就落盘，失败不打扰用户（下次渲染仍按内存值显示）
  if (state.mode === 'fs' && state.store && !state.store.needsPermission) {
    const task = state.store.writeSettings(state.settings);
    if (task && typeof task.catch === 'function') task.catch(() => {});
  }
}

function commitColWidth(key, width) {
  const widths = Object.assign({}, savedColWidths() || {});
  const def = COL_DEFAULTS[key];
  if (def && Math.abs(def - width) <= 2) delete widths[key];
  else widths[key] = width;
  state.settings.colWidths = Object.keys(widths).length ? widths : null;
  applyColWidths();
  saveColWidthsQuiet();
}

function resetColWidth(key) {
  const widths = Object.assign({}, savedColWidths() || {});
  if (!widths[key]) { toast('「' + (COL_LABELS[key] || key) + '」已是默认宽度'); return; }
  delete widths[key];
  state.settings.colWidths = Object.keys(widths).length ? widths : null;
  applyColWidths();
  saveColWidthsQuiet();
  toast('已恢复「' + (COL_LABELS[key] || key) + '」默认宽度');
}

function resetAllColWidths() {
  if (!savedColWidths()) { toast('列宽已是默认值'); return; }
  state.settings.colWidths = null;
  applyColWidths();
  saveColWidthsQuiet();
  toast('已恢复全部列宽默认值');
}

function onColGripDown(event) {
  const grip = event.target && event.target.closest ? event.target.closest('.colres') : null;
  if (!grip) return;
  event.preventDefault();
  event.stopPropagation();
  const key = grip.getAttribute('data-col');
  const col = colEl(key);
  const th = grip.parentNode;
  if (!col || !th) return;
  const startW = Math.round(th.getBoundingClientRect().width);
  colDrag = { key: key, col: col, grip: grip, startX: event.clientX, startW: startW, width: startW };
  grip.classList.add('on');
  document.body.classList.add('colresizing');
  document.addEventListener('pointermove', onColGripMove);
  document.addEventListener('pointerup', onColGripUp, true);
}

function onColGripMove(event) {
  if (!colDrag) return;
  const width = Math.max(COL_MIN_W, Math.round(colDrag.startW + (event.clientX - colDrag.startX)));
  colDrag.width = width;
  colDrag.col.style.width = width + 'px';
  updateTableMinWidth(true);
}

function onColGripUp() {
  document.removeEventListener('pointermove', onColGripMove);
  document.removeEventListener('pointerup', onColGripUp, true);
  document.body.classList.remove('colresizing');
  if (!colDrag) return;
  const drag = colDrag;
  colDrag = null;
  if (drag.grip) drag.grip.classList.remove('on');
  commitColWidth(drag.key, drag.width);
}

function onColGripDblClick(event) {
  const grip = event.target && event.target.closest ? event.target.closest('.colres') : null;
  if (!grip) return;
  event.preventDefault();
  event.stopPropagation();
  resetColWidth(grip.getAttribute('data-col'));
}

function initColResize() {
  const ths = document.querySelectorAll('#table thead th');
  if (!ths.length) return;
  recordColDefaults();
  for (let i = 0; i < ths.length; i += 1) {
    const key = COL_KEYS[i];
    const th = ths[i];
    if (!key || key === 'note') continue; // 备注列自适应剩余宽度，不放把手
    if (th.querySelector('.colres')) continue;
    const grip = document.createElement('span');
    grip.className = 'colres';
    grip.setAttribute('data-col', key);
    grip.title = '拖动调整列宽，双击恢复默认';
    th.appendChild(grip);
  }
  const head = document.querySelector('#table thead');
  if (head && !head.getAttribute('data-colres')) {
    head.setAttribute('data-colres', '1');
    head.addEventListener('pointerdown', onColGripDown);
    head.addEventListener('dblclick', onColGripDblClick);
  }
  applyColWidths();
}

// ---------- 事件绑定 ----------
function bindEvents() {
  fillRegionOptions();
  on(window, 'hashchange', applyHash);
  bindLoginEvents();
  initColResize();
  on($('btnResetCols'), 'click', resetAllColWidths);
  const tbody = $('tbody');
  on(tbody, 'click', onTableClick);
  on(tbody, 'dblclick', onTableDblClick);
  on(tbody, 'contextmenu', onTableContextMenu);
  on(tbody, 'change', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const box = target.closest('.rowchk');
    if (!box) return;
    const tr = box.closest('tr[data-id]');
    if (!tr) return;
    toggleSelect(tr.getAttribute('data-id'), box.checked);
  });

  const chkAll = document.querySelector('#table .chk-all');
  on(chkAll, 'change', () => { selectAllVisible(!!(chkAll && chkAll.checked)); });

  // 筛选标签
  on($('tabs'), 'click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const tab = target.closest('.tab');
    if (!tab) return;
    state.filter = tab.getAttribute('data-filter') || 'all';
    renderTabs();
    renderTable();
    renderStatusBar();
  });

  // 搜索（120ms 防抖）
  const search = $('search');
  let searchTimer = 0;
  on(search, 'input', () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.q = search ? search.value || '' : '';
      renderTable();
      renderStatusBar();
    }, 120);
  });
  on($('btnClearSearch'), 'click', () => {
    if (search) search.value = '';
    state.q = '';
    renderTable();
    renderStatusBar();
    if (search) search.focus();
  });

  // 工具栏
  on($('btnAdd'), 'click', () => { openEditor(null); });
  on($('btnEdit'), 'click', () => {
    const ids = Array.from(state.selected);
    if (ids.length !== 1) { toast('请勾选 1 条记录后再编辑'); return; }
    openEditor(ids[0]);
  });
  on($('btnDelete'), 'click', () => deleteRecords(Array.from(state.selected)));
  on($('btnCancelRemind'), 'click', () => setRemind(Array.from(state.selected), true));
  on($('btnRestoreRemind'), 'click', () => setRemind(Array.from(state.selected), false));
  on($('btnTemplate'), 'click', exportTemplate);
  on($('btnImport'), 'click', importCsv);
  on($('btnExport'), 'click', exportCsv);
  on($('btnShowPwd'), 'click', toggleShowPwd);

  // 视图切换 + 地区筛选
  const viewSeg = $('viewSeg');
  if (viewSeg) {
    viewSeg.addEventListener('click', (event) => {
      const btn = event.target && event.target.closest ? event.target.closest('button[data-view]') : null;
      if (!btn) return;
      setView(btn.getAttribute('data-view'));
    });
  }
  on($('regionChip'), 'click', () => { pickRegion(state.region); });
  on($('regionBack'), 'click', () => { pickRegion(state.region); });
  on($('btnGuessRegion'), 'click', guessRegionIntoForm);

  // 地区：可搜索组合框 + 展开按钮 + KPI 四卡点击筛选
  const regionInput = $('fRegion');
  if (regionInput) {
    on(regionInput, 'focus', openRegionMenu);
    on(regionInput, 'click', openRegionMenu);
    on(regionInput, 'input', openRegionMenu);
    on(regionInput, 'keydown', regionMenuKeydown);
    on(regionInput, 'blur', () => { window.setTimeout(closeRegionMenu, 120); });
  }
  on($('btnRegionToggle'), 'click', () => {
    const menu = $('fRegionMenu');
    if (menu && !menu.hidden) { closeRegionMenu(); return; }
    openRegionMenu();
    if (regionInput && regionInput.focus) regionInput.focus();
  });
  on($('fRegionMenu'), 'mousedown', (event) => {
    const target = event.target && event.target.closest ? event.target.closest('.comboItem') : null;
    if (!target) return;
    event.preventDefault();
    pickRegionOption(target.getAttribute('data-region'));
  });
  Array.prototype.forEach.call(document.querySelectorAll('.kpi'), (card) => {
    const key = card.getAttribute('data-kpi');
    on(card, 'click', () => { applyKpiFilter(key === 'all' ? 'all' : key); });
    on(card, 'keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); applyKpiFilter(key === 'all' ? 'all' : key); }
    });
  });
  on(window, 'resize', () => { if (mapChart && state.view === 'map') mapChart.resize(); });

  // 顶栏
  on($('btnReconnect'), 'click', grantReconnect);
  on($('bellBtn'), 'click', () => { checkReminders(true); });
  on($('btnLog'), 'click', openLogPanel);
  on($('btnSettings'), 'click', openSettings);

  // 编辑弹窗
  on($('btnCancel'), 'click', closeEditor);
  on($('btnSave'), 'click', () => saveRecord(false));
  on($('btnSaveNext'), 'click', () => saveRecord(true));
  on($('fExpiry'), 'input', updateRemain);
  on($('fExpiry'), 'change', updateRemain);
  on($('fRemindDays'), 'input', updateRemain);
  on($('fRemindDays'), 'change', updateRemain);
  on($('imgInput'), 'change', (event) => {
    const input = event.target;
    addPendingFiles(input.files);
    input.value = '';
  });
  const dropZone = $('dropZone');
  on(dropZone, 'click', (event) => {
    const target = event.target;
    if (target && target.closest && target.closest('label')) return; // label[for=imgInput] 自己会触发
    if (target && target.closest && target.closest('.x')) return;
    const input = $('imgInput');
    if (input) input.click();
  });
  on(dropZone, 'dragover', (event) => {
    event.preventDefault();
    if (dropZone) dropZone.classList.add('dragover');
  });
  on(dropZone, 'dragleave', () => {
    if (dropZone) dropZone.classList.remove('dragover');
  });
  on(dropZone, 'drop', (event) => {
    event.preventDefault();
    if (dropZone) dropZone.classList.remove('dragover');
    if (event.dataTransfer && event.dataTransfer.files) addPendingFiles(event.dataTransfer.files);
  });

  // 抽屉
  on($('drawerClose'), 'click', closeDrawer);
  on($('drawerBody'), 'click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const btn = target.closest('[data-drawer-act]');
    if (!btn) return;
    const rec = state.openId ? findByRecord(state.openId) : null;
    if (!rec) return;
    const act = btn.getAttribute('data-drawer-act');
    if (act === 'copy-pwd') copyText(rec.password, '密码');
    else if (act === 'copy-ca') copyText(rec.caPassword, 'CA 口令');
    else if (act === 'toggle-pwd') toggleShowPwd();
  });

  // 设置面板
  on($('settingsClose'), 'click', () => hideOverlay($('settingsPanel')));
  on($('stTray'), 'click', () => toggleSetting('trayMinimize'));
  on($('stAutostart'), 'click', () => toggleSetting('autostart'));
  on($('stInterval'), 'change', () => changeInterval($('stInterval').value));
  on($('btnOpenFolder'), 'click', openFolderHint);
  on($('sbDir'), 'click', openFolderHint);
  on($('folderChip'), 'click', openFolderHint);
  on($('btnCheckData'), 'click', checkData);
  on($('btnBackupNow'), 'click', backupNow);
  on(document.querySelector('[data-setting="backupBeforeDanger"]'), 'click', () => toggleSetting('backupBeforeDanger'));

  // 服务器设置（契约 §9/§10）：地址簿、全地址检测、会话时长、退出登录
  on($('btnSvrAdd'), 'click', addServerAddress);
  on($('svrNew'), 'keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); addServerAddress(); }
  });
  on($('svrList'), 'click', onServerListClick);
  on($('btnSvrTest'), 'click', testServerAddresses);
  on($('svrTtl'), 'change', changeSessionTtl);
  on($('btnSvrLogout'), 'click', logoutServer);
  on($('btnOfflineRetry'), 'click', retryOffline);
  on($('btnOfflineLocal'), 'click', activateLocalMode);

  // 日志面板
  on($('logClose'), 'click', () => hideOverlay($('logPanel')));

  // 到期提醒
  on($('remindLater'), 'click', onRemindLater);
  on($('remindOffToday'), 'click', onRemindToday);
  on($('remindOk'), 'click', onRemindOk);

  // 右键菜单项
  on($('ctxMenu'), 'click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const btn = target.closest('button[data-act]');
    if (!btn) return;
    handleCtxAction(btn.getAttribute('data-act'));
  });

  // 遮罩点击 = 关闭最上层
  on($('scrim'), 'click', () => { closeTopOverlay(); });

  // 点击空白处关闭右键菜单
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target && target.closest && target.closest('#ctxMenu')) return;
    const menu = $('ctxMenu');
    if (menu && menu.classList.contains('open')) hideCtxMenu();
  });
  window.addEventListener('resize', hideCtxMenu);
  window.addEventListener('scroll', hideCtxMenu, true);

  // 键盘：Esc 关闭浮层，/ 聚焦搜索
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const tag = target && target.tagName ? String(target.tagName).toLowerCase() : '';
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable);
    if (event.key === 'Escape') {
      const menu = $('ctxMenu');
      if (menu && menu.classList.contains('open')) { hideCtxMenu(); return; }
      closeTopOverlay();
      return;
    }
    if (event.key === '/' && !typing) {
      event.preventDefault();
      const search = $('search');
      if (search) search.focus();
    }
  });
}

// ---------- 全局异常兜底（尽早注册，保证任何未捕获异常都有中文提示） ----------
window.addEventListener('error', (event) => {
  const err = event && event.error ? event.error : (event && event.message ? event.message : '页面脚本错误');
  reportError(err);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason ? event.reason : '未处理的异步错误';
  reportError(reason);
});

// ---------- 启动 ----------
const bootTask = boot();
if (bootTask && typeof bootTask.catch === 'function') {
  bootTask.catch((err) => {
    reportError(err);
    // 即使启动失败也标记已引导，避免看门狗给出误导性提示
    window.__CV_BOOTED__ = true;
    document.documentElement.setAttribute('data-cv-ready', '1');
  });
}

})(); // 立即执行函数结束（classic script 全局命名空间隔离）
