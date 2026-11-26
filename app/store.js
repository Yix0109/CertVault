// CertVault 文件系统层（store.js）
// 职责：File System Access API 读写用户数据文件夹 + IndexedDB 记住文件夹句柄 + 截图 / 备份 / 锁 / 审计。
// 约束：classic script（IIFE，末尾挂载 window.CVStore），零第三方依赖；只在浏览器里调用，Node 下仅保证可 vm 加载。
// 错误约定：所有文件操作失败都抛 new Error('中文可读原因')，由 app.js 捕获成 toast。
(function () {
  'use strict';

const DB_NAME = 'certvault';
const DB_STORE = 'kv';
const DB_VERSION = 1;
const DB_KEY_ROOT = 'root';

const DATA_DIR = 'data';
const IMAGES_DIR = 'images';
const BACKUP_DIR = 'backup';
const RECORDS_FILE = 'certvault.json';
const SETTINGS_FILE = 'settings.json';
const AUDIT_FILE = 'audit.json';
const LOCK_FILE = '.lock';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 单张截图上限 8MB，超过跳过
const BACKUP_KEEP = 10; // backup 目录只保留最近 10 份（与使用说明一致）
const BACKUP_RE = /^\d{8}-\d{6}-[A-Za-z0-9_-]+\.json$/;
const AUDIT_LIMIT = 200; // 审计日志最多保留 200 条
const LOCK_STALE_MS = 4 * 60 * 60 * 1000; // 锁超过 4 小时视为陈旧（浏览器版无真实单实例，仅提示）

const DEFAULT_SETTINGS = {
  version: 1,
  trayMinimize: true,
  autostart: false,
  popupIntervalHours: 12,
  backupBeforeDanger: true,
  lastPopupAt: null,
  lastOpen: null,
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 从备份文件名（yyyyMMdd-HHmmss-reason.json）还原时间戳，失败返回 0
function stampToTime(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(String(name || ''));
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

// 本地时间戳：yyyyMMdd-HHmmss（备份文件名 / 截图文件名用）
function stampCompact(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

// 短随机串（base36），用于截图文件名与锁 id
function randToken(len = 4) {
  let s = '';
  while (s.length < len) s += Math.random().toString(36).slice(2);
  return s.slice(0, len);
}

function isNotFound(err) {
  return !!err && err.name === 'NotFoundError';
}

// 把浏览器底层异常翻译成中文可读原因
function describe(err) {
  if (!err) return '未知错误';
  if (err.name === 'NotAllowedError') return '没有读写权限，请点「重新连接」重新授权文件夹';
  if (err.name === 'NotFoundError') return '文件或目录不存在';
  if (err.name === 'TypeMismatchError') return '文件类型不匹配';
  if (err.name === 'SecurityError') return '浏览器安全策略拒绝了该操作';
  if (err.name === 'QuotaExceededError') return '磁盘空间不足';
  if (err.name === 'InvalidStateError') return '文件状态异常，请重试';
  if (err.message) return String(err.message);
  return String(err.name || '未知错误');
}

// ---------- IndexedDB：只存一个文件夹句柄 ----------
function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持 IndexedDB，无法记住数据文件夹位置'));
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(new Error('打开本地数据库失败：' + describe(err)));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('打开本地数据库失败：' + describe(req.error)));
  });
}

async function idbGet(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(DB_STORE, 'readonly');
      } catch (err) {
        reject(new Error('读取本地数据库失败：' + describe(err)));
        return;
      }
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('读取本地数据库失败：' + describe(req.error)));
    });
  } finally {
    db.close();
  }
}

async function idbSet(key, value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(DB_STORE, 'readwrite');
      } catch (err) {
        reject(new Error('写入本地数据库失败：' + describe(err)));
        return;
      }
      const req = tx.objectStore(DB_STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error('写入本地数据库失败：' + describe(req.error)));
    });
  } finally {
    db.close();
  }
}

// 根据文件对象推断扩展名（保留原扩展名；无扩展名时按 MIME 猜，兜底 png）
function extOf(file) {
  const name = String((file && file.name) || '');
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  if (m) {
    const ext = m[1].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (ext) return ext;
  }
  const type = String((file && file.type) || '');
  const t = /^image\/([a-z0-9.+-]+)$/i.exec(type);
  if (t) {
    const ext = t[1].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (ext === 'jpeg') return 'jpg';
    if (ext) return ext;
  }
  return 'png';
}

