/* 用最小 DOM 替身跑一遍 overlay.js，验证「来源」分区的渲染。
 *
 * 只测与远程/多源相关的部分：来源分区出现、每个源一行、失败源标红。
 * 沿用 render_test.py 的思路：不看页面截图，只断言 DOM 结构与文案。
 */
"use strict";
const fs = require("fs");
const path = require("path");

/* ---------------- 最小 DOM 替身 ---------------- */
function makeEl(tag) {
  const e = {
    tagName: (tag || "div").toUpperCase(),
    className: "",
    children: [],
    attrs: {},
    style: {},
    _text: "",
    textContent: "",
    parentElement: null,
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); if (c) c.parentElement = this; return c; },
    insertBefore(c, ref) {
      const i = this.children.indexOf(ref);
      if (i < 0) this.children.push(c);
      else this.children.splice(i, 0, c);
      if (c) c.parentElement = this;
      return c;
    },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    remove() { this.removed = true; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    get clientWidth() { return 720; },
    get isConnected() { return true; },
  };
  /* innerHTML = "" 在真实 DOM 里是清空子节点；overlay 的 render() 靠它重置卡片。 */
  Object.defineProperty(e, "innerHTML", {
    get() { return ""; },
    set(v) { if (v === "") this.children = []; },
  });
  e.classList = { add() { }, remove() { } };
  return e;
}

/* 先声明容器（document 的 querySelector 要用它查宿主） */
let spaceY = null;

const document = {
  _els: {},
  createElement(tag) { return makeEl(tag); },
  createElementNS(ns, tag) {
    const e = makeEl(tag);
    e.ns = ns;
    return e;
  },
  querySelector(sel) {
    if (sel === ".zdu-root") {
      /* 动态找：overlay 渲染时会用 querySelector(".zdu-root") 拿宿主，
       * 那时宿主可能刚由 mountHost 建出来，不能只查缓存。 */
      return (spaceY ? spaceY.children.find(c => c.className === "zdu-root") : null) || null;
    }
    if (sel === "[data-settings-panel-frame]") return this._els["settings"] || null;
    if (sel === "[data-settings-content-frame]") return null;
    return null;
  },
  querySelectorAll(sel) {
    if (sel === ".zdu-root") {
      const r = spaceY ? spaceY.children.find(c => c.className === "zdu-root") : null;
      return r ? [r] : [];
    }
    return [];
  },
  getElementById(id) { return this._els["#" + id] || null; },
  get head() { return makeEl("head"); },
  get body() { return makeEl("body"); },
  get documentElement() { const e = makeEl("html"); e.classList = { add() { }, remove() { }, contains() { return false; } }; return e; },
  readyState: "complete",
  addEventListener() { },
};

/* overlay 只在「设置页 + 原生顶栏已渲染」时才挂载。搭一个最小结构：
 *   settingsFrame → space-y-5 容器 → section(顶栏) + 宿主容器
 * 顶栏要满足 overlay 的识别条件：className 含 rounded-xl / bg-surface /
 * sm:items-center，且内部至少 4 个 px-4 py-3 text-center 的统计格。 */
const settings = makeEl("div");
settings.setAttribute("data-settings-panel-frame", "");
spaceY = makeEl("div");
spaceY.className = "space-y-5";

const topBar = makeEl("section");
topBar.className = "flex flex-col overflow-hidden rounded-xl bg-surface sm:flex-row sm:items-center";
for (let i = 0; i < 5; i++) {
  const cell = makeEl("div");
  cell.className = "min-w-0 flex-1 px-4 py-3 text-center";
  topBar.appendChild(cell);
}
/* 顶栏的父容器就是 space-y-5；overlay 会把宿主插在顶栏之后（同一个父容器）。 */
spaceY.appendChild(topBar);
settings.appendChild(spaceY);
document._els["settings"] = settings;
topBar.querySelectorAll = function (sel) {
  if (sel === "section") return [topBar];
  if (sel === "div") return topBar.children;
  return [];
};
spaceY.querySelectorAll = function (sel) {
  if (sel === "section") return [topBar];
  return [];
};
settings.querySelectorAll = function (sel) {
  if (sel === "section") return [topBar];
  return [];
};

