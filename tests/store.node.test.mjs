// store.js 的 Node 集成测试：用 node:fs 模拟 FileSystemDirectoryHandle，
// 在没有浏览器的环境里把真实读写路径（data/images/backup/lock/audit）跑一遍。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const SRC_STORE = new URL('../app/store.js', import.meta.url);

function notFound() {
  const err = new Error('A requested file or directory could not be found');
  err.name = 'NotFoundError';
  return err;
}
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
function mimeOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream';
}

class NodeHandle {
  constructor(kind, full) {
    this.kind = kind;
    this._full = full;
    this.name = path.basename(full);
  }
  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }
  async getDirectoryHandle(name, opts = {}) {
    const p = path.join(this._full, name);
    try {
      const st = await fs.stat(p);
      if (!st.isDirectory()) { const e = new Error('type mismatch'); e.name = 'TypeMismatchError'; throw e; }
    } catch (err) {
      if (err && err.name === 'TypeMismatchError') throw err;
      if (!opts.create) throw notFound();
      await fs.mkdir(p, { recursive: true });
    }
    return new NodeHandle('dir', p);
  }
  async getFileHandle(name, opts = {}) {
    const p = path.join(this._full, name);
    try {
      const st = await fs.stat(p);
      if (st.isDirectory()) { const e = new Error('type mismatch'); e.name = 'TypeMismatchError'; throw e; }
    } catch (err) {
      if (err && err.name === 'TypeMismatchError') throw err;
      if (!opts.create) throw notFound();
      await fs.writeFile(p, '');
    }
    return new NodeHandle('file', p);
  }
  async removeEntry(name) {
    const p = path.join(this._full, name);
    const st = await fs.stat(p);
    if (st.isDirectory()) await fs.rm(p, { recursive: true, force: true });
    else await fs.unlink(p);
  }
  async *values() {
    const list = await fs.readdir(this._full, { withFileTypes: true });
    for (const ent of list) yield new NodeHandle(ent.isDirectory() ? 'dir' : 'file', path.join(this._full, ent.name));
  }
  async getFile() {
    const buf = await fs.readFile(this._full);
    return new File([buf], this.name, { type: mimeOf(this.name) });
  }
  async createWritable() {
    const target = this._full;
    await fs.writeFile(target, '');
    return {
      async write(chunk) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk instanceof ArrayBuffer ? chunk : await chunk.arrayBuffer());
        await fs.appendFile(target, buf);
      },
      async close() {},
      async abort() {},
    };
  }
}

function loadStore() {
  const code = require_fs_read();
  const sandbox = { window: {}, console, File, Blob, TextEncoder, TextDecoder, Date, Math, JSON, structuredClone };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'store.js' });
  return sandbox.window.CVStore;
}
function require_fs_read() {
  return loadStoreSource();
}
let _src = null;
function loadStoreSource() {
  if (_src) return _src;
  // 同步读取，避免在 vm 里塞 async
  const url = new URL('../app/store.js', import.meta.url);
  _src = readSync(url);
  return _src;
}
import { readFileSync } from 'node:fs';
function readSync(url) { return readFileSync(url, 'utf8'); }

