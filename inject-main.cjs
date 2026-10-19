/* Zcode-Status-Daily-Use 主进程 loader。
 * 由 install.py 在 app.asar 入口（package.json 的 main）末尾追加一行 import 引入。
 *
 * 职责：
 *   1. 向每个主窗口注入 overlay.js（mtime 变化热更新，免重启）；
 *   2. 取数：常驻 python（zdu.py serve，stdin/stdout 行协议）省解释器启动费，
 *      意外退出自动重启，30s 内连续 3 次判不稳定则回退一次性 spawn；
 *   3. 推送时机：fs.watch 监听 db 目录（去抖 300ms）+ 心跳兜底；
 *      完全空闲时零进程零轮询。限频 config.activity_min_ms（默认 8s）。
 *
 * 与 Status-TypeBar 完全独立：不同的注入标记、不触碰对方的注入行与 DOM。
 * 任何失败只打日志，不影响客户端。
 *
 * 设计约束：
 *   - 只向窗口推数据，不读页面状态 —— 没有窗口（应用退出中）就直接短路，
 *     这是"空闲零进程"的前提。
 *   - 注入代码经 new Function 语法校验后才重注入，避免把写到一半的文件载入页面。
 */
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { app, BrowserWindow, webContents } = require("electron");

const HERE = __dirname;
const CONFIG = path.join(HERE, "config.json");
const OVERLAY = path.join(HERE, "overlay.js");
const ZDU = path.join(HERE, "zdu.py");
const MARK = "zdaily";
const LOG = (...a) => console.error("[" + MARK + "]", ...a);

/* ---------------------------------------------------------------- 配置 */

function readCfg() {
  const c = { python_path: "python", resident: true, hot_reload: true,
              activity_min_ms: 8000, heartbeat_ms: 6000, idle_push_ms: 4000 };
  try { Object.assign(c, JSON.parse(fs.readFileSync(CONFIG, "utf8"))); } catch (e) { }
  return c;
}

let cfgMtime = 0;
let cfgCache = null;
function readCfgCached() {
  let m = 0;
  try { m = fs.statSync(CONFIG).mtimeMs; } catch (e) { }
  if (!cfgCache || m !== cfgMtime) {
    cfgMtime = m;
    cfgCache = readCfg();
  }
  return cfgCache;
}

/* ---------------------------------------------------------------- overlay 热更新 */

let overlaySrc = "";
let overlayMtime = 0;
try {
  overlaySrc = fs.readFileSync(OVERLAY, "utf8");
  overlayMtime = fs.statSync(OVERLAY).mtimeMs;
} catch (e) { LOG("overlay.js missing:", e.message); }

function isMainWindowState(wc) {
  try { return wc.getType() === "window"; } catch (e) { return false; }
}

function injectOverlay(wc) {
  if (!overlaySrc || !isMainWindowState(wc) || wc.isDestroyed()) return;
  wc.executeJavaScript(overlaySrc, true).catch(() => { });
}

function hotReloadIfChanged() {
  let m = 0, src = "";
  try {
    m = fs.statSync(OVERLAY).mtimeMs;
    src = fs.readFileSync(OVERLAY, "utf8");
  } catch (e) { return; }
  if (m === overlayMtime) return;
  try { new Function(src); } catch (e) {
    LOG("overlay.js syntax not ready, skip:", e.message); return;
  }
  overlayMtime = m;
  overlaySrc = src;
  LOG("overlay.js changed, hot-reloading");
  for (const wc of webContents.getAllWebContents()) {
    if (!isMainWindowState(wc) || wc.isDestroyed()) continue;
    /* 旧实例（interval/rAF 闭包无法外部清除）靠代际守卫自罢工，
     * 这里只需清掉旧 DOM，resetGen 让新代码能重新挂载。 */
    wc.executeJavaScript(
      '(function(){try{document.querySelectorAll(".zdu-root").forEach(function(e){e.remove()})}catch(_){}window.__zduGen=0;window.__zduOverlay=false;})()',
      true
    ).catch(() => { });
    injectOverlay(wc);
  }
  /* 重注入后 overlay 的内存状态（state.data）被清空了，而下面 maybeSpawn 的
   * "无新写入就不推"会把这次推送跳掉 —— 表现为卡片在、但一直显示"等待数据…"。
   * 故热更新后强制重置时间戳，让下一次 pump 必定重新取数。 */
  lastStamp = 0;
  lastSpawn = 0;
  scheduleRetry(400);
}

