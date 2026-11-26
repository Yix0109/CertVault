// CertVault core.js 单元测试（node:test + node:assert/strict）
// 运行：node --test tests/core.test.mjs
// 时间一律用本地 Date 构造，避免测试机时区影响断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
  guessRegion,
  normalizeRegion,
} from './core-shim.mjs';

// 固定“今天”：2026-11-23 15:30（本地时区）
const NOW = new Date(2026, 10, 23, 15, 30, 0);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function makeExisting(overrides = {}) {
  return {
    id: 'r_keep001',
    name: '旧平台',
    url: 'https://a.com/',
    account: 'ACC',
    password: 'p1',
    caPassword: 'ca1',
    expiry: '2026-12-31',
    remindDays: 60,
    note: '旧备注',
    images: [{ file: 'x.png', w: 10, h: 20, size: 30, addedAt: '2026-01-01T00:00:00.000Z' }],
    remindOff: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

test('常量：STATUS_LABEL / CSV_HEADER / DEFAULT_REMIND_DAYS 与契约一致', () => {
  assert.deepEqual(STATUS_LABEL, { none: '未登记', ok: '正常', soon: '提醒中', over: '已逾期' });
  assert.deepEqual(CSV_HEADER, ['平台名称', '网址', '账户', '密码', 'CA口令', '截止有效期', '提醒天数', '备注', '地区']);
  assert.equal(CSV_HEADER.length, 9);
  assert.equal(DEFAULT_REMIND_DAYS, 60);
});

test('makeId：默认 r_ 前缀、自定义前缀、批量不重复', () => {
  const a = makeId();
  assert.match(a, /^r_[0-9a-z]+$/);
  const b = makeId('img');
  assert.match(b, /^img_[0-9a-z]+$/);
  assert.notEqual(a, makeId());
  const ids = new Set();
  for (let i = 0; i < 500; i += 1) ids.add(makeId());
  assert.equal(ids.size, 500);
});

test('todayStr：本地时区补零', () => {
  assert.equal(todayStr(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(todayStr(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31');
  assert.equal(todayStr(new Date(2026, 10, 23, 0, 0, 0)), '2026-11-23');
  assert.equal(todayStr(new Date('bad')), ''); // 非法 Date 回退为空串
});

test('parseDate：三种合法写法、去空白、闰年、非法日期', () => {
  assert.equal(todayStr(parseDate('2026-02-20')), '2026-02-20');
  assert.equal(todayStr(parseDate('2026/2/20')), '2026-02-20');
  assert.equal(todayStr(parseDate('20260220')), '2026-02-20');
  assert.equal(todayStr(parseDate(' 2026-02-20 ')), '2026-02-20');
  assert.equal(todayStr(parseDate('2024-02-29')), '2024-02-29'); // 闰年 2 月 29 合法
  assert.equal(parseDate('2025-02-29'), null); // 平年 2 月 29 非法
  assert.equal(parseDate('2026-02-30'), null);
  assert.equal(parseDate('2026-04-31'), null);
  assert.equal(parseDate('2026-13-01'), null);
  assert.equal(parseDate('2026-00-10'), null);
  assert.equal(parseDate('20260230'), null);
  assert.equal(parseDate('abc'), null);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('   '), null);
  assert.equal(parseDate(null), null);
  assert.equal(parseDate(20260220), null);
});

test('daysLeft：同天 / 昨天 / 明天 / 跨月 / 跨年 / 闰年自然日差', () => {
  assert.equal(daysLeft('2026-11-23', NOW), 0);
  assert.equal(daysLeft('2026-11-22', NOW), -1);
  assert.equal(daysLeft('2026-11-24', NOW), 1);
  // 跨月
  assert.equal(daysLeft('2026-12-01', new Date(2026, 10, 30, 23, 59)), 1);
  assert.equal(daysLeft('2026-12-01', new Date(2026, 10, 29, 0, 1)), 2);
  // 跨年
  assert.equal(daysLeft('2027-01-01', new Date(2026, 11, 31, 23, 59)), 1);
  assert.equal(daysLeft('2026-01-01', new Date(2025, 11, 31)), 1);
  // 闰年：2024-02-28 → 2024-03-01 是 2 天；2025 年同段只有 1 天
  assert.equal(daysLeft('2024-03-01', new Date(2024, 1, 28)), 2);
  assert.equal(daysLeft('2025-03-01', new Date(2025, 1, 28)), 1);
  // 按本地 0 点取整，不受当前时刻影响
  assert.equal(daysLeft('2026-11-23', new Date(2026, 10, 23, 23, 59, 59)), 0);
  assert.equal(daysLeft('', NOW), null);
  assert.equal(daysLeft('2026-02-30', NOW), null);
  assert.equal(daysLeft(null, NOW), null);
});

test('statusOf：none / over / soon(0 与边界) / ok 四态严格判定', () => {
  const none = statusOf({ expiry: '' }, NOW);
  assert.deepEqual(none, { key: 'none', days: null, label: '未登记', text: '—' });
  assert.deepEqual(statusOf({ expiry: '2026-02-30' }, NOW), none);
  assert.deepEqual(statusOf({}, NOW), none);

  const over = statusOf({ expiry: '2026-11-22', remindDays: 60 }, NOW);
  assert.deepEqual(over, { key: 'over', days: -1, label: '已逾期', text: '逾期 1 天' });

  const zero = statusOf({ expiry: '2026-11-23', remindDays: 60 }, NOW);
  assert.deepEqual(zero, { key: 'soon', days: 0, label: '提醒中', text: '提醒 0 天' });

  // 第 60 天仍在提醒内，第 61 天转为正常
  assert.equal(statusOf({ expiry: '2027-01-22', remindDays: 60 }, NOW).key, 'soon');
  assert.equal(statusOf({ expiry: '2027-01-22', remindDays: 60 }, NOW).days, 60);
  assert.equal(statusOf({ expiry: '2027-01-23', remindDays: 60 }, NOW).key, 'ok');
  assert.equal(statusOf({ expiry: '2027-01-23', remindDays: 60 }, NOW).text, '61 天');
  // 自定义提醒天数边界：10 天提醒，第 10 天 soon、第 11 天 ok
  assert.equal(statusOf({ expiry: '2026-12-03', remindDays: 10 }, NOW).key, 'soon');
  assert.equal(statusOf({ expiry: '2026-12-04', remindDays: 10 }, NOW).key, 'ok');
  // remindDays 非法时按默认 60 天判定
  assert.equal(statusOf({ expiry: '2027-01-22', remindDays: 'abc' }, NOW).key, 'soon');
});

test('normalizeRecord：默认值 / id 保留 / 去空白 / expiry 规范化', () => {
  const rec = normalizeRecord({});
  assert.equal(rec.name, '');
  assert.equal(rec.url, '');
  assert.equal(rec.account, '');
  assert.equal(rec.password, '');
  assert.equal(rec.caPassword, '');
  assert.equal(rec.expiry, '');
  assert.equal(rec.remindDays, DEFAULT_REMIND_DAYS);
  assert.equal(rec.note, '');
  assert.deepEqual(rec.images, []);
  assert.equal(rec.remindOff, false);
  assert.match(rec.id, /^r_[0-9a-z]+$/);
  assert.match(rec.createdAt, ISO_RE);
  assert.match(rec.updatedAt, ISO_RE);

  assert.equal(normalizeRecord({ id: 'r_keep001' }).id, 'r_keep001');
  const trimmed = normalizeRecord({ name: '  平台  ', url: ' https://x.com ', account: ' 用户 ', password: ' 保留空格 ' });
  assert.equal(trimmed.name, '平台');
  assert.equal(trimmed.url, 'https://x.com');
  assert.equal(trimmed.account, '用户');
  assert.equal(trimmed.password, ' 保留空格 ');
  assert.equal(normalizeRecord({ expiry: '2026/2/20' }).expiry, '2026-02-20');
  assert.equal(normalizeRecord({ expiry: '2026-02-30' }).expiry, '');
  assert.equal(normalizeRecord({ remindOff: true }).remindOff, true);
  assert.equal(normalizeRecord({ remindOff: 'true' }).remindOff, false); // 只认布尔 true
});

test('normalizeRecord：remindDays 非法回退 60、越界钳制 1..365', () => {
  assert.equal(normalizeRecord({ remindDays: 'abc' }).remindDays, 60);
  assert.equal(normalizeRecord({ remindDays: '' }).remindDays, 60);
  assert.equal(normalizeRecord({ remindDays: null }).remindDays, 60);
  assert.equal(normalizeRecord({ remindDays: 0 }).remindDays, 1);
  assert.equal(normalizeRecord({ remindDays: -5 }).remindDays, 1);
  assert.equal(normalizeRecord({ remindDays: 1000 }).remindDays, 365);
  assert.equal(normalizeRecord({ remindDays: '90' }).remindDays, 90);
  assert.equal(normalizeRecord({ remindDays: 1 }).remindDays, 1);
  assert.equal(normalizeRecord({ remindDays: 365 }).remindDays, 365);
});

test('normalizeRecord：images 按文件名去重并清洗字段', () => {
  const rec = normalizeRecord({
    images: [
      { file: 'a.png', w: 100, h: 50, size: 1000, addedAt: '2026-01-01T00:00:00.000Z' },
      { file: 'a.png', w: 999, h: 999, size: 9 }, // 重复文件名丢弃
      { file: ' b.png ', w: '20', h: '10' },
      { file: '' }, // 空文件名丢弃
      null, // 非对象丢弃
    ],
  });
  assert.equal(rec.images.length, 2);
  assert.equal(rec.images[0].file, 'a.png');
  assert.equal(rec.images[0].w, 100);
  assert.equal(rec.images[1].file, 'b.png');
  assert.equal(rec.images[1].w, 20);
  assert.equal(rec.images[1].h, 10);
  assert.equal(normalizeRecord({ images: 'bad' }).images.length, 0);
});

test('summarize：四态计数与 total', () => {
  const records = [
    { expiry: '2026-11-22' }, // over
    { expiry: '2026-11-23' }, // soon（0 天）
    { expiry: '2027-01-22' }, // soon（60 天）
    { expiry: '2027-01-23' }, // ok（61 天）
    { expiry: '' }, // none
    { expiry: '坏日期' }, // none
  ];
  assert.deepEqual(summarize(records, NOW), { total: 6, over: 1, soon: 2, ok: 1, none: 2 });
  assert.deepEqual(summarize([], NOW), { total: 0, over: 0, soon: 0, ok: 0, none: 0 });
});

test('toCsv：无 BOM、表头正确、基础行内容', () => {
  const csv = toCsv([makeExisting({ name: '平台A', expiry: '2026-12-31' })]);
  assert.ok(csv.startsWith('平台名称,网址,账户,密码,CA口令,截止有效期,提醒天数,备注'));
  assert.notEqual(csv.charCodeAt(0), 0xfeff);
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith('平台A,https://a.com/,ACC,p1,ca1,2026-12-31,60,旧备注'));
  assert.equal(toCsv([]), CSV_HEADER.join(','));
});

test('toCsv：逗号 / 双引号 / 换行转义 + 公式注入前缀', () => {
  const rec = {
    id: 'r_1',
    name: '平台,含逗号',
    url: '',
    account: '他说"好"',
    password: '',
    caPassword: '',
    expiry: '',
    remindDays: 60,
    note: '第一行\n第二行',
  };
  const csv = toCsv([rec]);
  assert.ok(csv.includes('"平台,含逗号"'));
  assert.ok(csv.includes('"他说""好"""'));
  assert.ok(csv.includes('"第一行\n第二行"'));
  // 公式注入：= + - @ 开头的字符串前置单引号
  const danger = toCsv([
    { name: '=1+1', url: '', account: '', password: '+86', caPassword: '-abc', expiry: '', remindDays: 60, note: '@cmd' },
  ]);
  assert.ok(danger.includes("'=1+1"));
  assert.ok(danger.includes("'+86"));
  assert.ok(danger.includes("'-abc"));
  assert.ok(danger.includes("'@cmd"));
});

test('toCsv → fromCsv 往返：含逗号 / 引号 / 换行的值原样还原', () => {
  const source = normalizeRecord({
    name: '平台,名称',
    url: 'https://a.com/?x=1,2',
    account: '他说"好"',
    password: 'p@ss,word',
    caPassword: 'ca"1',
    expiry: '2026-05-10',
    remindDays: 30,
    note: '第一行\n第二行\r\n第三行',
  });
  const back = fromCsv(toCsv([source]));
  assert.equal(back.errors.length, 0);
  assert.equal(back.records.length, 1);
  const r = back.records[0];
  assert.equal(r.name, source.name);
  assert.equal(r.url, source.url);
  assert.equal(r.account, source.account);
  assert.equal(r.password, source.password);
  assert.equal(r.caPassword, source.caPassword);
  assert.equal(r.expiry, source.expiry);
  assert.equal(r.remindDays, source.remindDays);
  assert.equal(r.note, source.note);
});

test('fromCsv：去 BOM、列乱序、缺列忽略、多列忽略、空行跳过', () => {
  const text = [
    '\ufeff备注,无关列,平台名称,提醒天数,网址',
    '',
    '备注1,忽略我,平台A,abc,https://a.com/',
    '   ',
    ',忽略,平台B,30,',
  ].join('\r\n');
  const out = fromCsv(text);
  assert.equal(out.errors.length, 0);
  assert.equal(out.records.length, 2);
  assert.equal(out.records[0].name, '平台A');
  assert.equal(out.records[0].note, '备注1');
  assert.equal(out.records[0].remindDays, 60); // 非数字 → 60
  assert.equal(out.records[0].url, 'https://a.com/');
  assert.equal(out.records[1].name, '平台B');
  assert.equal(out.records[1].remindDays, 30);
  // 缺列（账户 / 密码 / CA口令 / 截止有效期）不产生字段
  assert.equal('account' in out.records[0], false);
  assert.equal('expiry' in out.records[0], false);
  // 多列表不进入记录
  assert.equal('无关列' in out.records[0], false);
  assert.equal(Object.keys(out.records[0]).includes('ignore'), false);
});

test('fromCsv：平台名为空记错误并跳过；非法日期记错误但保留行；缺表头报错', () => {
  const text = [
    '平台名称,截止有效期,提醒天数',
    '平台A,2026-02-30,60',
    ',2026-05-01,60',
    '平台B,2026/5/1,999',
  ].join('\n');
  const out = fromCsv(text);
  assert.equal(out.records.length, 2); // 空名称行被跳过
  assert.equal(out.errors.length, 2); // 非法日期 + 空名称
  assert.equal(out.records[0].name, '平台A');
  assert.equal(out.records[0].expiry, ''); // 非法日期置空但保留该行
  assert.equal(out.errors[0].line, 2);
  assert.match(out.errors[0].message, /截止有效期/);
  assert.equal(out.errors[1].line, 3);
  assert.match(out.errors[1].message, /平台名称/);
  assert.equal(out.records[1].name, '平台B');
  assert.equal(out.records[1].expiry, '2026-05-01'); // 合法日期统一为 YYYY-MM-DD
  assert.equal(out.records[1].remindDays, 365); // 越界钳制

  const noHeader = fromCsv('网址,账户\nhttps://a.com/,acc');
  assert.equal(noHeader.records.length, 0);
  assert.equal(noHeader.errors.length, 1);
  assert.match(noHeader.errors[0].message, /平台名称/);

  assert.deepEqual(fromCsv(''), { records: [], errors: [] });
});

test('fromCsv：引号内的逗号 / 双引号 / 换行 + 跨行时行号正确', () => {
  const text = [
    '平台名称,备注',
    '"平台,名称","他说""好"""',
    '"平台B","第一行',
    '第二行"',
    ',坏行',
  ].join('\n');
  const out = fromCsv(text);
  assert.equal(out.records.length, 2);
  assert.equal(out.records[0].name, '平台,名称');
  assert.equal(out.records[0].note, '他说"好"');
  assert.equal(out.records[1].name, '平台B');
  assert.equal(out.records[1].note, '第一行\n第二行');
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].line, 5); // 跨行记录之后，物理行号仍准确
});

test('dedupeKey：trim + 小写；空 url/account 得到 "|"', () => {
  assert.equal(dedupeKey({ url: ' HTTPS://A.COM/ ', account: ' ACC ' }), 'https://a.com/|acc');
  assert.equal(dedupeKey({ url: '', account: '' }), '|');
  assert.equal(dedupeKey({}), '|');
  assert.equal(dedupeKey(null), '|');
  assert.equal(dedupeKey({ url: 'https://a.com/', account: '' }), 'https://a.com/|');
});

test('mergeImport：命中时覆盖 incoming 字段，保留 id/createdAt/images/remindOff', () => {
  const existing = [makeExisting()];
  const incoming = [{
    name: '新名字',
    url: 'HTTPS://A.COM/',
    account: 'acc',
    password: 'p2',
    note: '新备注',
  }];
  const out = mergeImport(existing, incoming);
  assert.equal(out.added, 0);
  assert.equal(out.updated, 1);
  assert.equal(out.records.length, 1);
  const merged = out.records[0];
  assert.equal(merged.id, 'r_keep001');
  assert.equal(merged.name, '新名字');
  assert.equal(merged.url, 'HTTPS://A.COM/'); // 覆盖为 incoming 原值（去首尾空格）
  assert.equal(merged.account, 'acc');
  assert.equal(merged.password, 'p2');
  assert.equal(merged.note, '新备注');
  assert.equal(merged.createdAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(merged.images, existing[0].images);
  assert.equal(merged.remindOff, true);
  assert.notEqual(merged.updatedAt, '2026-01-02T00:00:00.000Z'); // 覆盖时刷新 updatedAt
  // 原数组不被修改
  assert.equal(existing[0].name, '旧平台');
  assert.equal(existing.length, 1);
});

test('mergeImport：null/undefined/空字符串默认都不覆盖，emptyOverwrites 才清空', () => {
  const existing = [makeExisting()];
  const out = mergeImport(existing, [{
    url: 'https://a.com/',
    account: 'ACC',
    note: null,
    caPassword: undefined,
    password: '',
  }]);
  assert.equal(out.updated, 0);
  assert.equal(out.unchanged, 1); // 没有任何实际改动
  assert.equal(out.records[0].note, '旧备注'); // null 不覆盖
  assert.equal(out.records[0].caPassword, 'ca1'); // undefined 不覆盖
  assert.equal(out.records[0].password, 'p1'); // 空单元格不清空原密码
  assert.equal(out.records[0].updatedAt, '2026-01-02T00:00:00.000Z'); // 无改动不刷新

  const cleared = mergeImport(existing, [{ url: 'https://a.com/', account: 'ACC', password: '   ' }], [], { emptyOverwrites: true });
  assert.equal(cleared.records[0].password, ''); // 显式清空模式生效
  assert.equal(cleared.updated, 1);
  assert.equal(cleared.unchanged, 0);
});

test('mergeImport：未命中新增并生成 id；"|" 键不去重', () => {
  const existing = [makeExisting()];
  const out = mergeImport(existing, [
    { name: '新平台', url: 'https://b.com/', account: 'B' },
    { name: '无链接1', url: '', account: '' },
    { name: '无链接2', url: '', account: '' },
  ]);
  assert.equal(out.added, 3);
  assert.equal(out.updated, 0);
  assert.equal(out.records.length, 4);
  assert.match(out.records[1].id, /^r_[0-9a-z]+$/);
  assert.equal(out.records[1].id === 'r_keep001', false);
  assert.equal(out.records[1].remindDays, DEFAULT_REMIND_DAYS);
  // 两条空 key 记录各自新增
  assert.equal(out.records[2].name, '无链接1');
  assert.equal(out.records[3].name, '无链接2');
});

test('mergeImport：errors 原样透传（第三参数与 {records, errors} 两种入参）', () => {
  const errors = [{ line: 7, message: '第 7 行有问题' }];
  const out1 = mergeImport([], [], errors);
  assert.deepEqual(out1.errors, errors);
  assert.notEqual(out1.errors, errors); // 返回副本，避免外部修改互相影响

  const csvOut = {
    records: [{ name: '平台A', url: 'https://a.com/', account: 'A' }],
    errors: [{ line: 2, message: '坏行' }],
  };
  const out2 = mergeImport([], csvOut);
  assert.equal(out2.added, 1);
  assert.deepEqual(out2.errors, [{ line: 2, message: '坏行' }]);
});

test('mergeImport：重复 incoming 命中同一 key 时先新增、后覆盖', () => {
  const out = mergeImport([], [
    { name: '平台A', url: 'https://a.com/', account: 'A' },
    { name: '平台A改', url: 'https://a.com/', account: 'A' },
  ]);
  assert.equal(out.added, 1);
  assert.equal(out.updated, 1);
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].name, '平台A改');
});

test('地区：REGIONS 34 项、REGION_GEO 覆盖全部、guessRegion 从名称/备注识别', () => {
  assert.equal(REGIONS.length, 34);
  assert.equal(Object.keys(REGION_GEO).length, 34);
  assert.equal(REGION_GEO['内蒙古'], '内蒙古自治区');
  assert.equal(REGION_GEO['广西'], '广西壮族自治区');
  assert.equal(guessRegion('内蒙古电力集团（示例）', ''), '内蒙古');
  assert.equal(guessRegion('北京市采购平台（示例）', ''), '北京');
  assert.equal(guessRegion('湖南省招投标平台（示例）', ''), '湖南');
  assert.equal(guessRegion('示例采购平台', 'https://demo.example.com/'), '');
  assert.equal(guessRegion('', '', '北京 CA（使用中招互连 app）'), '北京');
  assert.equal(guessRegion(), '');
});

test('地区：normalizeRecord 保留 region（去空白），缺省为空串', () => {
  const rec = normalizeRecord({ name: 'A', region: '  广西 ' });
  assert.equal(rec.region, '广西');
  assert.equal(normalizeRecord({ name: 'B' }).region, '');
});

test('地区：CSV 第 9 列往返，老文件没有「地区」列也能导入', () => {
  const csv = toCsv([{ name: '甲平台', url: 'https://a.com/', account: 'A', region: '上海' }]);
  assert.match(csv.split('\r\n')[0], /备注,地区$/);
  const back = fromCsv(csv);
  assert.equal(back.records[0].region, '上海');
  assert.deepEqual(back.errors, []);

  const legacy = '平台名称,网址,账户\r\n乙平台,https://b.com/,B';
  const old = fromCsv(legacy);
  assert.deepEqual(old.errors, []);
  assert.equal(old.records[0].name, '乙平台');
  assert.equal(old.records[0].region, undefined);
});

test('地区：mergeImport 覆盖已有记录时带上 region', () => {
  const out = mergeImport(
    [makeExisting({ region: '广东' })],
    [{ name: '旧平台', url: 'https://a.com/', account: 'ACC', region: '福建' }]
  );
  assert.equal(out.updated, 1);
  assert.equal(out.records[0].region, '福建');
});


test('地区：normalizeRegion 认全名 / 别名 / 裸名，认不出原样返回', () => {
  assert.equal(normalizeRegion('内蒙古自治区'), '内蒙古');
  assert.equal(normalizeRegion('内蒙'), '内蒙古');
  assert.equal(normalizeRegion('广西壮族自治区'), '广西');
  assert.equal(normalizeRegion('广东省'), '广东');
  assert.equal(normalizeRegion(' 北京 '), '北京');
  assert.equal(normalizeRegion('不存在的省份'), '不存在的省份');
  assert.equal(normalizeRegion(''), '');
});

test('mergeImport：返回 updates（字段旧值→新值）与 addedNames，地区先归一', () => {
  const existing = [makeExisting({ region: '甘肃' })];
  const out = mergeImport(existing, [
    { name: '旧平台', url: 'https://a.com/', account: 'ACC', expiry: '2028-01-31', note: '改期了', region: '甘肃自治区' },
    { name: '新平台', url: 'https://b.com/', account: 'B', region: '云南' },
  ]);
  assert.equal(out.updated, 1);
  assert.equal(out.added, 1);
  assert.equal(out.updates.length, 1);
  const changed = out.updates[0].changed;
  const fields = changed.map((c) => c.field);
  assert.ok(fields.includes('expiry'));
  assert.ok(fields.includes('note'));
  assert.ok(!fields.includes('region'), '地区归一后与旧值相同，不应算改动');
  assert.equal(out.records[0].region, '甘肃');
  assert.deepEqual(out.addedNames, [{ name: '新平台', account: 'B' }]);
});

test('mergeImport：内容完全相同记 unchanged，不进 updates', () => {
  const out = mergeImport([makeExisting()], [{ name: '旧平台', url: 'https://a.com/', account: 'ACC' }]);
  assert.equal(out.updated, 0);
  assert.equal(out.unchanged, 1);
  assert.equal(out.updates.length, 0);
});
