/* Zcode-Status-Daily-Use 主进程 loader。
 * 由 install.py 在 app.asar 入口（package.json 的 main）末尾追加一行 import 引入。
 *
 * 职责：
 *   1. 向每个主窗口注入 overlay.js（mtime 变化热更新，免重启）；
 *   2. 取数：常驻 python（zdu_multi.py serve，stdin/stdout 行协议）省解释器启动费，
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
 *   - 远程源的用量写在远端机器的库里，本机 db 的 mtime 不会因它变化，
 *     所以 fs.watch 只能覆盖本地源的变化；远程源靠心跳兜底周期拉取。
 *     配了远程源时，心跳间隔取较小者，避免远程用量延迟太久才显示。
 */
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { app, BrowserWindow, webContents } = require("electron");

const HERE = __dirname;
const CONFIG = path.join(HERE, "config.json");
const OVERLAY = path.join(HERE, "overlay.js");
const ZDU = path.join(HERE, "zdu_multi.py");
const MARK = "zdaily";
const LOG = (...a) => console.error("[" + MARK + "]", ...a);

/* ---------------------------------------------------------------- 配置 */

function readCfg() {
  const c = { python_path: "python", resident: true, hot_reload: true,
              activity_min_ms: 8000, heartbeat_ms: 6000, idle_push_ms: 4000,
              local_label: "本机", remote_sources: [] };
  try { Object.assign(c, JSON.parse(fs.readFileSync(CONFIG, "utf8"))); } catch (e) { }
  return c;
}

/* 配了远程源时，本机 db 的 mtime 不再是可靠的触发条件 ——
 * 远程用量变化时本机什么都不会动，只能靠心跳。 */
function hasRemote(cfg) {
  if (cfg.discover_remote !== false) {
    try {
      if ((rem().discoverProfiles() || []).length) return true;
    } catch (e) { /* 读不到档案就当没有 */ }
  }
  return Array.isArray(cfg.remote_sources) && cfg.remote_sources.some(
    (s) => s && s.enabled !== false
  );
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
function legacySpawn(req) {
  const py = spawn(readCfg().python_path, [ZDU, "json"], { windowsHide: true });
  let out = "";
  const killTimer = setTimeout(() => {
    LOG("query timeout, killing");
    try { py.kill(); } catch (e) { }
  }, 30000);
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

/* 构造发给 Python 的请求行。
 * 窗口与远程快照一起给 —— Python 按同一窗口查本地，远程快照也是按同一窗口取的，
 * 合并才不会错位。 */
function buildRequest(remote) {
  const w = currentWindow();
  const req = { window: w };
  if (remote && remote.length) req.remote = remote;
  return JSON.stringify(req);
}

async function runQuery() {
  /* busy 在这里设/清 —— runQuery 现在是异步的（要先取远程），
   * 在调用方设 busy 会在 await 期间提前解锁，导致并发取数。 */
  if (busy) return;
  busy = true;
  const done = (payload) => {
    busy = false;
    if (payload) handlePayload(payload);
  };

  /* 先取远程（可能要跨网络，慢）。失败不阻塞 —— 远程快照里带 error，
   * Python 那边照样合并，只是那个源显示不可用。 */
  let remote = [];
  try {
    remote = await collectRemote(currentWindow());
  } catch (e) {
    LOG("远程取数异常:", e.message);
    remote = [];
  }

  const req = buildRequest(remote);

  if (readCfgCached().resident !== false && pyFail < 3) {
    if (!pyRes) startResident();
    if (pyRes && pyRes.proc.stdin.writable) {
      const state = pyRes;
      /* 超时要按远程源数量算：配了远程源时一次请求可能要跨网络到远端机上，
       * 本地那 15s 不够，会把好端端的常驻进程反复打死（3 次早退就回退一次性
       * spawn，更慢）。 */
      const remoteCount = remoteSources().length;
      const timeout = 15000 + remoteCount * 25000;
      const timer = setTimeout(() => {
        LOG("resident query timeout, restarting");
        pyRestarting = true;
        try { state.proc.kill(); } catch (e) { }
        done(null);
      }, timeout);
      state.waiters.push((payload) => { clearTimeout(timer); done(payload); });
      /* 请求行不能是空行 —— serve 那边把空行当作"没有请求"跳过
       * （那是 zdu.py 起的协议，保留它是为了兼容）。
       * 这里统一用 JSON 请求行（带窗口与远程快照）。 */
      try { state.proc.stdin.write(req + "\n"); } catch (e) { }
      return;
    }
  }
  legacySpawn();
}

/* ---------------------------------------------------------------- 远程通道 */

let remoteMod = null;
function rem() {
  if (!remoteMod) {
    try {
      remoteMod = require(path.join(HERE, "zdu_remote_main.cjs"));
    } catch (e) {
      LOG("远程通道模块加载失败:", e.message);
      remoteMod = { discoverProfiles: () => [], fetchSnapshot: async () => { throw new Error("远程通道不可用"); } };
    }
  }
  return remoteMod;
}

/* 算出「今天」的绝对时间窗 —— 本地与各远端按同一个窗口查，合并才不会错位。
 * 口径与客户端的 resolveAgentSessionDbPath / 时区分桶一致：
 *   dayIndex = floor((now + tzOffsetMs) / 86400000)
 *   dayStart = dayIndex * 86400000 - tzOffsetMs
 * 时区偏移用 Intl.DateTimeFormat 取目标时区的墙上时间，与客户端 vai() 同构。 */
function currentWindow() {
  const now = Date.now();
  let tz = 0;
  try {
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    /* 取目标时区此刻的年月日时分，算成"当作 UTC 的墙上时间"再减去 now 的 UTC 部分，
     * 差值即该时刻的时区偏移（客户端 vai() 的算法）。 */
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: tzName, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(now)).reduce((a, x) => {
      if (x.type !== "literal") a[x.type] = x.value; return a;
    }, {});
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day,
      +p.hour % 24, +p.minute, +p.second);
    tz = wall - (now - (now % 1000));
    /* 越界说明换算出错，退回 0（UTC）而不是喂给分桶 */
    if (Math.abs(tz) >= 15 * 3600000) tz = 0;
  } catch (e) { tz = 0; }
  const dayIndex = Math.floor((now + tz) / 86400000);
  return {
    startMs: dayIndex * 86400000 - tz,
    endMs: now,
    tzOffsetMs: tz,
  };
}