class Store {
  constructor(handle) {
    this.handle = handle || null;
    this.needsPermission = false;
    this.lastPruned = [];
    this.lastRecovered = null;
  }

  // 浏览器（Edge/Chrome）的 file:// 下 isSecureContext 为 true，该 API 可用
  static supported() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  }

  /**
   * 弹出系统文件夹选择器；成功后把句柄写进 IndexedDB 并初始化 data / images / backup。
   * @returns {Promise<Store>}
   */
  static async pick() {
    if (!Store.supported()) {
      throw new Error('当前浏览器不支持选择数据文件夹，请使用新版 Edge 或 Chrome 打开');
    }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'certvault' });
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('已取消选择数据文件夹');
      throw new Error('选择数据文件夹失败：' + describe(err));
    }
    const store = new Store(handle);
    await store._ensureDirs();
    try {
      await idbSet(DB_KEY_ROOT, handle);
    } catch (err) {
      throw new Error('记住数据文件夹失败：' + describe(err) + '（本次仍可使用，下次需重新选择）');
    }
    store.needsPermission = false;
    return store;
  }

  /**
   * 恢复上次选择的文件夹：没有记录返回 null（首次使用/演示模式）；
   * 有记录但未授权时返回 Store 实例并置 needsPermission = true。
   * @returns {Promise<Store|null>}
   */
  static async restore() {
    if (!Store.supported()) return null;
    let handle;
    try {
      handle = await idbGet(DB_KEY_ROOT);
    } catch (err) {
      throw new Error('读取上次的数据文件夹记录失败：' + describe(err));
    }
    if (!handle) return null;
    const store = new Store(handle);
    try {
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      store.needsPermission = permission !== 'granted';
    } catch (err) {
      // 句柄失效（文件夹被移动/删除）时按“需要重新授权”处理，让界面显示重连横幅
      store.needsPermission = true;
    }
    return store;
  }

  get folderName() {
    return this.handle && this.handle.name ? String(this.handle.name) : '';
  }

  /**
   * 申请读写权限（必须由用户点击触发）。
   * @returns {Promise<boolean>} 是否已授权
   */
  async grant() {
    this._guardHandle();
    try {
      const permission = await this.handle.requestPermission({ mode: 'readwrite' });
      const granted = permission === 'granted';
      this.needsPermission = !granted;
      if (granted) await this._ensureDirs();
      return granted;
    } catch (err) {
      throw new Error('申请数据文件夹权限失败：' + describe(err));
    }
  }

  // ---------- 内部工具 ----------
  _guardHandle() {
    if (!this.handle) throw new Error('尚未选择数据文件夹，请先连接文件夹');
  }

  _guardAccess() {
    this._guardHandle();
    if (this.needsPermission) throw new Error('尚未获得数据文件夹的读写权限，请点「重新连接」后授权');
  }

  async _ensureDirs() {
    this._guardHandle();
    try {
      await this.handle.getDirectoryHandle(DATA_DIR, { create: true });
      await this.handle.getDirectoryHandle(IMAGES_DIR, { create: true });
      await this.handle.getDirectoryHandle(BACKUP_DIR, { create: true });
    } catch (err) {
      throw new Error('初始化 data / images / backup 目录失败：' + describe(err));
    }
  }

  async _dir(name, create = true) {
    try {
      return await this.handle.getDirectoryHandle(name, { create });
    } catch (err) {
      throw new Error(`打开 ${name} 目录失败：` + describe(err));
    }
  }

  async _readJson(dirHandle, name) {
    let fileHandle;
    let fromTmp = false;
    try {
      fileHandle = await dirHandle.getFileHandle(name);
    } catch (err) {
      if (!isNotFound(err)) throw new Error(`读取 ${name} 失败：` + describe(err));
      // 上次写入在「落 .tmp」与「替换正式文件」之间中断：正式文件不在，但 .tmp 是完整的
      try {
        fileHandle = await dirHandle.getFileHandle(name + '.tmp');
        fromTmp = true;
      } catch (err2) {
        if (isNotFound(err2)) return undefined; // 文件不存在由调用方决定缺省值
        throw new Error(`读取 ${name} 失败：` + describe(err2));
      }
    }
    let text;
    try {
      const file = await fileHandle.getFile();
      text = await file.text();
    } catch (err) {
      throw new Error(`读取 ${name} 失败：` + describe(err));
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`${name} 内容不是合法 JSON，文件可能已损坏（可从 backup 目录恢复）`);
    }
    if (fromTmp) {
      // 上次写入中断留下的完整副本：读回来之后补写正式文件，避免下次再走兜底
      this.lastRecovered = name;
      try { await this._writeJson(dirHandle, name, parsed); } catch (err) { /* 补写失败不影响本次读取 */ }
    }
    return parsed;
  }

  async _writeJson(dirHandle, name, value) {
    let text;
    try {
      text = JSON.stringify(value, null, 2);
    } catch (err) {
      throw new Error(`保存 ${name} 失败：数据无法序列化`);
    }
    try {
      const fileHandle = await dirHandle.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(text);
      await writable.close();
    } catch (err) {
      throw new Error(`保存 ${name} 失败：` + describe(err));
    }
  }

  // ---------- 记录读写 ----------
  async readRecords() {
    this._guardAccess();
    await this._ensureDirs();
    const dataDir = await this._dir(DATA_DIR);
    const parsed = await this._readJson(dataDir, RECORDS_FILE);
    if (parsed === undefined) return [];
    const records = Array.isArray(parsed) ? parsed : parsed && parsed.records;
    if (!Array.isArray(records)) throw new Error('数据文件格式异常：records 不是数组');
    return records;
  }

  async writeRecords(records) {
    if (!Array.isArray(records)) throw new Error('保存记录失败：records 必须是数组');
    this._guardAccess();
    await this._ensureDirs();
    const dataDir = await this._dir(DATA_DIR);
    await this._writeJson(dataDir, RECORDS_FILE, {
      version: 1,
      updatedAt: new Date().toISOString(),
      records,
    });
  }

  // ---------- 设置读写 ----------
  async readSettings() {
    this._guardAccess();
    await this._ensureDirs();
    const dataDir = await this._dir(DATA_DIR);
    const parsed = await this._readJson(dataDir, SETTINGS_FILE);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...parsed, version: 1 };
  }

  async writeSettings(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('保存设置失败：参数必须是对象');
    }
    this._guardAccess();
    await this._ensureDirs();
    const dataDir = await this._dir(DATA_DIR);
    await this._writeJson(dataDir, SETTINGS_FILE, { ...DEFAULT_SETTINGS, ...obj, version: 1 });
  }

  // ---------- 截图 ----------
  /**
   * 保存截图到 images/<recordId>/，并读取宽高。
   * 单文件 >8MB 或非图片文件会跳过；宽高读取失败记 0。
   * @param {string} recordId
   * @param {File[]|FileList} files
   * @returns {Promise<{file:string,w:number,h:number,size:number,addedAt:string}[]>}
   */
  async addImages(recordId, files) {
    this._guardAccess();
    const rid = String(recordId || '').trim();
    if (!rid) throw new Error('保存截图失败：记录 id 为空');
    const list = files && typeof files.length === 'number' ? Array.from(files) : [];
    const result = [];
    if (list.length === 0) return result;
    await this._ensureDirs();
    let recordDir;
    try {
      const imagesDir = await this._dir(IMAGES_DIR);
      recordDir = await imagesDir.getDirectoryHandle(rid, { create: true });
    } catch (err) {
      throw new Error('创建截图目录失败：' + describe(err));
    }
    for (const file of list) {
      if (!file || typeof file !== 'object') continue;
      if (Number(file.size) > MAX_IMAGE_BYTES) continue; // 超大文件跳过
      if (file.type && !String(file.type).startsWith('image/')) continue; // 非图片跳过
      const meta = await this._writeImage(recordDir, file);
      result.push(meta);
    }
    return result;
  }

  async _writeImage(recordDir, file) {
    const fileName = `${stampCompact()}-${randToken(4)}.${extOf(file)}`;
    try {
      const fileHandle = await recordDir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(file);
      await writable.close();
    } catch (err) {
      throw new Error('写入截图文件失败：' + describe(err));
    }
    let w = 0;
    let h = 0;
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file);
        w = bitmap.width || 0;
        h = bitmap.height || 0;
        if (typeof bitmap.close === 'function') bitmap.close();
      } catch (err) {
        w = 0; // 宽高读不出来不算失败，记 0 即可
        h = 0;
      }
    }
    return {
      file: fileName,
      w,
      h,
      size: Number(file.size) || 0,
      addedAt: new Date().toISOString(),
    };
  }

  async deleteImage(recordId, file) {
    this._guardAccess();
    const rid = String(recordId || '').trim();
    const name = String(file || '').trim();
    if (!rid || !name) return;
    try {
      const imagesDir = await this._dir(IMAGES_DIR);
      const recordDir = await imagesDir.getDirectoryHandle(rid);
      await recordDir.removeEntry(name);
    } catch (err) {
      if (isNotFound(err)) return; // 已经不存在视为删除成功
      throw new Error('删除截图失败：' + describe(err));
    }
  }

  async deleteRecordImages(recordId) {
    this._guardAccess();
    const rid = String(recordId || '').trim();
    if (!rid) return;
    try {
      const imagesDir = await this._dir(IMAGES_DIR);
      await imagesDir.removeEntry(rid, { recursive: true });
    } catch (err) {
      if (isNotFound(err)) return; // 目录不存在不报错
      throw new Error('删除记录截图目录失败：' + describe(err));
    }
  }

  /**
   * 读取截图为 Blob（浏览器里 File 即 Blob）。
   * @returns {Promise<Blob|null>} 不存在返回 null
   */
  async imageBlob(recordId, file) {
    this._guardAccess();
    const rid = String(recordId || '').trim();
    const name = String(file || '').trim();
    if (!rid || !name) return null;
    try {
      const imagesDir = await this._dir(IMAGES_DIR);
      const recordDir = await imagesDir.getDirectoryHandle(rid);
      const fileHandle = await recordDir.getFileHandle(name);
      return await fileHandle.getFile();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new Error('读取截图失败：' + describe(err));
    }
  }

  // ---------- 备份 ----------
  /**
   * 把 data/certvault.json 复制到 backup/<yyyymmdd-HHmmss>-<reason>.json。
   * 还没有数据文件时返回 null（无需备份）。
   * @param {string} reason
   * @returns {Promise<string|null>} 备份文件名
   */
  async backup(reason) {
    this._guardAccess();
    await this._ensureDirs();
    const dataDir = await this._dir(DATA_DIR);
    let text;
    try {
      const fileHandle = await dataDir.getFileHandle(RECORDS_FILE);
      const file = await fileHandle.getFile();
      text = await file.text();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new Error('备份失败：读取数据文件出错（' + describe(err) + '）');
    }
    const safeReason = String(reason || 'manual')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'manual';
    const fileName = `${stampCompact()}-${safeReason}.json`;
    try {
      const backupDir = await this._dir(BACKUP_DIR);
      const fileHandle = await backupDir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(text);
      await writable.close();
    } catch (err) {
      throw new Error('备份失败：写入 backup 目录出错（' + describe(err) + '）');
    }
    // 只留最近 BACKUP_KEEP 份，避免 backup 目录无限增长（历史口令不会永久堆积）
    try {
      this.lastPruned = await this._pruneBackups(await this._dir(BACKUP_DIR));
    } catch (err) {
      this.lastPruned = []; // 清理失败不影响本次备份
    }
    return fileName;
  }

  async _listNames(dirHandle) {
    const names = [];
    try {
      for await (const entry of dirHandle.values()) names.push(String(entry.name));
    } catch (err) {
      throw new Error('列出目录失败：' + describe(err));
    }
    return names;
  }

  // 按文件名（即时间）排序，删掉最旧的若干份；返回被删的文件名
  async _pruneBackups(backupDir) {
    const files = (await this._listNames(backupDir)).filter((n) => BACKUP_RE.test(n)).sort();
    if (files.length <= BACKUP_KEEP) return [];
    const drop = files.slice(0, files.length - BACKUP_KEEP);
    const removed = [];
    for (const name of drop) {
      try {
        await backupDir.removeEntry(name);
        removed.push(name);
      } catch (err) {
        // 删不掉就留到下次，不影响本次备份
      }
    }
    return removed;
  }

  /**
   * 备份概况：份数、最近一份名称与时间、总字节。设置面板与自动备份判断用。
   * @returns {Promise<{count:number,latest:string,latestAt:number,bytes:number}>}
   */
  async backupInfo() {
    const empty = { count: 0, latest: '', latestAt: 0, bytes: 0 };
    this._guardAccess();
    await this._ensureDirs();
    try {
      const backupDir = await this._dir(BACKUP_DIR);
      const files = (await this._listNames(backupDir)).filter((n) => BACKUP_RE.test(n)).sort();
      if (!files.length) return empty;
      let bytes = 0;
      for (const name of files) {
        try {
          const fileHandle = await backupDir.getFileHandle(name);
          const file = await fileHandle.getFile();
          bytes += Number(file.size) || 0;
        } catch (err) {
          // 单个文件读不到不影响汇总
        }
      }
      const latest = files[files.length - 1];
      return { count: files.length, latest, latestAt: stampToTime(latest), bytes };
    } catch (err) {
      return empty;
    }
  }

  // ---------- 占用标记（浏览器版无真实单实例，仅作提示） ----------
  async lock() {
    this._guardAccess();
    await this._ensureDirs();
    const dataDir = await this._dir(DATA_DIR);
    const info = { id: `lock_${Date.now().toString(36)}${randToken(6)}`, ts: Date.now() };
    await this._writeJson(dataDir, LOCK_FILE, info);
    return info;
  }

  async unlock() {
    this._guardAccess();
    await this._ensureDirs();
    const dataDir = await this._dir(DATA_DIR);
    try {
      await dataDir.removeEntry(LOCK_FILE);
    } catch (err) {
      if (!isNotFound(err)) throw new Error('解除占用标记失败：' + describe(err));
    }
  }

  /**
   * @returns {Promise<{held:boolean, stale:boolean, ts:number|null}>}
   */
  async lockInfo() {
    this._guardAccess();
    await this._ensureDirs();
    const dataDir = await this._dir(DATA_DIR);
    const parsed = await this._readJson(dataDir, LOCK_FILE);
    if (parsed === undefined) return { held: false, stale: false, ts: null };
    const ts = Number(parsed && parsed.ts);
    if (!Number.isFinite(ts) || ts <= 0) return { held: true, stale: true, ts: null };
    return { held: true, stale: Date.now() - ts > LOCK_STALE_MS, ts };
  }

  // ---------- 操作日志 ----------
  /**
   * 追加一条审计日志，保留最近 200 条。
   * @param {{action:string, detail?:string}} entry
   */
  async audit(entry) {
    this._guardAccess();
    await this._ensureDirs();
    const dataDir = await this._dir(DATA_DIR);
    const parsed = await this._readJson(dataDir, AUDIT_FILE);
    const entries = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
    const item = {
      ts: new Date().toISOString(),
      action: String(entry && entry.action != null ? entry.action : ''),
      detail: entry && entry.detail != null ? String(entry.detail) : '',
    };
    entries.push(item);
    await this._writeJson(dataDir, AUDIT_FILE, { version: 1, entries: entries.slice(-AUDIT_LIMIT) });
    return item;
  }

  async readAudit() {
    this._guardAccess();
    await this._ensureDirs();
    const dataDir = await this._dir(DATA_DIR);
    const parsed = await this._readJson(dataDir, AUDIT_FILE);
    if (parsed === undefined) return [];
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.slice(-AUDIT_LIMIT);
  }
}

