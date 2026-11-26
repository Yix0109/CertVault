#!/usr/bin/env node
// t4 浏览器端到端验收：真实 server.js + Edge headless（CDP），零第三方依赖。
// 覆盖：登录页、管理员登录、台账读取、UI 新增记录并回读服务端、账号管理、操作日志、
//       viewer 只读拦截、注册申请(待审批)、管理员审批、新账号登录。
// 截图写入 docs/验收截图-服务器版/；接口地址可用 CV_BASE 覆盖（默认本脚本自起 8091 实例）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.CV_PORT || 8093);
const BASE = "http://127.0.0.1:" + PORT;
const RUN = Date.now().toString(36).slice(-5);
const ADMIN_USER = process.env.CV_USER || "admin";
const ADMIN_PASS = process.env.CV_PASS || "t4-admin-123";
const VIEWER_USER = "qa_viewer_" + RUN;
const VIEWER_PASS = "viewer-pass-123";
const PENDING_USER = "qa_pending_" + RUN;
const PENDING_PASS = "pending-pass-123";
const UI_USER = "qa_reg_ui_" + RUN;
const UI_PASS = "ui-reg-pass-123";
const DATA = path.join(ROOT, ".tmp", "qa-t4-browser");
const EDGE_PROFILE = path.join(ROOT, ".tmp", "qa-t4-edge");
const SHOTS = path.join(ROOT, "docs", "验收截图-服务器版");
const CDP_PORT = Number(process.env.CV_CDP_PORT || 9335);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failures = 0;

function ok(name, pass, detail) {
  if (pass) { results.push({ name, pass: true }); console.log("  [PASS] " + name); return true; }
  failures += 1;
  results.push({ name, pass: false, detail });
  console.log("  [FAIL] " + name + (detail === undefined ? "" : " -> " + JSON.stringify(detail).slice(0, 700)));
  return false;
}

async function api(method, p, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers);
  if (opts.token) headers.Authorization = "Bearer " + opts.token;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + p, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data };
}

async function waitHttp(url, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (e) { /* retry */ }
    await sleep(200);
  }
  return false;
}

async function waitTargets(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/list");
      if (r.ok) { const list = await r.json(); if (Array.isArray(list) && list.length) return list; }
    } catch (e) { /* retry */ }
    await sleep(250);
  }
  throw new Error("Edge CDP 未就绪（端口 " + CDP_PORT + "）");
}

function startServer() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, "server", "server.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { CV_DATA: DATA, CV_PORT: String(PORT), CV_USER: ADMIN_USER, CV_PASS: ADMIN_PASS }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (b) => process.stderr.write("[server] " + b.toString()));
  return child;
}

function startEdge() {
  fs.rmSync(EDGE_PROFILE, { recursive: true, force: true });
  const args = [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-allow-origins=*", "--remote-debugging-port=" + CDP_PORT,
    "--user-data-dir=" + EDGE_PROFILE, "--window-size=1440,900", "about:blank",
  ];
  return spawn(EDGE, args, { stdio: "ignore" });
}

const HELPERS = `window.__qa = {
  q: function(s){ return document.querySelector(s); },
  qa: function(s){ return Array.from(document.querySelectorAll(s)); },
  vis: function(el){ return !!el && el.hidden === false && getComputedStyle(el).display !== "none"; },
  set: function(sel, val){ var el = document.querySelector(sel); if (!el) return false; el.value = val; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; },
  toast: function(){ var el = document.getElementById("toast"); return el ? String(el.textContent || "") : ""; },
  txt: function(sel){ var el = document.querySelector(sel); return el ? String(el.textContent || "") : ""; }
};
"helpers-ok"`;

