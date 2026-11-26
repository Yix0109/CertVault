/*
 * CertVault 桌面版文件桥（宿主注入脚本，必须先于 core.js / store.js / app.js 执行）
 * 作用：在 WebView2 里用宿主（C#）的 System.IO 顶替浏览器 File System Access，
 *       实现 app/store.js 需要的那一小撮目录/文件句柄接口。
 * 协议：{cv:1, id, op, ...} -> {cv:1, id, ok, result|error}
 */
(function () {
  var cw = window.chrome && window.chrome.webview;
  if (!cw || typeof cw.postMessage !== 'function') return;
  window.__CV_DESKTOP__ = true;

  var seq = 0;
  var pending = {};
  function call(op, args) {
    return new Promise(function (resolve, reject) {
      var id = 'r' + (++seq);
      pending[id] = { resolve: resolve, reject: reject };
      var msg = { cv: 1, id: id, op: op };
      if (args) { for (var k in args) { if (Object.prototype.hasOwnProperty.call(args, k)) msg[k] = args[k]; } }
      try { cw.postMessage(msg); } catch (e) { delete pending[id]; reject(e); }
    });
  }

  cw.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.cv !== 1 || !m.id) return;
    var p = pending[m.id];
    if (!p) return;
    delete pending[m.id];
    if (m.ok) { p.resolve(m.result); return; }
    var info = m.error || {};
    var err = new Error(info.message || '文件操作失败');
    err.name = info.name || 'Error';
    p.reject(err);
  });

  function base64Encode(u8) {
    var out = '';
    var chunk = 0x8000;
    for (var i = 0; i < u8.length; i += chunk) {
      out += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + chunk, u8.length)));
    }
    return btoa(out);
  }
  function base64Decode(b64) {
    var bin = atob(b64 || '');
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function toBytes(data) {
    if (data == null) return new Uint8Array(0);
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof Blob !== 'undefined' && data instanceof Blob) return null; // 异步处理
    if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
    return new Uint8Array(0);
  }

  function joinPath(dir, name) {
    return String(dir).replace(/[\\/]+$/, '') + '\\' + String(name);
  }
  function leafName(path) {
    var p = String(path).replace(/\\/g, '/');
    return p.substring(p.lastIndexOf('/') + 1);
  }
  function notFound(name) {
    var err = new Error('找不到「' + name + '」');
    err.name = 'NotFoundError';
    return err;
  }
  function guessType(name) {
    var ext = String(name).toLowerCase().replace(/^.*\./, '');
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'json') return 'application/json';
    return 'application/octet-stream';
  }

  // ---------- 目录句柄 ----------
  function DirHandle(path) { this._path = path; }
  Object.defineProperty(DirHandle.prototype, 'name', { get: function () { return leafName(this._path); } });
  Object.defineProperty(DirHandle.prototype, 'kind', { get: function () { return 'directory'; } });
  DirHandle.prototype.queryPermission = function () { return Promise.resolve('granted'); };
  DirHandle.prototype.requestPermission = function () { return Promise.resolve('granted'); };
  DirHandle.prototype.isSameEntry = function (other) { return Promise.resolve(!!other && other._path === this._path); };

  DirHandle.prototype.getDirectoryHandle = function (name, options) {
    var path = joinPath(this._path, name);
    var create = !!(options && options.create);
    return call('stat', { path: path }).then(function (st) {
      if (!st) {
        if (!create) throw notFound(name);
        return call('mkdir', { path: path }).then(function () { return new DirHandle(path); });
      }
      if (st.kind !== 'dir') {
        var err = new Error('「' + name + '」已存在但不是文件夹');
        err.name = 'TypeMismatchError';
        throw err;
      }
      return new DirHandle(path);
    });
  };

  DirHandle.prototype.getFileHandle = function (name, options) {
    var path = joinPath(this._path, name);
    var create = !!(options && options.create);
    return call('stat', { path: path }).then(function (st) {
      if (!st) {
        if (!create) throw notFound(name);
        return call('touch', { path: path }).then(function () { return new FileHandle(path); });
      }
      if (st.kind === 'dir') {
        var err = new Error('「' + name + '」是文件夹，不能当文件用');
        err.name = 'TypeMismatchError';
        throw err;
      }
      return new FileHandle(path);
    });
  };

  DirHandle.prototype.removeEntry = function (name, options) {
    var path = joinPath(this._path, name);
    var recursive = !!(options && options.recursive);
    return call('stat', { path: path }).then(function (st) {
      if (!st) throw notFound(name);
      return call('remove', { path: path, recursive: recursive });
    });
  };

  DirHandle.prototype.values = function () {
    var self = this;
    var listPromise = call('list', { path: this._path }).then(function (res) {
      return (res && res.entries) || [];
    });
    var i = 0;
    var entries = null;
    return {
      next: function () {
        var ready = entries ? Promise.resolve(entries) : listPromise.then(function (e) { entries = e; return e; });
        return ready.then(function (e) {
          if (i >= e.length) return { done: true, value: undefined };
          var item = e[i++];
          return {
            done: false,
            value: item.kind === 'dir' ? new DirHandle(joinPath(self._path, item.name)) : new FileHandle(joinPath(self._path, item.name))
          };
        });
      },
      [Symbol.asyncIterator]: function () { return this; }
    };
  };

  // ---------- 文件句柄 ----------
  function FileHandle(path) { this._path = path; }
  Object.defineProperty(FileHandle.prototype, 'name', { get: function () { return leafName(this._path); } });
  Object.defineProperty(FileHandle.prototype, 'kind', { get: function () { return 'file'; } });
  FileHandle.prototype.queryPermission = function () { return Promise.resolve('granted'); };
  FileHandle.prototype.requestPermission = function () { return Promise.resolve('granted'); };
  FileHandle.prototype.isSameEntry = function (other) { return Promise.resolve(!!other && other._path === this._path); };

  FileHandle.prototype.getFile = function () {
    var self = this;
    return call('read', { path: this._path }).then(function (res) {
      var bytes = base64Decode((res && res.data) || '');
      return new File([bytes], self.name, {
        type: guessType(self.name),
        lastModified: (res && res.mtime) || Date.now()
      });
    });
  };

  FileHandle.prototype.createWritable = function () {
    var self = this;
    var chunks = [];
    var closed = false;
    return Promise.resolve({
      write: function (data) {
        if (closed) return Promise.reject(new Error('写入流已关闭'));
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
          return data.arrayBuffer().then(function (buf) { chunks.push(new Uint8Array(buf)); });
        }
        chunks.push(toBytes(data));
        return Promise.resolve();
      },
      truncate: function () { chunks.length = 0; return Promise.resolve(); },
      close: function () {
        var total = 0;
        for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
        var all = new Uint8Array(total);
        var offset = 0;
        for (var j = 0; j < chunks.length; j++) { all.set(chunks[j], offset); offset += chunks[j].length; }
        closed = true;
        return call('write', { path: self._path, data: base64Encode(all) });
      },
      abort: function () { chunks.length = 0; closed = true; return Promise.resolve(); }
    });
  };

  // ---------- 替换 Store 的三处入口 ----------
  function buildStore(Store, path) {
    var store = new Store(new DirHandle(path));
    store.needsPermission = false;
    return store._ensureDirs().then(function () { return store; }, function () { return store; });
  }

  function patchStore(CVStore) {
    if (!CVStore || !CVStore.Store || CVStore.Store.__cvBridged) return CVStore;
    var Store = CVStore.Store;
    Store.supported = function () { return true; };
    Store.pick = function () {
      return call('pick').then(function (res) {
        if (!res || !res.path) throw new Error('已取消选择数据文件夹');
        return buildStore(Store, res.path);
      });
    };
    Store.restore = function () {
      return call('last').then(function (res) {
        if (!res || !res.path) return null;
        return buildStore(Store, res.path);
      });
    };
    Store.__cvBridged = true;
    return CVStore;
  }

  // ---------- 桌面版专用的另存为 / 打开文件 ----------
  window.CVDesktop = {
    available: true,
    saveAs: function (name, bytes) {
      return call('saveas', { name: name, data: base64Encode(toBytes(bytes)) });
    },
    openFile: function (kind) {
      return call('openread', { kind: kind || 'excel' }).then(function (res) {
        if (!res || !res.path) return null;
        return { path: res.path, name: res.name, bytes: base64Decode(res.data || '') };
      });
    },
    openFolder: function (path) { return call('open', { path: path }); }
  };

  var current = null;
  try {
    Object.defineProperty(window, 'CVStore', {
      configurable: true,
      get: function () { return current; },
      set: function (value) { current = patchStore(value); }
    });
  } catch (e) {
    // 极少数情况下无法劫持：退化为轮询
    var timer = setInterval(function () {
      if (window.CVStore) { clearInterval(timer); patchStore(window.CVStore); }
    }, 10);
  }

  // 桌面版文案：托盘能力由宿主提供，去掉"浏览器版"的提示
  document.addEventListener('DOMContentLoaded', function () {
    try {
      var chip = document.getElementById('trayChip');
      if (chip) {
        chip.innerHTML = '<span class="dot"></span>桌面版运行中';
        chip.title = '关闭窗口后仍在托盘运行，到期提醒照常工作（托盘图标右键可退出）';
      }
    } catch (e) { }
  });
})();