/* ---------------------------------------------------------------- 推送 */

function pushOnce(wc, payload) {
  if (!isMainWindowState(wc) || wc.isDestroyed() || !payload || typeof payload !== "object") return;
  /* U+2028/2029 转义：JSON.stringify 会输出裸的这两个字符，它们是 JS 的
   * 行分隔符/段分隔符，直接塞进 executeJavaScript 的源码会让整段代码语法错误，
   * 而 executeJavaScript 的失败被 catch 静默吞掉 —— 表现就是"页面永远没数据"。
   *
   * 踩过的坑：正则写成 /[\\u2028\\u2029]/ 匹配的是"反斜杠+u2028"这个字面序列，
   * 而 JSON.stringify 输出的是裸字符，两者对不上，转义从未生效。
   * 正确写法是让正则直接匹配裸字符本身。
   *
   * 会话标题、目录名都是用户任意文本，确实可能含这些字符，不能假设不会。 */
  const SEP = new RegExp("[" + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + "]", "g");
  const json = JSON.stringify(payload).replace(SEP, function (c) {
    return c === String.fromCharCode(0x2028) ? "\\u2028" : "\\u2029";
  });
  const js = "window.__zduUpdate && window.__zduUpdate(" + json + ")";
  wc.executeJavaScript(js, true).catch(() => { });
}

function handlePayload(payload) {
  if (!payload || typeof payload !== "object") return;
  for (const wc of webContents.getAllWebContents()) pushOnce(wc, payload);
}

/* ---------------------------------------------------------------- 常驻查询进程 */

let pyRes = null;          // { proc, waiters, born }
let pyFail = 0;
let pyRestarting = false;

function startResident() {
  if (pyRes) return;
  const proc = spawn(readCfg().python_path, [ZDU, "serve"], { windowsHide: true });
  const state = { proc, waiters: [], born: Date.now() };
  pyRes = state;
  LOG("resident python starting");
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const w = state.waiters.shift();
      if (!w) continue;
      let payload = null;
      try { payload = JSON.parse(line); } catch (e) { }
      w(payload);
    }
  });
  proc.stderr.on("data", () => { });
  proc.on("error", (e) => { LOG("spawn error:", e.message); });
  proc.on("close", () => {
    if (pyRes === state) pyRes = null;
    const pending = state.waiters;
    state.waiters = [];
    pending.forEach((w) => w(null));   // 挂起请求收场，泵侧等下次心跳
    if (pyRestarting) { pyRestarting = false; startResident(); return; }
    if (Date.now() - state.born < 30000) {
      pyFail++;
      if (pyFail >= 3) { LOG("resident unstable (3 early exits), fallback to one-shot"); return; }
      setTimeout(startResident, 1000 * pyFail);
    } else {
      pyFail = 0;
      startResident();   // 长跑后退出（升级/误杀）：立即重启
    }
  });
}

function killResidentForUpgrade() {
  if (!pyRes) return;
  pyRestarting = true;
  try { pyRes.proc.kill(); } catch (e) { }
}

/* 回退：一次性 spawn（config.resident=false 或判不稳定时走） */
function legacySpawn() {
  const py = spawn(readCfg().python_path, [ZDU, "json"], { windowsHide: true });
  let out = "";
  const killTimer = setTimeout(() => {
    LOG("query timeout, killing");
    try { py.kill(); } catch (e) { }
  }, 15000);
  py.stdout.on("data", (d) => { out += d; });
  py.on("error", (e) => { clearTimeout(killTimer); busy = false; LOG("spawn failed:", e.message); });
  py.on("close", () => {
    clearTimeout(killTimer);
    busy = false;
    if (out.trim()) {
      let payload = null;
      try { payload = JSON.parse(out); } catch (e) { payload = null; }
      if (payload) handlePayload(payload);
    }
  });
}

function runQuery() {
  busy = true;
  const done = (payload) => {
    busy = false;
    if (payload) handlePayload(payload);
  };
  if (readCfgCached().resident !== false && pyFail < 3) {
    if (!pyRes) startResident();
    if (pyRes && pyRes.proc.stdin.writable) {
      const state = pyRes;
      const timer = setTimeout(() => {
        LOG("resident query timeout, restarting");
        pyRestarting = true;
        try { state.proc.kill(); } catch (e) { }
        done(null);
      }, 15000);
      state.waiters.push((payload) => { clearTimeout(timer); done(payload); });
      try { state.proc.stdin.write("\n"); } catch (e) { }
      return;
    }
  }
  legacySpawn();
}

