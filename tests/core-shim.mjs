// 测试兼容层（core-shim.mjs）
// app/core.js 已改为 classic script（IIFE 挂 window.CVCore）。这里用 node:fs 读源码、node:vm 在
// { window, console } 沙箱里执行（不依赖浏览器），再把全部名字以命名导出形式提供给 tests/core.test.mjs。
//
// 注意：vm 独立上下文里创建的对象/数组用的是沙箱 realm 的原型，tests 用的 assert/strict（deepStrictEqual）
// 会因此判"结构相同但引用不同"。所以所有导出值统一 structuredClone 回主 realm（只处理纯数据，无副作用）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const corePath = fileURLToPath(new URL('../app/core.js', import.meta.url));
const source = readFileSync(corePath, 'utf8');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: corePath });

const core = sandbox.window.CVCore;
if (!core || typeof core.statusOf !== 'function') {
  throw new Error('加载 app/core.js 失败：window.CVCore 未挂载');
}

// 纯数据回主 realm；函数包装后同样把返回值回主 realm
const toHost = (value) => (value !== null && typeof value === 'object' ? structuredClone(value) : value);
const call = (name) => {
  const fn = core[name];
  if (typeof fn !== 'function') throw new Error(`app/core.js 缺少函数 ${name}`);
  return (...args) => toHost(fn(...args));
};

export const STATUS_LABEL = toHost(core.STATUS_LABEL);
export const CSV_HEADER = toHost(core.CSV_HEADER);
export const DEFAULT_REMIND_DAYS = core.DEFAULT_REMIND_DAYS;
export const makeId = call('makeId');
export const todayStr = call('todayStr');
export const parseDate = call('parseDate');
export const daysLeft = call('daysLeft');
export const statusOf = call('statusOf');
export const normalizeRecord = call('normalizeRecord');
export const summarize = call('summarize');
export const toCsv = call('toCsv');
export const fromCsv = call('fromCsv');
export const dedupeKey = call('dedupeKey');
export const mergeImport = call('mergeImport');
export const REGIONS = toHost(core.REGIONS);
export const REGION_GEO = toHost(core.REGION_GEO);
export const guessRegion = call('guessRegion');
export const REGION_ALIAS = toHost(core.REGION_ALIAS);
export const normalizeRegion = call('normalizeRegion');
