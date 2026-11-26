// CertVault 纯逻辑层（core.js）
// 约束：classic script（IIFE，末尾挂载 window.CVCore），不依赖 ES module；除挂载外不触碰 DOM / localStorage / 文件系统。
// 所有导出签名以 docs/工程契约-v1.md §3 为准，改签名前先改契约；Node 单测经 tests/core-shim.mjs 用 vm 加载。
(function () {
  'use strict';

const STATUS_LABEL = { none: '未登记', ok: '正常', soon: '提醒中', over: '已逾期' };
const CSV_HEADER = ['平台名称', '网址', '账户', '密码', 'CA口令', '截止有效期', '提醒天数', '备注', '地区'];
const DEFAULT_REMIND_DAYS = 60;

const REMIND_MIN = 1;
const REMIND_MAX = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
// 2026-02-20 / 2026/2/20
const DATE_DASH_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
// 20260220
const DATE_COMPACT_RE = /^(\d{4})(\d{2})(\d{2})$/;
// fromCsv 表头按中文列名匹配，列顺序可变
const CSV_COLUMNS = {
  '平台名称': 'name',
  '网址': 'url',
  '账户': 'account',
  '密码': 'password',
  'CA口令': 'caPassword',
  '截止有效期': 'expiry',
  '提醒天数': 'remindDays',
  '备注': 'note',
  '地区': 'region',
};
// mergeImport 覆盖时允许涉及的字段；id / createdAt / images / remindOff 永远保留原值
const MERGE_FIELDS = ['name', 'url', 'account', 'password', 'caPassword', 'expiry', 'remindDays', 'note', 'region'];

let idSeq = 0;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function str(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function isoOr(value, fallback) {
  const s = str(value).trim();
  if (s && !Number.isNaN(Date.parse(s))) return s;
  return fallback;
}

// 提醒天数：非数字 → 60；数字钳制到 1..365（0 / 负数 → 1，超过 365 → 365）
function toRemindDays(value) {
  if (value === null || value === undefined) return DEFAULT_REMIND_DAYS;
  if (typeof value === 'string' && value.trim() === '') return DEFAULT_REMIND_DAYS;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return DEFAULT_REMIND_DAYS;
  const int = Math.trunc(n);
  if (int < REMIND_MIN) return REMIND_MIN;
  if (int > REMIND_MAX) return REMIND_MAX;
  return int;
}

function toNonNegInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

function normalizeImages(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const file = str(item.file).trim();
    if (!file || seen.has(file)) continue; // 同一文件名只保留第一条
    seen.add(file);
    out.push({
      file,
      w: toNonNegInt(item.w),
      h: toNonNegInt(item.h),
      size: toNonNegInt(item.size),
      addedAt: isoOr(item.addedAt, ''),
    });
  }
  return out;
}

/**
 * 生成内部主键：prefix + '_' + base36 时间 + 6 位随机；同一毫秒内也不会重复撞车。
 * @param {string} [prefix='r']
 * @returns {string}
 */
function makeId(prefix = 'r') {
  const p = str(prefix).trim() || 'r';
  idSeq = (idSeq + 1) % 1296; // 同一毫秒内的自增尾号，降低极端情况下碰撞概率
  const time = Date.now().toString(36);
  let token = '';
  while (token.length < 6) {
    token += Math.random().toString(36).slice(2);
  }
  token = token.slice(0, 6);
  const tail = idSeq === 0 ? token : token.slice(0, 4) + idSeq.toString(36).padStart(2, '0');
  return `${p}_${time}${tail}`;
}

/**
 * 本地时区的今天，格式 YYYY-MM-DD。
 * @param {Date} [now]
 * @returns {string}
 */
function todayStr(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 解析日期，接受 2026-02-20 / 2026/2/20 / 20260220；非法 → null。
 * 返回本地时区当天 00:00:00 的 Date。
 * @param {string|Date} input
 * @returns {Date|null}
 */
function parseDate(input) {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return new Date(input.getFullYear(), input.getMonth(), input.getDate());
  }
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  let m = DATE_DASH_RE.exec(s);
  if (!m) m = DATE_COMPACT_RE.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  // 回读校验：拦截 2026-02-30 / 2025-02-29 这类溢出日期
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 自然日差（按本地 0 点取整）：未来为正、今天为 0、过去为负；空/非法 → null。
 * 用 UTC 毫秒差计算，避免夏令时导致的 23/25 小时误差。
 * @param {string} expiry
 * @param {Date} [now]
 * @returns {number|null}
 */
function daysLeft(expiry, now = new Date()) {
  const target = parseDate(expiry);
  if (!target) return null;
  const base = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(base.getTime())) return null;
  const a = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
  const b = Date.UTC(base.getFullYear(), base.getMonth(), base.getDate());
  return Math.round((a - b) / DAY_MS);
}

/**
 * 四态判定：none / over / soon / ok；边界严格按契约：
 * days < 0 → over；0 <= days <= remindDays → soon；否则 ok。
 * @param {object} record
 * @param {Date} [now]
 * @returns {{key:'none'|'over'|'soon'|'ok', days:number|null, label:string, text:string}}
 */
function statusOf(record, now = new Date()) {
  const rec = record && typeof record === 'object' ? record : {};
  const days = daysLeft(rec.expiry, now);
  if (days === null) {
    return { key: 'none', days: null, label: STATUS_LABEL.none, text: '—' };
  }
  const remindDays = toRemindDays(rec.remindDays);
  if (days < 0) {
    return { key: 'over', days, label: STATUS_LABEL.over, text: `逾期 ${-days} 天` };
  }
  if (days <= remindDays) {
    return { key: 'soon', days, label: STATUS_LABEL.soon, text: `提醒 ${days} 天` };
  }
  return { key: 'ok', days, label: STATUS_LABEL.ok, text: `${days} 天` };
}

/**
 * 补默认值并清洗一条记录；不传 id 时生成新 id，传了就保留原 id。
 * images 按文件名去重；remindDays 非法 → 60，数字越界 → 钳制 1..365。
 * @param {object} input
 * @returns {object}
 */
function normalizeRecord(input) {
  const src = input && typeof input === 'object' ? input : {};
  const nowIso = new Date().toISOString();
  const rawId = src.id;
  let id;
  if (typeof rawId === 'string' && rawId.trim()) id = rawId.trim();
  else if (typeof rawId === 'number' && Number.isFinite(rawId)) id = String(rawId);
  else id = makeId();
  const parsedExpiry = parseDate(src.expiry);
  return {
    id,
    name: str(src.name).trim(),
    url: str(src.url).trim(),
    account: str(src.account).trim(),
    // 密码 / CA 口令原样保留（可能存在有意义的空格），只做字符串化
    password: str(src.password),
    caPassword: str(src.caPassword),
    expiry: parsedExpiry ? todayStr(parsedExpiry) : '',
    remindDays: toRemindDays(src.remindDays),
    note: str(src.note),
    region: normalizeRegion(src.region),
    images: normalizeImages(src.images),
    remindOff: src.remindOff === true,
    createdAt: isoOr(src.createdAt, nowIso),
    updatedAt: isoOr(src.updatedAt, nowIso),
  };
}

/**
 * 统计各状态数量。
 * @param {object[]} records
 * @param {Date} [now]
 * @returns {{total:number, over:number, soon:number, ok:number, none:number}}
 */
function summarize(records, now = new Date()) {
  const out = { total: 0, over: 0, soon: 0, ok: 0, none: 0 };
  const list = Array.isArray(records) ? records : [];
  out.total = list.length;
  for (const rec of list) {
    out[statusOf(rec, now).key] += 1;
  }
  return out;
}

// CSV 单元格转义：含逗号 / 双引号 / 换行时用双引号包裹；双引号内部翻倍。
// 防公式注入：字符串以 = + - @ 开头时前置单引号，避免 Excel / WPS 当公式执行。
function csvField(value) {
  const isText = typeof value === 'string';
  let s = value === null || value === undefined ? '' : String(value);
  if (isText && /^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * 记录数组 → CSV 文本（不含 BOM，由 app.js 导出时自行前置 \ufeff）。
 * 行分隔符用 CRLF，保证 Excel 双击打开正常。
 * @param {object[]} records
 * @returns {string}
 */
function toCsv(records) {
  const list = Array.isArray(records) ? records : [];
  const lines = [CSV_HEADER.map(csvField).join(',')];
  for (const rec of list) {
    const r = rec && typeof rec === 'object' ? rec : {};
    const remind = r.remindDays === null || r.remindDays === undefined || r.remindDays === ''
      ? DEFAULT_REMIND_DAYS
      : r.remindDays;
    const row = [
      str(r.name),
      str(r.url),
      str(r.account),
      str(r.password),
      str(r.caPassword),
      str(r.expiry),
      remind,
      str(r.note),
      str(r.region),
    ];
    lines.push(row.map(csvField).join(','));
  }
  return lines.join('\r\n');
}

/**
 * 逐字符解析 CSV，支持引号内的逗号 / 双引号转义 / 换行；返回带物理起始行号的逻辑行。
 * @param {string} text
 * @returns {{cells:string[], line:number}[]}
 */
function parseCsvRows(text) {
  const rows = [];
  let cells = [];
  let cell = '';
  let inQuotes = false;
  let physicalLine = 1; // 当前物理行号
  let rowStartLine = 1; // 当前逻辑行起始物理行号
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (ch === '\n') physicalLine += 1;
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      cells.push(cell);
      cell = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 2;
      else i += 1;
      cells.push(cell);
      cell = '';
      rows.push({ cells, line: rowStartLine });
      cells = [];
      physicalLine += 1;
      rowStartLine = physicalLine;
      continue;
    }
    cell += ch;
    i += 1;
  }
  // 最后一行可能没有换行符
  if (cell !== '' || cells.length > 0) {
    cells.push(cell);
    rows.push({ cells, line: rowStartLine });
  }
  return rows;
}

/**
 * CSV 文本 → 记录草稿 + 逐行错误。
 * 规则：去 BOM；表头按中文列名匹配（列乱序 / 缺列 / 多列均可）；平台名为空记错误并跳过；
 * 日期非法记错误但保留该行（expiry 置 ''）；提醒天数非数字 → 60。
 * @param {string} text
 * @returns {{records:object[], errors:{line:number, message:string}[]}}
 */
function fromCsv(text) {
  const records = [];
  const errors = [];
  const raw = typeof text === 'string' ? text.replace(/^\ufeff/, '') : '';
  // 纯空行（只有换行 / 空白）不参与导入，也不算错误
  const rows = parseCsvRows(raw).filter((row) => !(row.cells.length === 1 && row.cells[0].trim() === ''));
  if (rows.length === 0) return { records, errors };
  const headerCells = rows[0].cells.map((h) => h.trim());
  const colIndex = new Map();
  headerCells.forEach((header, index) => {
    if (!colIndex.has(header)) colIndex.set(header, index); // 重名列取第一次出现
  });
  if (!colIndex.has('平台名称')) {
    errors.push({ line: rows[0].line, message: '表头缺少「平台名称」列，无法导入' });
    return { records, errors };
  }
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    const pick = (header) => {
      const index = colIndex.get(header);
      if (index === undefined || index >= row.cells.length) return '';
      return row.cells[index];
    };
    const name = pick('平台名称').trim();
    if (!name) {
      errors.push({ line: row.line, message: '平台名称为空，已跳过该行' });
      continue;
    }
    const rec = { name };
    if (colIndex.has('网址')) rec.url = pick('网址').trim();
    if (colIndex.has('账户')) rec.account = pick('账户').trim();
    if (colIndex.has('密码')) rec.password = pick('密码');
    if (colIndex.has('CA口令')) rec.caPassword = pick('CA口令');
    if (colIndex.has('截止有效期')) {
      const value = pick('截止有效期').trim();
      // 空单元格不写字段：合并时保留原有效期，新记录走默认空值
      if (value) {
        const parsed = parseDate(value);
        if (parsed) {
          rec.expiry = todayStr(parsed);
        } else {
          rec.expiry = '';
          errors.push({ line: row.line, message: `截止有效期格式非法：${value}` });
        }
      }
    }
    if (colIndex.has('提醒天数')) {
      const value = pick('提醒天数').trim();
      if (value) rec.remindDays = toRemindDays(value);
    }
    if (colIndex.has('备注')) rec.note = pick('备注');
    if (colIndex.has('地区')) rec.region = pick('地区').trim();
    records.push(rec);
  }
  return { records, errors };
}

/**
 * 导入去重键：url 与 account 都 trim + 小写后拼接；两者都为空时得到 '|'（无法去重）。
 * @param {object} rec
 * @returns {string}
 */
function dedupeKey(rec) {
  const source = rec && typeof rec === 'object' ? rec : {};
  const url = source.url === null || source.url === undefined ? '' : String(source.url);
  const account = source.account === null || source.account === undefined ? '' : String(source.account);
  return `${url.trim().toLowerCase()}|${account.trim().toLowerCase()}`;
}

/**
 * 导入合并：同 url+account 覆盖 incoming 中出现的字段（null/undefined 不覆盖），
 * 保留原 id / createdAt / images / remindOff；否则新增并生成 id。
 * errors 原样透传：既支持第三参数，也支持 incoming 传 { records, errors }。
 * @param {object[]} existing
 * @param {object[]|{records:object[], errors?:object[]}} incoming
 * @param {object[]} [errors]
 * @returns {{records:object[], added:number, updated:number, errors:object[]}}
 */
function mergeImport(existing, incoming, errors, options) {
  const opts = options && typeof options === 'object' ? options : {};
  // 默认「空单元格不覆盖已有值」：模板里没填的列不能把原密码 / 账户 / 网址清空。
  // 需要显式清空时传 { emptyOverwrites: true }。
  const emptyOverwrites = opts.emptyOverwrites === true;
  const base = Array.isArray(existing) ? existing : [];
  let incomingList = [];
  let sourceErrors = undefined;
  if (Array.isArray(incoming)) {
    incomingList = incoming;
  } else if (incoming && typeof incoming === 'object' && Array.isArray(incoming.records)) {
    incomingList = incoming.records;
    if (Array.isArray(incoming.errors)) sourceErrors = incoming.errors;
  }
  const errorList = Array.isArray(errors)
    ? errors.slice()
    : (sourceErrors ? sourceErrors.slice() : []);
  const records = base.map((rec) => (rec && typeof rec === 'object' ? { ...rec } : {}));
  const keyToIndex = new Map();
  records.forEach((rec, index) => {
    const key = dedupeKey(rec);
    if (key !== '|' && !keyToIndex.has(key)) keyToIndex.set(key, index);
  });
  const nowIso = new Date().toISOString();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const updates = [];
  const addedNames = [];
  for (const raw of incomingList) {
    if (!raw || typeof raw !== 'object') continue;
    const key = dedupeKey(raw);
    const index = key === '|' ? undefined : keyToIndex.get(key);
    if (index === undefined) {
      const next = normalizeRecord(raw);
      records.push(next);
      if (key !== '|') keyToIndex.set(key, records.length - 1);
      added += 1;
      if (addedNames.length < 200) addedNames.push({ name: next.name, account: next.account });
      continue;
    }
    const target = records[index];
    const changed = [];
    for (const field of MERGE_FIELDS) {
      let value = raw[field];
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && value.trim() === '') {
        if (!emptyOverwrites) continue; // 空单元格保留原值
        value = ''; // 显式清空模式：空白串按空值处理
      }
      const prevRaw = target[field];
      const prevText = prevRaw === null || prevRaw === undefined ? '' : String(prevRaw);
      if (field === 'expiry') {
        const parsed = parseDate(value);
        target.expiry = parsed ? todayStr(parsed) : '';
      } else if (field === 'remindDays') {
        target.remindDays = toRemindDays(value);
      } else if (field === 'name' || field === 'url' || field === 'account') {
        target[field] = str(value).trim();
      } else if (field === 'region') {
        // 地区统一归一到短名（内蒙古自治区 / 内蒙 → 内蒙古），避免同一省份两种写法
        target.region = normalizeRegion(value);
      } else {
        target[field] = str(value);
      }
      const nextRaw = target[field];
      const nextText = nextRaw === null || nextRaw === undefined ? '' : String(nextRaw);
      if (prevText !== nextText) changed.push({ field: field, before: prevText, after: nextText });
    }
    // 这四个字段永远沿用原记录，避免导入破坏本机状态
    target.id = target.id || makeId();
    target.createdAt = target.createdAt || nowIso;
    if (!Array.isArray(target.images)) target.images = [];
    target.remindOff = target.remindOff === true;
    if (!changed.length) {
      // 内容完全一致：算「无变化」，不刷新 updatedAt，预检里单独计数
      unchanged += 1;
      continue;
    }
    target.updatedAt = nowIso;
    updated += 1;
    if (updates.length < 500) {
      updates.push({ id: target.id, name: target.name, account: target.account, changed: changed });
    }
  }
  return { records, added, updated, unchanged, errors: errorList, updates: updates, addedNames: addedNames };
}
/**
 * 34 个省级行政区（短名，直接用于「地区」字段）与地图 GeoJSON 官方全名的对应表。
 * 数据里只存短名（北京 / 内蒙古 / 广西…），渲染地图时再换成全名，避免手填对不上。
 */