/* ---------------------------------------------------------------- 触发与限频 */

let busy = false;
let lastSpawn = 0;
let lastStamp = 0;
let retryTimer = 0;

let DB_DIR = null;
function dbDir() {
  if (!DB_DIR) DB_DIR = path.join(app.getPath("home"), ".zcode", "cli", "db");
  return DB_DIR;
}

/* db 活动戳：WAL 模式下写入主要落在 -wal，所以三个文件都看。 */
function dbStamp() {
  let m = 0;
  const dir = dbDir();
  for (const f of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"]) {
    try { m = Math.max(m, fs.statSync(path.join(dir, f)).mtimeMs); } catch (e) { }
  }
  return m;
}

function scheduleRetry(ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(maybeSpawn, ms);
}

function maybeSpawn() {
  if (busy) { scheduleRetry(300); return; }
  /* 没有主窗口就不取数 —— 应用关闭中或辅助窗口场景，也保证空闲零进程。 */
  const wcs = webContents.getAllWebContents().filter(
    (wc) => isMainWindowState(wc) && !wc.isDestroyed()
  );
  if (!wcs.length) return;

  const cfg = readCfgCached();
  /* 限频。db 有写入时用 activity_min_ms（默认 8s），无写入时用 idle_push_ms
   * （默认 4s）—— 后者不是"没必要的重复计算"，而是保证页面随时可能打开：
   * 早先版本在这里直接 return，导致用户打开设置页时若 db 恰好没新写入，
   * 卡片就停在"等待数据…"，直到下一次心跳才出现内容。 */
  const now = Date.now();
  const st = dbStamp();
  const fresh = st && st !== lastStamp;
  const wait = fresh
    ? Math.max(2000, cfg.activity_min_ms | 0 || 8000)
    : Math.max(1500, cfg.idle_push_ms | 0 || 4000);

  if (now - lastSpawn < wait) {
    /* 限频未到：安排补拉，保证窗口内最后一笔写入一定被取到。 */
    scheduleRetry(wait - (now - lastSpawn) + 50);
    return;
  }
  lastSpawn = now;
  if (st) lastStamp = st;
  runQuery();
}

let debounceTimer = 0;
let dbWatcher = null;
function watchDb() {
  if (dbWatcher) return;
  try {
    dbWatcher = fs.watch(dbDir(), (ev, f) => {
      if (f && !/db\.sqlite/.test(f)) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(maybeSpawn, 300);
    });
    dbWatcher.on("error", () => {
      LOG("db watcher error, re-arm in 5s");
      try { dbWatcher.close(); } catch (e) { }
      dbWatcher = null;
      setTimeout(watchDb, 5000);
    });
    LOG("watching", dbDir());
  } catch (e) {
    LOG("fs.watch failed, retry in 5s:", e.message);
    setTimeout(watchDb, 5000);
  }
}

/* ---------------------------------------------------------------- 启动 */

let overlayMtimeKnown = false;
let zduMtime = 0;
setInterval(() => {
  const cfg = readCfgCached();
  if (cfg.hot_reload === false) return;
  hotReloadIfChanged();
  try {
    const m = fs.statSync(ZDU).mtimeMs;
    if (overlayMtimeKnown && m !== zduMtime && pyRes) {
      LOG("zdu.py changed, restarting resident python");
      killResidentForUpgrade();
    }
    zduMtime = m;
    overlayMtimeKnown = true;
  } catch (e) { }
}, 2000);

/* 心跳兜底：fs.watch 事件不保证送达（Node 官方文档），无写入时也要能刷新"今天"
 * 的跨零点与时长。 */
setInterval(maybeSpawn, Math.max(4000, readCfg().heartbeat_ms | 0 || 6000));

const hook = (wc) => {
  if (!isMainWindowState(wc)) return;
  wc.on("did-finish-load", () => injectOverlay(wc));
  if (wc.isLoading()) return;
  injectOverlay(wc);
};
app.on("web-contents-created", (e, wc) => hook(wc));
for (const wc of webContents.getAllWebContents()) hook(wc);

watchDb();
setTimeout(maybeSpawn, 1500);   // 启动后拉一次

LOG("loaded (settings usage page: today range + 24h hourly chart)");