/**
 * 触发浏览器下载一段文本（CSV 等）。
 * @param {string} filename
 * @param {string} text
 * @param {string} [mime]
 */
async function downloadText(filename, text, mime = 'text/csv;charset=utf-8') {
  if (typeof document === 'undefined') throw new Error('当前环境无法下载文件');
  try {
    const name = String(filename || 'download.txt');
    const blob = new Blob([text === null || text === undefined ? '' : String(text)], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    throw new Error('下载文件失败：' + describe(err));
  }
}

/**
 * 弹系统文件选择框，返回 File 或 null（用户取消）。
 * @param {string} [accept='.csv']
 * @returns {Promise<File|null>}
 */
function pickTextFile(accept = '.csv') {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      reject(new Error('当前环境无法选择文件'));
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    let timer = null;
    const finish = (file) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(file);
    };
    // 用户取消选择时 change 不触发，用窗口重新获得焦点 + 延时判定为取消
    const onFocus = () => {
      timer = setTimeout(() => {
        if (!input.files || input.files.length === 0) finish(null);
      }, 400);
    };
    input.addEventListener('change', () => {
      finish(input.files && input.files[0] ? input.files[0] : null);
    }, { once: true });
    window.addEventListener('focus', onFocus);
    input.click();
  });
}
  // 经典脚本入口：挂到全局命名空间，供 index.html / app.js 直接使用
  window.CVStore = { Store, downloadText, pickTextFile };
})();