const REGION_GEO = {
  '北京': '北京市',
  '天津': '天津市',
  '河北': '河北省',
  '山西': '山西省',
  '内蒙古': '内蒙古自治区',
  '辽宁': '辽宁省',
  '吉林': '吉林省',
  '黑龙江': '黑龙江省',
  '上海': '上海市',
  '江苏': '江苏省',
  '浙江': '浙江省',
  '安徽': '安徽省',
  '福建': '福建省',
  '江西': '江西省',
  '山东': '山东省',
  '河南': '河南省',
  '湖北': '湖北省',
  '湖南': '湖南省',
  '广东': '广东省',
  '广西': '广西壮族自治区',
  '海南': '海南省',
  '重庆': '重庆市',
  '四川': '四川省',
  '贵州': '贵州省',
  '云南': '云南省',
  '西藏': '西藏自治区',
  '陕西': '陕西省',
  '甘肃': '甘肃省',
  '青海': '青海省',
  '宁夏': '宁夏回族自治区',
  '新疆': '新疆维吾尔自治区',
  '台湾': '台湾省',
  '香港': '香港特别行政区',
  '澳门': '澳门特别行政区',
};

const REGIONS = Object.keys(REGION_GEO);

// 名称识别用的补充写法（只收 2 字以上，避免「云」「吉」这类误判）
const REGION_ALIAS = {
  '内蒙古': ['内蒙'],
  '黑龙江': ['龙江'],
  '新疆': ['新疆维吾尔'],
  '广西': ['广西壮族'],
  '宁夏': ['宁夏回族'],
};