/* 列出要取数的远程源。
 * 默认：从客户端的连接档案自动发现（SSH / WSL / Docker）——
 * 用户在客户端里配过的远程，插件自动跟上，不用手填、不用写密码。
 * 配置里的 remote_sources 仍然有效，用作「手动补充」（enabled:false 可关掉某个自动发现的源）。 */
function remoteSources() {
  const cfg = readCfgCached();
  const out = [];
  const seen = new Set();

  if (cfg.discover_remote !== false) {
    try {
      for (const p of rem().discoverProfiles()) {
        const key = p.kind + "|" + (p.host || p.distro || p.container) + "|" +
                    (p.port || "") + "|" + (p.user || "");
        if (seen.has(key)) continue;
        seen.add(key);
        p.timeout = cfg.remote_timeout_ms || 25000;
        out.push(p);
      }
    } catch (e) {
      LOG("发现远程档案失败:", e.message);
    }
  }

  /* 手动补充的源。没被自动发现覆盖的才加进来，避免同一台机器取两遍。 */
  for (const s of (cfg.remote_sources || [])) {
    if (!s || s.enabled === false) continue;
    const key = s.kind + "|" + (s.host || s.distro || s.container) + "|" +
                (s.port || "") + "|" + (s.user || "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/* 逐个远程源取快照。单个源失败不影响其它源。 */
async function collectRemote(window) {
  const srcs = remoteSources();
  if (!srcs.length) return [];
  const results = await Promise.all(srcs.map(async (src) => {
    const label = src.label || rem().sourceLabel(src);
    try {
      const snap = await rem().fetchSnapshot(src, window, src.timeout || 25000);
      return { source: label, snapshot: snap };
    } catch (e) {
      return { source: label, error: String((e && e.message) || e).slice(0, 300) };
    }
  }));
  return results;
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
   * 卡片就停在"等待数据…"，直到下一次心跳才出现内容。
   *
   * 配了远程源时另有一层考虑：远程用量写在远端机上，本机 db 的 mtime
   * 不会因远程的变化而动，fs.watch 永远不触发。所以远程源的刷新完全依赖
   * 这个限频窗口 —— 不能因为"本机没写入"就把间隔拉长，否则远程那段
   * 数字会长时间不更新。这里在配了远程源时用 activity_min_ms 作为下限，
   * 不因本机空闲而放宽到 idle_push_ms。 */
  const now = Date.now();
  const st = dbStamp();
  const fresh = st && st !== lastStamp;
  const remote = hasRemote(cfg);
  let wait = fresh
    ? Math.max(2000, cfg.activity_min_ms | 0 || 8000)
    : Math.max(1500, cfg.idle_push_ms | 0 || 4000);
  if (remote && !fresh) {
    wait = Math.max(wait, Math.max(2000, cfg.activity_min_ms | 0 || 8000));
  }

  if (now - lastSpawn < wait) {
    /* 限频未到：安排补拉，保证窗口内最后一笔写入一定被取到。 */
    scheduleRetry(wait - (now - lastSpawn) + 50);
    return;
  }
  lastSpawn = now;
  if (st) lastStamp = st;
  /* runQuery 是异步的（要先取远程）。busy 由它自己管，
   * 这里不 await —— 避免把 maybeSpawn 的调用栈堵住。 */
  Promise.resolve(runQuery()).catch((e) => {
    LOG("取数失败:", e && e.message);
    busy = false;
  });
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

const ZDU_REMOTE = path.join(HERE, "zdu.py");   // 部署到远端执行的那份
const ZDU_AGG = path.join(HERE, "zdu_aggregate.py");
const ZDU_REMOTE_LIB = path.join(HERE, "zdu_remote.py");

let overlayMtimeKnown = false;
let zduMtime = 0;
let zduAuxMtime = 0;
setInterval(() => {
  const cfg = readCfgCached();
  if (cfg.hot_reload === false) return;
  hotReloadIfChanged();
  try {
    const m = fs.statSync(ZDU).mtimeMs;
    if (overlayMtimeKnown && m !== zduMtime && pyRes) {
      LOG("zdu_multi.py changed, restarting resident python");
      killResidentForUpgrade();
    }
    zduMtime = m;
    overlayMtimeKnown = true;
  } catch (e) { }
  /* 远端脚本与合并逻辑的改动也要能生效。
   * zdu.py 是部署到远端执行的那份 —— 它变了要重启常驻进程（下次取数会
   * 重新部署到远端）；zdu_aggregate.py / zdu_remote.py 只影响本地编排，
   * 同样需要重启才加载新代码。 */
  try {
    let aux = 0;
    for (const f of [ZDU_REMOTE, ZDU_AGG, ZDU_REMOTE_LIB]) {
      try { aux = Math.max(aux, fs.statSync(f).mtimeMs); } catch (e) { }
    }
    if (overlayMtimeKnown && aux !== zduAuxMtime && pyRes) {
      LOG("remote/aggregate module changed, restarting resident python");
      killResidentForUpgrade();
    }
    zduAuxMtime = aux;
  } catch (e) { }
}, 2000);

/* 心跳兜底：fs.watch 事件不保证送达（Node 官方文档），无写入时也要能刷新"今天"
 * 的跨零点与时长。
 *
 * 配了远程源时，心跳是刷新远程用量的唯一途径（远端写入不改变本机 db 的
 * mtime），所以间隔取配置值与 6s 中的较小者 —— 配了远程源就按 6s 心跳，
 * 否则沿用用户设的 heartbeat_ms（默认 60s）。 */
let currentHeartbeat = 0;
let heartbeatTimer = null;
function heartbeatMs() {
  const cfg = readCfgCached();
  const configured = Math.max(4000, cfg.heartbeat_ms | 0 || 6000);
  return hasRemote(cfg) ? Math.min(configured, 6000) : configured;
}
currentHeartbeat = heartbeatMs();
heartbeatTimer = setInterval(maybeSpawn, currentHeartbeat);
/* 配置改了（新增远程源）要重新设定心跳间隔 —— setInterval 的间隔不能改，
 * 所以拆掉重建。 */
setInterval(() => {
  const want = heartbeatMs();
  if (want !== currentHeartbeat) {
    currentHeartbeat = want;
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(maybeSpawn, want);
    LOG("heartbeat interval ->", want, "ms");
  }
}, 5000);

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
