// CertVault v1 · 多地址探测与地址簿（契约 §9）
// 职责：并行探测 /api/config/public（1200ms 超时）→ 局域网优先 → 结果缓存 5 分钟 →
//       网络级失败标记不可用并立刻重探一次；地址簿持久化（网页 localStorage / 桌面 host.json）。
// 依赖：app/store-http.js 可选（复用 normalizeBase / configPublic / isPrivateHost）；
//       桌面壳若要接管 host.json，可在加载后调用 CVServerEndpoints.setHostAdapter({read,write})。
// 暴露：window.CVServerEndpoints。与 app.js 保持一致，本文件不使用模板字符串。
(function () {
  'use strict';

  const httpApi = window.CVStoreHttp || null;
  const BOOK_KEY = 'cv.endpoints';
  const PROBE_TIMEOUT_MS = 1200;
  const CACHE_TTL_MS = 5 * 60 * 1000;

  // 探测结果缓存（内存）：{at, base, ms, config, results}
  let cache = null;
  let lastCandidates = [];
  let lastPickedBase = '';
  let activeBase = '';
  let unavailable = Object.create(null); // base -> 标记时间（网络级失败）
  let reprobePromise = null;
  let lastReprobeAt = 0; // 自动重探节流：契约只要求「重探一次」，避免两个坏地址来回切换
  let bookHydrated = false;
  let hostAdapter = null;
  let onChange = null;
  let onOffline = null;
  let onReprobe = null;

  // ---------- localStorage（file:// / 隐私模式可能抛错） ----------
  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (err) { return null; }
  }

  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (err) { return false; }
  }

  function isHttpUrl(value) {
    const text = String(value == null ? '' : value).toLowerCase();
    return text.indexOf('http://') === 0 || text.indexOf('https://') === 0;
  }

  // ---------- 地址归一化 / 私网判断 ----------
  function normalizeBase(value) {
    if (httpApi && typeof httpApi.normalizeBase === 'function') {
      return httpApi.normalizeBase(value);
    }
    let text = String(value == null ? '' : value).trim();
    if (!text) return '';
    if (!isHttpUrl(text)) text = 'http://' + text;
    return text.replace(/\/+$/, '');
  }

  function hostOf(base) {
    const text = normalizeBase(base);
    if (!text) return '';
    try { return String(new URL(text).hostname || '').toLowerCase(); } catch (err) { return ''; }
  }

  // 契约 §9：10/8、172.16/12、192.168/16、127/8、localhost、*.local
  function isPrivateHost(base) {
    if (httpApi && typeof httpApi.isPrivateHost === 'function') {
      return !!httpApi.isPrivateHost(base);
    }
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
    return /\.local$/.test(host);
  }

  function hostKind(base) {
    return isPrivateHost(base) ? 'lan' : 'domain';
  }

  function makeError(message, code) {
    const err = new Error(message);
    err.code = code || 'endpoint';
    return err;
  }

  // ---------- 地址簿 ----------
  function normalizeBook(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach(function (item) {
      const base = normalizeBase(item);
      if (base && out.indexOf(base) < 0) out.push(base);
    });
    return out;
  }

  function readBook() {
    try {
      const raw = lsGet(BOOK_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return normalizeBook(parsed);
      if (parsed && Array.isArray(parsed.list)) return normalizeBook(parsed.list);
      if (parsed && Array.isArray(parsed.endpoints)) return normalizeBook(parsed.endpoints);
      return [];
    } catch (err) {
      return [];
    }
  }

  function extractHostBook(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return normalizeBook(payload);
    if (Array.isArray(payload.endpoints)) return normalizeBook(payload.endpoints);
    if (Array.isArray(payload.list)) return normalizeBook(payload.list);
    if (payload.host && Array.isArray(payload.host.endpoints)) return normalizeBook(payload.host.endpoints);
    return [];
  }

  // 桌面端：host.json.endpoints 优先。没有桌面桥时返回空数组，完全走 localStorage。
  function readHostBook() {
    if (hostAdapter && typeof hostAdapter.read === 'function') {
      return Promise.resolve().then(function () { return hostAdapter.read(); }).then(extractHostBook, function () { return []; });
    }
    const desk = window.CVDesktop;
    if (!desk) return Promise.resolve([]);
    if (typeof desk.hostGet === 'function') {
      return Promise.resolve().then(function () { return desk.hostGet('endpoints'); }).then(extractHostBook, function () { return []; });
    }
    if (typeof desk.readHost === 'function') {
      return Promise.resolve().then(function () { return desk.readHost(); }).then(extractHostBook, function () { return []; });
    }
    return Promise.resolve([]);
  }

  function persistHost(list) {
    try {
      if (hostAdapter && typeof hostAdapter.write === 'function') {
        return Promise.resolve(hostAdapter.write(list)).catch(function () { return false; });
      }
      const desk = window.CVDesktop;
      if (!desk) return Promise.resolve(false);
      if (typeof desk.hostSet === 'function') {
        return Promise.resolve(desk.hostSet('endpoints', list)).catch(function () { return false; });
      }
      if (typeof desk.writeHost === 'function') {
        return Promise.resolve(desk.writeHost({ endpoints: list })).catch(function () { return false; });
      }
      return Promise.resolve(false);
    } catch (err) {
      return Promise.resolve(false);
    }
  }

  function writeBook(list) {
    const out = normalizeBook(list);
    lsSet(BOOK_KEY, JSON.stringify(out));
    cache = null; // 地址簿变了，下一次 pick 必须重新探测
    persistHost(out); // 桌面端尽力同步；失败不影响网页版
    return out;
  }

  function endpoints() {
    return readBook();
  }

  function addEndpoint(base) {
    const clean = normalizeBase(base);
    if (!clean) return readBook();
    const list = readBook();
    if (list.indexOf(clean) < 0) list.push(clean);
    return writeBook(list);
  }

  function removeEndpoint(base) {
    const clean = normalizeBase(base);
    return writeBook(readBook().filter(function (item) { return item !== clean; }));
  }

  function updateEndpoint(oldBase, newBase) {
    const oldClean = normalizeBase(oldBase);
    const newClean = normalizeBase(newBase);
    if (!newClean) return readBook();
    const list = readBook().map(function (item) { return item === oldClean ? newClean : item; });
    return writeBook(list);
  }

  // 桌面端启动时把 host.json.endpoints 合并进 localStorage（同一套代码；顺序=优先级）。
  // force=true 供测试/桌面壳重新读取 host.json。
  function hydrate(force) {
    if (bookHydrated && !force) return Promise.resolve(readBook());
    return readHostBook().then(function (hostList) {
      bookHydrated = true;
      if (!hostList.length) return readBook();
      const local = readBook();
      const merged = normalizeBook(hostList.concat(local));
      if (merged.length !== local.length || merged.some(function (item, index) { return item !== local[index]; })) {
        lsSet(BOOK_KEY, JSON.stringify(merged));
        cache = null;
      }
      return merged;
    });
  }

  // ---------- 探测 ----------
  function shortReason(err) {
    if (!err) return '连接失败';
    if (err.code === 'timeout' || err.aborted) return '超时（1.2 秒）';
    if (err.code === 'network' || err.network) return '连接失败';
    return err.message ? String(err.message) : '连接失败';
  }

  function fallbackProbe(base, timeoutMs) {
    const url = base + '/api/config/public';
    const started = Date.now();
    if (typeof window.fetch !== 'function') {
      return Promise.reject(makeError('当前环境不支持网络请求', 'unsupported'));
    }
    let timer = 0;
    let ctrl = null;
    let signal;
    if (typeof window.AbortController === 'function') {
      ctrl = new window.AbortController();
      signal = ctrl.signal;
    }
    const timeout = new Promise(function (resolve, reject) {
      timer = window.setTimeout(function () {
        const err = makeError('连接超时（1.2 秒）', 'timeout');
        err.aborted = true;
        if (ctrl) { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }
        reject(err);
      }, timeoutMs);
    });
    const task = window.fetch(url, { method: 'GET', cache: 'no-store', signal: signal }).then(function (resp) {
      if (!resp.ok) throw makeError('HTTP ' + resp.status, 'http_' + resp.status);
      return resp.text().then(function (text) {
        let data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
        return { base: base, ms: Date.now() - started, config: data };
      });
    });
    return Promise.race([task, timeout]).then(function (res) {
      window.clearTimeout(timer);
      return res;
    }, function (err) {
      window.clearTimeout(timer);
      throw err;
    });
  }

  function probeOne(base, timeoutMs) {
    const clean = normalizeBase(base);
    const started = Date.now();
    const timeout = timeoutMs || PROBE_TIMEOUT_MS;
    const task = (httpApi && typeof httpApi.probeBase === 'function')
      ? httpApi.probeBase(clean, timeout)
      : fallbackProbe(clean, timeout);
    return Promise.resolve(task).then(function (res) {
      const config = res && res.config ? res.config : null;
      const ms = res && typeof res.ms === 'number' ? res.ms : (Date.now() - started);
      delete unavailable[clean];
      return { base: clean, ok: true, ms: ms, config: config, reason: '' };
    }, function (err) {
      const errInfo = err || {};
      return {
        base: clean,
        ok: false,
        ms: 0,
        config: null,
        reason: shortReason(errInfo)
      };
    });
  }

  function probeAll(list, options) {
    const candidates = normalizeBook(list);
    const opt = options || {};
    const timeout = opt.timeoutMs || PROBE_TIMEOUT_MS;
    if (!candidates.length) return Promise.resolve([]);
    return Promise.all(candidates.map(function (base) {
      return probeOne(base, timeout);
    }));
  }

  function resultOf(best, results, cached) {
    return {
      base: best.base,
      ms: best.ms,
      config: best.config || null,
      results: results,
      cached: !!cached
    };
  }

  function pick(list, options) {
    const candidates = normalizeBook(list);
    const opt = options || {};
    lastCandidates = candidates;
    if (!candidates.length) {
      return Promise.reject(makeError('没有可用的服务器地址：请先在登录框或设置里填写 NAS 地址', 'no_endpoint'));
    }
    // 5 分钟缓存：地址仍在地址簿且期间没有网络级失败时直接复用
    if (!opt.force && cache && (Date.now() - cache.at) < CACHE_TTL_MS &&
        candidates.indexOf(cache.base) >= 0 &&
        !(unavailable[cache.base] && unavailable[cache.base] > cache.at)) {
      lastPickedBase = cache.base;
      return Promise.resolve(resultOf(cache, cache.results, true));
    }
    return probeAll(candidates, { timeoutMs: opt.timeoutMs || PROBE_TIMEOUT_MS }).then(function (results) {
      const reachable = results.filter(function (item) { return item.ok; });
      if (!reachable.length) {
        cache = null;
        const detail = results.map(function (item) { return item.base + '（' + (item.reason || '连接失败') + '）'; }).join('；');
        const err = makeError('连不上服务器：' + detail, 'offline');
        err.results = results;
        err.candidates = candidates;
        throw err;
      }
      reachable.sort(function (a, b) {
        const pa = isPrivateHost(a.base) ? 0 : 1;
        const pb = isPrivateHost(b.base) ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return a.ms - b.ms;
      });
      const best = reachable[0];
      cache = { at: Date.now(), base: best.base, ms: best.ms, config: best.config || null, results: results };
      lastPickedBase = best.base;
      return resultOf(best, results, false);
    });
  }

  // ---------- 网络级失败：标记不可用 + 重探一次 ----------
  function baseFromUrl(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return '';
    try {
      const url = new URL(text);
      if (url.protocol === 'http:' || url.protocol === 'https:') return normalizeBase(url.origin);
    } catch (err) { /* 可能是裸地址 */ }
    return normalizeBase(text);
  }

  function noteNetworkFailure(urlOrBase) {
    const base = baseFromUrl(urlOrBase);
    if (!base) return null;
    unavailable[base] = Date.now();
    if (cache && cache.base === base) cache = null;
    // 只有「正在使用的地址」掉线才触发一次自动重探，避免测试其它地址时反复探测
    if (!activeBase || base !== activeBase || reprobePromise) return null;
    const candidates = [];
    lastCandidates.concat(endpoints()).forEach(function (item) {
      if (item && candidates.indexOf(item) < 0) candidates.push(item);
    });
    if (candidates.indexOf(base) < 0) candidates.push(base);
    if (!candidates.length) return null;
    if (Date.now() - lastReprobeAt < 60 * 1000) return null;
    lastReprobeAt = Date.now();
    if (typeof onReprobe === 'function') {
      try { onReprobe(base); } catch (err) { /* 回调异常不影响探测 */ }
    }
    const previous = activeBase;
    reprobePromise = pick(candidates, { force: true }).then(function (picked) {
      reprobePromise = null;
      activeBase = picked.base;
      if (picked.base !== previous && typeof onChange === 'function') {
        try { onChange(picked); } catch (err) { /* 同上 */ }
      }
      return picked;
    }, function (err) {
      reprobePromise = null;
      if (typeof onOffline === 'function') {
        try { onOffline(err); } catch (e) { /* 同上 */ }
      }
      return null;
    });
    return reprobePromise;
  }

  // 手动登录或切换地址后告诉探测器“当前在用哪一个”，网络失败时才知道该重探
  function setActive(base) {
    const clean = normalizeBase(base);
    if (!clean) return '';
    activeBase = clean;
    lastPickedBase = clean;
    return activeBase;
  }

  function invalidate() {
    cache = null;
    unavailable = Object.create(null);
  }

  function status() {
    return {
      cache: cache ? { at: cache.at, base: cache.base, ms: cache.ms } : null,
      lastPickedBase: lastPickedBase,
      activeBase: activeBase,
      lastCandidates: lastCandidates.slice(),
      unavailable: Object.keys(unavailable),
      reprobing: !!reprobePromise
    };
  }

  // ---------- 导出 ----------
  window.CVServerEndpoints = {
    version: '1.0.0',
    PROBE_TIMEOUT_MS: PROBE_TIMEOUT_MS,
    CACHE_TTL_MS: CACHE_TTL_MS,
    normalizeBase: normalizeBase,
    isPrivateHost: isPrivateHost,
    hostKind: hostKind,
    endpoints: endpoints,
    readEndpoints: endpoints,
    saveEndpoints: writeBook,
    addEndpoint: addEndpoint,
    removeEndpoint: removeEndpoint,
    updateEndpoint: updateEndpoint,
    hydrate: hydrate,
    probeOne: probeOne,
    probeAll: probeAll,
    pick: pick,
    noteNetworkFailure: noteNetworkFailure,
    setActive: setActive,
    invalidate: invalidate,
    status: status,
    setHostAdapter: function (adapter) {
      hostAdapter = adapter && typeof adapter === 'object' ? adapter : null;
      if (hostAdapter) bookHydrated = false;
    },
    setEndpointChangeHandler: function (fn) { onChange = typeof fn === 'function' ? fn : null; },
    setOfflineHandler: function (fn) { onOffline = typeof fn === 'function' ? fn : null; },
    setReprobeHandler: function (fn) { onReprobe = typeof fn === 'function' ? fn : null; }
  };
})();