/**
 * 把用户 / Excel 里写的地区统一成 34 个省级短名之一。
 * 认识：短名（北京）、官方全名（北京市 / 内蒙古自治区）、常见别名（内蒙 / 广西壮族）；
 * 认不出就原样返回（不丢数据），空值返回 ''。
 * @param {any} value
 * @returns {string}
 */
function normalizeRegion(value) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) return '';
  if (REGION_GEO[text]) return text;
  for (let i = 0; i < REGIONS.length; i++) {
    const short = REGIONS[i];
    if (REGION_GEO[short] === text) return short;
  }
  const aliasKeys = Object.keys(REGION_ALIAS);
  for (let i = 0; i < aliasKeys.length; i++) {
    const short = aliasKeys[i];
    const list = REGION_ALIAS[short] || [];
    if (list.indexOf(text) >= 0 || REGION_GEO[short] === text) return short;
  }
  // 去掉行政区后缀再试：北京市 / 广东省 / 内蒙古自治区 / 广西壮族自治区 / 宁夏回族自治区 / 新疆维吾尔自治区 / 香港特别行政区
  const stripped = text
    .replace(/(特别行政区|自治区|省|市)$/u, '')
    .replace(/(壮族|回族|维吾尔)$/u, '')
    .replace(/(特别行政区|自治区|省|市)$/u, '')
    .trim();
  if (stripped && stripped !== text) {
    if (REGION_GEO[stripped]) return stripped;
    for (let i = 0; i < REGIONS.length; i++) {
      const short = REGIONS[i];
      if (REGION_GEO[short] === stripped || short === stripped) return short;
    }
    for (let i = 0; i < aliasKeys.length; i++) {
      const short = aliasKeys[i];
      const list = REGION_ALIAS[short] || [];
      if (list.indexOf(stripped) >= 0) return short;
    }
  }
  return text;
}