test('store 真实读写：记录 / 截图 / 备份 / 设置 / 锁 / 审计', async () => {
  const { Store } = loadStore();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'certvault-test-'));
  const store = new Store(new NodeHandle('dir', root));
  await store._ensureDirs();
  assert.equal(store.folderName, path.basename(root));

  // 空目录读记录
  const empty = await store.readRecords();
  assert.ok(Array.isArray(empty));
  assert.equal(empty.length, 0);

  // 写记录
  const rec1 = { id: 'r1', name: '平台甲', url: 'https://a.cn', account: 'u1', password: 'p1', caPassword: 'c1', expiry: '2027-01-01', remindDays: 60, note: '', images: [], remindOff: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const rec2 = { ...rec1, id: 'r2', name: '平台乙' };
  await store.writeRecords([rec1, rec2]);
  const back = await store.readRecords();
  assert.equal(back.length, 2);
  assert.equal(back[0].name, '平台甲');
  const raw = await fs.readFile(path.join(root, 'data', 'certvault.json'), 'utf8');
  assert.ok(raw.includes('平台甲'));

  // 图片
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
  const file = new File([png], 'shot.png', { type: 'image/png' });
  const metas = await store.addImages('r1', [file]);
  assert.equal(metas.length, 1, '应写入 1 张截图');
  assert.ok(metas[0].file.endsWith('.png'));
  const imgPath = path.join(root, 'images', 'r1', metas[0].file);
  const onDisk = await fs.readFile(imgPath);
  assert.equal(onDisk.length, png.length);
  const blob = await store.imageBlob('r1', metas[0].file);
  assert.equal(blob.size, png.length);

  // 超大文件与非图片会被跳过
  const big = new File([Buffer.alloc(9 * 1024 * 1024)], 'big.png', { type: 'image/png' });
  const txt = new File(['hello'], 'a.txt', { type: 'text/plain' });
  const metas2 = await store.addImages('r1', [big, txt]);
  assert.equal(metas2.length, 0, '9MB 与 txt 都应被跳过');

  // 删除单图 + 删记录图片
  await store.deleteImage('r1', metas[0].file);
  await assert.rejects(fs.stat(imgPath));
  const metas3 = await store.addImages('r2', [file, file]);
  assert.equal(metas3.length, 2);
  await store.deleteRecordImages('r2');
  await assert.rejects(fs.stat(path.join(root, 'images', 'r2')));

  // 备份
  const backupFile = await store.backup('manual');
  assert.ok(backupFile, 'backup 应返回文件名');
  const backupText = await fs.readFile(path.join(root, 'backup', backupFile), 'utf8');
  assert.ok(backupText.includes('平台甲'));

  // 设置
  await store.writeSettings({ trayMinimize: false, popupIntervalHours: 4 });
  const settings = await store.readSettings();
  assert.equal(settings.trayMinimize, false);
  assert.equal(settings.popupIntervalHours, 4);

  // 审计
  await store.audit({ action: 'add', detail: '平台甲（新增）', at: '2026-01-01T00:00:00.000Z' });
  const audit = await store.readAudit();
  assert.ok(audit.length >= 1);
  assert.equal(audit[audit.length - 1].action, 'add');

  await fs.rm(root, { recursive: true, force: true });
});

test('写入被中断（只剩 .tmp）时能恢复记录并补写正式文件', async () => {
  const { Store } = loadStore();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'certvault-tmp-'));
  const store = new Store(new NodeHandle('dir', root));
  await store._ensureDirs();
  const rec = { id: 'r1', name: '中断平台', url: 'https://a.cn', account: 'u1', password: 'p1', caPassword: '', expiry: '2027-01-01', remindDays: 60, note: '', region: '', images: [], remindOff: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  await store.writeRecords([rec]);

  // 模拟崩溃：正式文件消失，只留完整的 .tmp
  const dataDir = path.join(root, 'data');
  await fs.rename(path.join(dataDir, 'certvault.json'), path.join(dataDir, 'certvault.json.tmp'));

  const recovered = await store.readRecords();
  assert.equal(recovered.length, 1, '应能从 .tmp 读回记录');
  assert.equal(recovered[0].name, '中断平台');
  assert.equal(store.lastRecovered, 'certvault.json', '应记录恢复过的文件名');
  const healed = JSON.parse(await fs.readFile(path.join(dataDir, 'certvault.json'), 'utf8'));
  assert.equal(healed.records[0].name, '中断平台', '应自动补写正式文件');

  // 补写后再次读取走正常路径，不再标记恢复
  store.lastRecovered = null;
  const again = await store.readRecords();
  assert.equal(again.length, 1);
  assert.equal(store.lastRecovered, null);

  await fs.rm(root, { recursive: true, force: true });
});