async function main() {
  console.log("== t4 浏览器验收（run " + RUN + "，base " + BASE + "）");
  let server = null;
  let edge = null;
  let ws = null;
  let cdp = null;
  const pageErrors = [];
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    // 端口预检：若已有别的实例占用，拒绝在错误对象上验收，避免把他人服务的结果记成自己的。
    const occupied = await waitHttp(BASE + "/api/health", 1200);
    if (occupied) throw new Error("端口 " + PORT + " 已被其他实例占用，请用 CV_PORT=<空闲端口> 重跑");
    server = startServer();
    const healthy = await waitHttp(BASE + "/api/health", 15000);
    ok("server.js 真实启动（" + BASE + "，临时数据目录）", healthy);
    if (!healthy) throw new Error("server 未就绪");

    const login = await api("POST", "/api/login", { body: { user: ADMIN_USER, password: ADMIN_PASS, ttlSeconds: 604800 } });
    const ADMIN_TOKEN = login.data && login.data.token;
    ok("API：管理员登录返回 token", login.status === 200 && !!ADMIN_TOKEN, login);
    if (!ADMIN_TOKEN) throw new Error("管理员登录失败（" + JSON.stringify(login).slice(0, 300) + "），请确认端口上运行的是本脚本新起的实例");

    const before = await api("GET", "/api/records", { token: ADMIN_TOKEN });
    const stamp = new Date().toISOString();
    const seed = (before.data.records || []).concat([
      { id: "r_qa_seed_a", name: "QA 验收种子 A", account: "qa-a", password: "p-a", expiry: "2027-06-30", remindDays: 60, note: "t4 浏览器验收", images: [], createdAt: stamp, updatedAt: stamp },
      { id: "r_qa_seed_b", name: "QA 验收种子 B", account: "qa-b", password: "p-b", expiry: "2028-01-15", remindDays: 30, note: "t4 浏览器验收", images: [], createdAt: stamp, updatedAt: stamp },
    ]);
    const put = await api("PUT", "/api/records", { token: ADMIN_TOKEN, headers: { "If-Match": JSON.stringify(before.data.updatedAt) }, body: { version: 1, updatedAt: before.data.updatedAt, records: seed } });
    ok("API：预置 2 条台账记录", put.status === 200, put.status + " " + JSON.stringify(put.data).slice(0, 200));

    const regViewer = await api("POST", "/api/register", { body: { username: VIEWER_USER, password: VIEWER_PASS, device: "qa-t4" } });
    const regPending = await api("POST", "/api/register", { body: { username: PENDING_USER, password: PENDING_PASS, device: "qa-t4-demo" } });
    const users0 = await api("GET", "/api/admin/users", { token: ADMIN_TOKEN });
    const allUsers = (users0.data && users0.data.users) || [];
    const viewerRec = allUsers.find((u) => u.username === VIEWER_USER);
    const approve = viewerRec
      ? await api("POST", "/api/admin/users/" + encodeURIComponent(viewerRec.id) + "/approve", { token: ADMIN_TOKEN, body: { role: "viewer" } })
      : { status: 0, data: "viewer not found" };
    ok("API：注册 viewer + 待审批账号，并审批 viewer", regViewer.status === 200 && regPending.status === 200 && approve.status === 200, { regViewer: regViewer.status, regPending: regPending.status, approve: approve.status });

    edge = startEdge();
    const targets = await waitTargets(15000);
    const page = targets.find((t) => t.type === "page") || targets[0];
    if (!page) throw new Error("无 page target");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      let m = null;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params && m.params.exceptionDetails;
        pageErrors.push("exception: " + ((d && d.exception && d.exception.description) || (d && d.text) || "unknown"));
      }
      if (m.method === "Log.entryAdded") {
        const e = m.params && m.params.entry;
        if (e && e.level === "error" && !String(e.text || "").includes("favicon") && !String(e.url || "").includes("favicon")) pageErrors.push("log: " + e.text + " " + (e.url || ""));
      }
    };
    cdp = (method, params) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params: params || {} })); });

    const evalJs = async (expression) => {
      const m = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (!m || m.error) throw new Error("CDP 错误: " + JSON.stringify(m && m.error));
      const r = m.result || {};
      if (r.exceptionDetails) throw new Error("页面异常: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
      return r.result ? r.result.value : undefined;
    };
    const waitFor = async (expression, timeoutMs) => {
      const t0 = Date.now();
      while (Date.now() - t0 < (timeoutMs || 12000)) {
        try { if (await evalJs(expression)) return true; } catch (e) { /* retry */ }
        await sleep(180);
      }
      return false;
    };
    const shot = async (name) => {
      const m = await cdp("Page.captureScreenshot", { format: "png" });
      const file = path.join(SHOTS, name + ".png");
      fs.writeFileSync(file, Buffer.from(m.result.data, "base64"));
      console.log("  [SHOT] " + file);
      return file;
    };

    await cdp("Page.enable");
    await cdp("Runtime.enable");
    await cdp("Log.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.navigate", { url: BASE + "/?server=1&base=" + encodeURIComponent(BASE) });
    await waitFor(`!!document.getElementById("loginScreen")`, 15000);
    await evalJs(HELPERS);
    const ready = await waitFor(`__qa.vis(document.getElementById("loginScreen")) && String((document.getElementById("loginServer") || {}).value || "").length > 0`, 15000);
    const s1 = JSON.parse(await evalJs(`JSON.stringify({ loginVisible: __qa.vis(document.getElementById("loginScreen")), server: (document.getElementById("loginServer") || {}).value || "" })`));
    ok("浏览器打开服务器模式：出现登录页且服务器自动填入", ready && s1.loginVisible && String(s1.server).indexOf(BASE) === 0, s1);
    await sleep(300);
    await shot("01-登录页");

    await evalJs(`__qa.set("#loginUser", ${JSON.stringify(ADMIN_USER)}); __qa.set("#loginPass", ${JSON.stringify(ADMIN_PASS)}); document.getElementById("btnLogin").click(); true`);
    const loggedIn = await waitFor(`document.getElementById("loginScreen").hidden === true && __qa.qa("#tbody tr[data-id]").length >= 2`, 20000);
    const s2 = JSON.parse(await evalJs(`JSON.stringify({ rows: __qa.qa("#tbody tr[data-id]").length, mode: __qa.txt("#serverModeChip"), acct: __qa.txt("#accountChip"), sess: __qa.txt("#sessionChip") })`));
    ok("管理员登录成功并渲染服务端台账（>=2 行）", loggedIn && s2.rows >= 2, s2);
    ok("顶栏徽标：局域网 / 账号 / 会话剩余", String(s2.mode).includes("局域网") && String(s2.acct).includes(ADMIN_USER) && String(s2.sess).includes("会话剩余"), s2);
    await sleep(500);
    await shot("02-登录后台账");

    const rowsBefore = await evalJs(`__qa.qa("#tbody tr[data-id]").length`);
    await evalJs(`document.getElementById("btnAdd").click(); true`);
    const modalOpen = await waitFor(`document.getElementById("modal").classList.contains("open")`, 8000);
    const recName = "QA 浏览器新增 " + RUN;
    await evalJs(`__qa.set("#fName", ${JSON.stringify(recName)}); __qa.set("#fAccount", "qa-ui-account"); __qa.set("#fPassword", "qa-ui-pass"); __qa.set("#fExpiry", "2027-12-31"); __qa.set("#fNote", "t4 浏览器端到端验收"); true`);
    await evalJs(`document.getElementById("btnSave").click(); true`);
    const saved = await waitFor(`document.getElementById("modal").classList.contains("open") === false && __qa.qa("#tbody tr[data-id]").length === ${rowsBefore + 1}`, 15000);
    const toastText = await evalJs(`__qa.toast()`);
    await sleep(300);
    await shot("03-新增记录已保存");
    const afterSave = await api("GET", "/api/records", { token: ADMIN_TOKEN });
    const persisted = ((afterSave.data && afterSave.data.records) || []).some((r) => r.name === recName);
    ok("浏览器新增记录：弹窗打开、保存成功、服务端已持久化", modalOpen && saved && persisted, { modalOpen, saved, toastText, persisted });

    await evalJs(`var b = document.getElementById("btnCvaAdmin"); if (b) b.click(); true`);
    const consoleOpen = await waitFor(`__qa.vis(document.getElementById("cvaConsole")) && __qa.qa("#cvaConsoleBody tbody tr").length >= 2`, 15000);
    const usersText = await evalJs(`__qa.txt("#cvaConsoleBody")`);
    await sleep(400);
    await shot("04-账号管理-用户列表");
    ok("账号管理控制台打开且列表包含待审批账号", consoleOpen && usersText.indexOf(PENDING_USER) >= 0, { consoleOpen, hasPending: usersText.indexOf(PENDING_USER) >= 0 });

    await evalJs(`var t = document.querySelector("#cvaTabs button[data-view=logs]"); if (t) t.click(); true`);
    const logsOk = await waitFor(`__qa.qa("#cvaLogsBody tr").length >= 1`, 15000);
    const logsMeta = await evalJs(`__qa.txt("#cvaLogsMeta")`);
    await sleep(300);
    await shot("05-操作日志");
    ok("操作日志页加载出记录", logsOk, { meta: logsMeta });

    await evalJs(`var c = document.getElementById("cvaConsoleClose"); if (c) c.click(); true`);
    await evalJs(`localStorage.removeItem("cv.token"); location.reload(); true`);
    await waitFor(`!!document.getElementById("loginScreen") && document.getElementById("loginScreen").hidden === false`, 15000);
    await evalJs(HELPERS);
    await evalJs(`__qa.set("#loginUser", ${JSON.stringify(VIEWER_USER)}); __qa.set("#loginPass", ${JSON.stringify(VIEWER_PASS)}); document.getElementById("btnLogin").click(); true`);
    const viewerLogged = await waitFor(`document.getElementById("loginScreen").hidden === true && __qa.txt("#accountChip").indexOf(${JSON.stringify(VIEWER_USER)}) >= 0`, 20000);
    const locked = await waitFor(`document.getElementById("btnAdd").classList.contains("cva-locked")`, 8000);
    await evalJs(`document.getElementById("btnAdd").click(); true`);
    await sleep(600);
    const viewerToast = await evalJs(`String(((document.querySelector(".cva-toast") || {}).textContent) || "")`);
    const viewerModal = await evalJs(`document.getElementById("modal").classList.contains("open")`);
    await sleep(200);
    await shot("06-viewer只读拦截");
    ok("viewer 登录后写入口锁定，点击被拦截并提示只读", viewerLogged && locked && viewerModal === false && (viewerToast.includes("只读") || viewerToast.includes("查看")), { viewerLogged, locked, viewerModal, viewerToast });

    await evalJs(`localStorage.removeItem("cv.token"); location.reload(); true`);
    await waitFor(`!!document.getElementById("loginScreen") && document.getElementById("loginScreen").hidden === false`, 15000);
    await evalJs(HELPERS);
    const regEntry = await waitFor(`!!document.getElementById("cvaRegisterEntry")`, 8000);
    await evalJs(`var r = document.getElementById("cvaRegisterEntry"); if (r) r.click(); true`);
    const regFormOpen = await waitFor(`__qa.vis(document.getElementById("cvaRegisterLayer")) && !!document.getElementById("cvaRegUser")`, 8000);
    await sleep(300);
    await shot("07-注册申请页");
    ok("登录页可打开「申请注册」表单", regEntry && regFormOpen, { regEntry, regFormOpen });

    await evalJs(`__qa.set("#cvaRegUser", ${JSON.stringify(UI_USER)}); __qa.set("#cvaRegPass", ${JSON.stringify(UI_PASS)}); __qa.set("#cvaRegPass2", ${JSON.stringify(UI_PASS)}); __qa.set("#cvaRegDevice", "QA-EDGE"); true`);
    await evalJs(`var s = document.getElementById("cvaRegSubmit"); if (s) s.click(); true`);
    const waiting = await waitFor(`__qa.txt("#cvaRegisterLayer").includes("等待") || __qa.txt("#cvaRegisterLayer").includes("审批") || __qa.txt("#cvaRegisterLayer").includes("已提交")`, 15000);
    await sleep(500);
    await shot("08-注册申请-等待审批");
    const regUsers = await api("GET", "/api/admin/users", { token: ADMIN_TOKEN });
    const uiRec = ((regUsers.data && regUsers.data.users) || []).find((u) => u.username === UI_USER);
    ok("浏览器注册申请进入待审批，管理员列表可见", waiting && !!uiRec && uiRec.status === "pending", { waiting, user: uiRec && { id: uiRec.id, status: uiRec.status } });

    if (uiRec) await api("POST", "/api/admin/users/" + encodeURIComponent(uiRec.id) + "/approve", { token: ADMIN_TOKEN, body: { role: "editor" } });
    const approvedVisible = await waitFor(`String(document.body.textContent || "").indexOf("通过") >= 0`, 12000);
    await sleep(300);
    await shot("09-注册申请-审批通过");
    ok("管理员审批后注册页显示通过", approvedVisible, { approvedVisible });

    await evalJs(`localStorage.removeItem("cv.token"); location.reload(); true`);
    await waitFor(`!!document.getElementById("loginScreen") && document.getElementById("loginScreen").hidden === false`, 15000);
    await evalJs(HELPERS);
    await evalJs(`__qa.set("#loginUser", ${JSON.stringify(UI_USER)}); __qa.set("#loginPass", ${JSON.stringify(UI_PASS)}); document.getElementById("btnLogin").click(); true`);
    const uiLogin = await waitFor(`document.getElementById("loginScreen").hidden === true && __qa.txt("#accountChip").indexOf(${JSON.stringify(UI_USER)}) >= 0`, 20000);
    await sleep(300);
    await shot("10-审批通过后新账号登录");
    ok("审批通过的新账号可登录", uiLogin);
    ok("浏览全程无页面 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 8));
  } finally {
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    if (edge) { try { spawn("taskkill", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" }); } catch (e) { /* ignore */ } }
    if (server) { try { server.kill(); } catch (e) { /* ignore */ } }
  }

  const summary = { run: RUN, base: BASE, total: results.length, failures, results, shots: fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS).filter((f) => f.endsWith(".png")).sort() : [] };
  fs.mkdirSync(path.join(ROOT, ".tmp"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, ".tmp", "t4-browser-result.json"), JSON.stringify(summary, null, 2));
  console.log("");
  console.log("== 浏览器验收汇总：断言 " + summary.total + "，败 " + failures + "，截图 " + summary.shots.length + " 张");
  console.log(JSON.stringify(summary.shots));
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => { console.error("FATAL " + ((err && err.stack) || err)); process.exitCode = 1; });