/**
 * 从平台名称 / 网址 / 备注里猜地区（找不到返回 ''）。
 * 取出现位置最靠前的一个；位置相同时取更长的名字。
 * @param {...string} parts
 * @returns {string}
 */
function guessRegion(...parts) {
  const text = parts
    .filter((part) => part !== null && part !== undefined)
    .map((part) => String(part))
    .join(' ');
  if (!text) return '';
  let best = '';
  let bestIndex = -1;
  for (const name of REGIONS) {
    const aliases = [name].concat(REGION_ALIAS[name] || []);
    for (const alias of aliases) {
      const index = text.indexOf(alias);
      if (index < 0) continue;
      if (bestIndex < 0 || index < bestIndex || (index === bestIndex && name.length > best.length)) {
        best = name;
        bestIndex = index;
      }
    }
  }
  return best;
}

  // 经典脚本入口：挂到全局命名空间，供 index.html / app.js 直接使用
  window.CVCore = {
    STATUS_LABEL,
    CSV_HEADER,
    DEFAULT_REMIND_DAYS,
    makeId,
    todayStr,
    parseDate,
    daysLeft,
    statusOf,
    normalizeRecord,
    summarize,
    toCsv,
    fromCsv,
    dedupeKey,
    mergeImport,
    REGIONS,
    REGION_GEO,
    REGION_ALIAS,
    normalizeRegion,
    guessRegion,
  };
})();