/* overlay.js 会读 localStorage / matchMedia / MutationObserver */
global.document = document;
global.window = {
  localStorage: { getItem: () => null, setItem: () => { } },
  matchMedia: () => ({ matches: false, addEventListener: () => { } }),
  addEventListener: () => { },
  setTimeout: () => 0,
  clearTimeout: () => { },
  requestAnimationFrame: () => 0,
};
global.MutationObserver = class { observe() { } disconnect() { } };
global.localStorage = global.window.localStorage;
/* overlay 里有个 setInterval(tick, 2000)，不接管的话 node 不会退出。 */
const realSetInterval = global.setInterval;
global.setInterval = () => 0;

/* ---------------- 载入 overlay.js ---------------- */
const overlaySrc = fs.readFileSync(path.join(__dirname, "..", "overlay.js"), "utf8");
try {
  new Function(overlaySrc)();
} catch (e) {
  console.log("✗ overlay.js 载入失败:", e.message);
  process.exit(1);
}
if (typeof global.window.__zduUpdate !== "function") {
  console.log("✗ 未注册 __zduUpdate");
  process.exit(1);
}

/* ---------------- 造多源 payload ---------------- */
const payload = {
  ok: true,
  error: null,
  generatedAt: Date.now(),
  timeZone: "Asia/Shanghai",
  localLabel: "本机",
  range: { startMs: 0, endMs: 0, date: "2026-10-22", startHour: 0 },
  summary: {
    requests: 480, totalTokens: 103647267, inputTokens: 50000000,
    outputTokens: 10000000, cacheReadTokens: 20000000, cacheFreshTokens: 30000000,
    cacheHitRate: 0.4, totalTurns: 480, totalSessions: 5, activeHours: 8,
    mainRequests: 434, subRequests: 46, mainTokens: 90000000, subTokens: 13647267,
    toolCalls: 300, toolErrors: 3, firstAt: 1, lastAt: 2,
  },
  hourly: Array.from({ length: 24 }, (_, h) => ({
    hour: h, totalTokens: h < 8 ? 1000 * (h + 1) : 0, inputTokens: 1000,
    outputTokens: 0, cacheReadTokens: 0, requests: h < 8 ? 1 : 0,
    models: h < 8 ? [{ modelId: "m1", totalTokens: 1000 * (h + 1) }] : [],
  })),
  models: [
    { modelId: "m1", totalTokens: 100000000, inputTokens: 90000000, outputTokens: 10000000, requestCount: 400, share: 0.96 },
    { modelId: "m2", totalTokens: 3647267, inputTokens: 10000000, outputTokens: 0, requestCount: 80, share: 0.04 },
  ],
  sessions: [
    { sid: "s1", title: "本机会话", directory: "D:/x", requests: 10, totalTokens: 90000000, lastAt: 1, isSub: false },
    { sid: "s2", title: "WSL 会话", directory: "/home/kybll", requests: 5, totalTokens: 2000000, lastAt: 2, isSub: false, source: "WSL:Ubuntu-24.04" },
  ],
  tools: [{ toolName: "Read", callCount: 300, errorCount: 3 }],
  sources: [
    { source: "本机", ok: true, totalTokens: 101547267, requests: 474, totalTurns: 474, cacheHitRate: 0.39, timeZone: "Asia/Shanghai", date: "2026-10-22" },
    { source: "WSL:Ubuntu-24.04", ok: true, totalTokens: 2100000, requests: 6, totalTurns: 6, cacheHitRate: 0.5, timeZone: "Asia/Shanghai", date: "2026-10-22" },
    { source: "SSH:build@ci", ok: false, error: "timeout after 20s", totalTokens: 0, requests: 0, totalTurns: 0 },
  ],
};

/* ---------------- 渲染 ----------------
 * overlay 会自己在顶栏下方建宿主（.zdu-root），所以这里不预置，
 * 渲染完从宿主容器里找出来。
 *
 * 注意 tick() 有 400ms 的节流：首次 tick（startWatch 里调的）挂载宿主时
 * state.data 还是 null，会渲染成「等待数据…」。真实客户端靠 2 秒一次的
 * setInterval 补渲染，这里手动等过节流窗口后再 tick 一次。 */
global.window.__zduUpdate(payload);

/* 等过 tick 的节流窗口，再触发一次 —— 对应真实客户端的下一次心跳 */
const realSetTimeout = global.setTimeout;
const start = Date.now();
while (Date.now() - start < 450) { /* 忙等 450ms */ }
global.window.__zduUpdate(payload);   /* 第二次：此时 tick 不会被节流拦 */

const root = spaceY.children.find(c => c.className === "zdu-root");
if (!root) {
  console.log("✗ overlay 未挂载宿主");
  console.log("  diag:", JSON.stringify(global.window.__zduDiag));
  console.log("  容器子节点:", spaceY.children.map(c => c.className));
  console.log("  settingsFrame 命中:", !!document.querySelector("[data-settings-panel-frame]"));
  console.log("  topBar 识别:", topBar.className);
  process.exit(1);
}
document._els[".zdu-root"] = root;

/* 收集渲染出来的文本。overlay 的 el() 用 textContent 设文本，
 * 所以这里读 textContent（不是 _text）。 */
function walk(e, out) {
  if (e.textContent) out.push(e.textContent);
  (e.children || []).forEach(c => walk(c, out));
  return out;
}
const texts = walk(root, []).join(" | ");

if (process.env.ZDU_DUMP) {
  function dump(e, d) {
    console.log("  ".repeat(d) + `<${e.tagName} class="${e.className}"> ${e.textContent || ""}`);
    (e.children || []).forEach(c => dump(c, d + 1));
  }
  console.log("--- DOM ---");
  dump(root, 0);
  console.log("--- texts ---");
  console.log(texts);
}

let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ✓ " + name); }
  else { console.log("  ✗ " + name + "  " + (detail || "")); failed++; }
}

console.log("=".repeat(56));
check("渲染出「来源」区块", /来源（本地 \+ 远程）/.test(texts), texts.slice(0, 300));
check("列出本机来源", /本机/.test(texts));
check("列出 WSL 来源", /WSL:Ubuntu-24\.04/.test(texts));
check("列出失败的 SSH 来源", /SSH:build@ci/.test(texts));
check("失败源显示不可用", /不可用：/.test(texts));
check("失败源显示原因", /timeout after 20s/.test(texts));

/* 找出 .zdu-src-row 数量 */
let srcRows = 0;
let errRows = 0;
(function find(e) {
  if (e.className && String(e.className).indexOf("zdu-src-row") >= 0) {
    srcRows++;
    const hasErr = (e.children || []).some(c => String(c.className).indexOf("zdu-src-err") >= 0);
    if (hasErr) errRows++;
  }
  (e.children || []).forEach(find);
})(root);

check("来源行数 = 源数（3）", srcRows === 3, `got ${srcRows}`);
check("其中 1 行是失败源", errRows === 1, `got ${errRows}`);

/* ---- 数据变化时要重绘 ----
 * v1.1 修的既有缺陷：tick() 的重绘条件原先是 `!state.data`（只在没数据时
 * 渲染），数据推到了画面也不更新。远程适配下这是硬伤 —— 远端用量变化
 * 不引起本机 db 的 mtime 变化，刷新必须靠重绘。 */
function textsOf() {
  const r = spaceY.children.find(c => c.className === "zdu-root");
  if (!r) return "";
  return walk(r, []).join(" | ");
}

const before = textsOf();
/* 中文紧凑格式：「1 亿」「210 万」「2 亿」—— 数字与单位之间有空格
 * （客户端自己的写法，overlay 复刻了它）。 */
check("初始渲染含合计数字", /1\s*亿/.test(before), before.slice(0, 200));

const payload2 = JSON.parse(JSON.stringify(payload));
payload2.summary.totalTokens = 200000000;
payload2.sources[1].totalTokens = 100000000;
global.window.__zduUpdate(payload2);
const after = textsOf();
check("数据变化后重绘（合计变了）", after !== before, "画面未更新");
check("新合计已上屏", /2\s*亿/.test(after), after.slice(0, 200));
check("来源分区跟着更新",
  /WSL:Ubuntu-24\.04/.test(after) && /1\s*亿\s*·\s*6次/.test(after),
  after.slice(0, 300));

/* 同样的数据再推一次：不该重绘（避免每轮心跳都重建 SVG） */
const same = textsOf();
global.window.__zduUpdate(JSON.parse(JSON.stringify(payload2)));
check("数据未变时不重绘", textsOf() === same, "重复重绘了");

console.log("=".repeat(56));
if (failed) { console.log(`存在失败项 ${failed}`); process.exit(1); }
console.log("✓ 来源分区渲染正确");
