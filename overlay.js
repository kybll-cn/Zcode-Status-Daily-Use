/* Zcode-Status-Daily-Use 渲染进程注入（自包含 IIFE）。
 *
 * 形态：在 ZCode 设置 → 用量 页里，紧跟客户端原生用量区块之后插入一个
 *      「今日用量」卡片。不改动 React 树，只在旁边追加自己的 DOM，
 *      因此不会与原生组件的生命周期打架，原生部分照常渲染。
 *
 * 内容：
 *   - 概览：请求 / 合计 token / 缓存命中率 / 活跃时段
 *   - 主图：24 小时分布（纯 SVG 堆叠柱，不依赖 echarts —— 见下）
 *   - 两栏：按模型 / 按会话
 *   - 底栏：工具调用 Top
 *
 * 为什么不用 echarts：客户端把它打包成 ES module chunk（chart-*.js），
 * 通过 Vite 的 __vite__mapDeps 按需 import，注入层拿不到那个模块图，
 * 强行 import 会 404。24 个柱子的堆叠图用 SVG 更轻、更可控，
 * 且完全跟随客户端主题变量，无额外依赖。
 *
 * 主题：颜色一律引用客户端语义变量 var(--color-*)，<html> 的 .dark 类翻转整套值，
 *       MutationObserver 观察该类同步 .zu-dark（仅阴影程度差异）。
 * 数据：主进程泵推 window.__zduUpdate；空闲无写入时不刷新，符合"零轮询"设计。
 * 热更新：泵 mtime 检测 + new Function 语法校验后重注入；代际守卫防旧实例打架。
 * 排障：异常与挂载信息只写 DevTools 控制台，不落盘、不外发。
 */
(function () {
  if (window.__zduOverlay) return;
  window.__zduOverlay = true;

  /* 代际守卫：热更新后旧实例的 interval/rAF 闭包无法外部清除，
   * 发现代号落后即永久罢工，避免两个实例同时刷新 DOM。 */
  var MY_GEN = (window.__zduGen = (window.__zduGen || 0) + 1);
  function stale() { return MY_GEN !== window.__zduGen; }

  function err(tag, e) {
    try { console.warn("[zdaily] " + tag + ":", (e && e.stack) || e); } catch (_) { }
  }
  function info(tag, obj) {
    try { console.warn("[zdaily] " + tag + ":", obj); } catch (_) { }
  }
  window.__zduDiag = { errors: [], mounted: false };

  try {
    document.querySelectorAll(".zdu-root").forEach(function (el) { el.remove(); });
  } catch (e) { }

  var state = { data: null, lang: "zh", mounted: false };

  function L(zh, en) { return state.lang === "en" ? en : zh; }
  function ls(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }

  try {
    if (ls("zdu3.lang", "") === "en") state.lang = "en";
  } catch (e) { }

  /* ---------------------------------------------------------------- 格式化 */

  /* token 量：口径与客户端原生用量页顶栏完全一致，中文按「亿 / 万」，不再用 K/M/B。
   * 原生顶栏（组件 s7：累计 Token / 峰值 Token 那一栏）调的是
   * usageStatsUiParts 导出的 u() —— 也就是下面这段：
   *   Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1,
   *                               minimumFractionDigits: 0 })
   * 中文 locale 下，客户端还会在数字与「万亿」之间补一个空格，
   * 所以 zh-CN 的 "1.2亿" 最终显示成 "1.2 亿"。
   * 这个空格是有意为之，不是笔误 —— 我们的卡片就贴在原生顶栏正下方，
   * 同一屏里两处数字必须长得一样。（想看原始实现可去 app.asar 搜
   * `(?<=\d)(?=[万亿])`，全客户端只有那一处。）
   *
   * compact 对 <1e3 的数（0 / 36 / 999）输出与 standard 完全相同，
   * 实测与客户端「按量级分支」的结果零差异，所以这里不必再分支。 */
  var NF = {};
  function fmt(n) {
    var v = Number(n) || 0;
    var loc = state.lang === "en" ? "en-US" : "zh-CN";
    var f = NF[loc];
    if (f === undefined) {
      try {
        f = NF[loc] = new Intl.NumberFormat(loc, {
          notation: "compact", maximumFractionDigits: 1, minimumFractionDigits: 0
        });
      } catch (e) { f = NF[loc] = null; }   // 极端环境无 compact 数据：退回整数
    }
    var s = f ? f.format(v) : String(Math.round(v));
    return loc === "zh-CN" ? s.replace(/(?<=\d)(?=[万亿])/u, " ") : s;
  }
  function fmtFull(n) {
    return (Math.round(n || 0)).toLocaleString("en-US");
  }
  function hhmm(ms) {
    if (!ms) return "--:--";
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function dur(ms) {
    ms = ms || 0;
    var h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    if (h) return h + L("小时", "h") + " " + m + L("分", "m");
    if (m) return m + L("分", "m");
    return Math.floor(ms / 1000) + L("秒", "s");
  }
  function dirName(dir) {
    if (!dir) return "";
    var s = dir.replace(/\\/g, "/");
    return s.slice(s.lastIndexOf("/") + 1) || s;
  }

  /* ---------------------------------------------------------------- 主题 */

  /* 客户端在 <html> 上用 .dark 翻转整套 --color-* 语义变量。
   * 我们只用这些变量取色，所以主题跟随是自动的；这里额外同步一个
   * zu-dark 类，供少量需要"程度差异"（阴影/透明度）的样式使用。 */
  function syncTheme() {
    try {
      var dark = document.documentElement.classList.contains("dark");
      document.body.classList.toggle("zu-dark", dark);
    } catch (e) { }
  }
  try {
    var mo = new MutationObserver(syncTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  } catch (e) { }

  /* ---------------------------------------------------------------- 挂载定位 */

  /* 目标：设置 → 用量 页，插在原生「累计 Token / 峰值 / 最长聊天 / 连续天数」
   * 那条顶栏的正下方。
   *
   * 分两级判定：
   *   一级：是不是设置页 —— 靠客户端自己打的 data-* 属性
   *         [data-settings-panel-frame] / [data-settings-content-frame]
   *         聊天界面永远不会有这两个属性。不用文本匹配的原因见下方说明。
   *   二级：顶栏锚点 —— 原生顶栏 section 的 className 是
   *         "flex flex-col overflow-hidden rounded-xl bg-surface sm:flex-row sm:items-center"，
   *         这是用量页独有的组合（从 app.asar 的 s7 组件读出来的）。
   *         用它精确定位，插到它的下一个兄弟位置。
   *
   * 为什么不用文本匹配：早先版本用"页面上有没有『设置』或『用量』这些词"判断，
   * 结果聊天消息里只要提到这几个字（用户讨论本插件、贴日志都在聊天区）
   * 就会命中，区块被挂到主界面、视觉上落在输入框下方的状态条附近。
   * DOM 属性与 class 组合是结构性的，不会被对话内容污染。
   *
   * 顶栏找不到时不猜位置 —— 不挂载。等顶栏出现（数据加载完）再挂。 */

  /* 原生顶栏 section 的 class 特征组合 */
  var TOPBAR_CLS = "sm:items-center";

  function settingsFrame() {
    return document.querySelector("[data-settings-panel-frame]") ||
           document.querySelector("[data-settings-content-frame]");
  }

  /* 原生顶栏：section 里同时满足
   *   - 含 rounded-xl + bg-surface（卡片外观）
   *   - 含 sm:flex-row + sm:items-center（横向排列的统计条）
   *   - 子元素是 5 个 flex-1 的统计格（含 "px-4 py-3 text-center"）
   * 统计格数用来排除其它恰好长得像的卡片。 */
  function findTopBar(scope) {
    var root = scope || settingsFrame();
    if (!root) return null;
    var secs = root.querySelectorAll("section");
    for (var i = 0; i < secs.length; i++) {
      var s = secs[i];
      var cn = s.className || "";
      if (cn.indexOf("rounded-xl") < 0) continue;
      if (cn.indexOf("bg-surface") < 0) continue;
      if (cn.indexOf(TOPBAR_CLS) < 0) continue;
      /* 统计格：px-4 py-3 text-center 是顶栏每格的内边距+居中特征 */
      var cells = s.querySelectorAll("div");
      var hits = 0;
      for (var j = 0; j < cells.length; j++) {
        var c = cells[j].className || "";
        if (c.indexOf("px-4") >= 0 && c.indexOf("py-3") >= 0 && c.indexOf("text-center") >= 0) {
          hits++;
        }
      }
      if (hits >= 4) return s;   // 顶栏是 5 格；4 以上足以确认
    }
    return null;
  }

  function isSettingsUsagePage() {
    /* 必须同时满足"在设置页"且"顶栏已渲染"。
     * 顶栏是异步数据的产物，加载完成后才出现；出现即说明用量页已就绪。 */
    return !!settingsFrame() && !!findTopBar();
  }

  /* 插入点：顶栏的正下方（父容器的下一个兄弟位置）。 */
  function insertionTarget() {
    var bar = findTopBar();
    if (!bar || !bar.parentElement) return null;
    return { parent: bar.parentElement, before: bar.nextSibling };
  }

  function mountHost() {
    if (state.mounted) {
      var cur = document.querySelector(".zdu-root");
      if (cur) return cur;
      state.mounted = false;
    }
    var target = insertionTarget();
    /* 拿不到设置页容器就不挂：宁可不显示，也绝不落到聊天界面/输入框下方。 */
    if (!target || !target.parent) return null;

    var host = document.createElement("div");
    host.className = "zdu-root";
    host.setAttribute("data-zdu", "today-usage");
    if (target.before) target.parent.insertBefore(host, target.before);
    else target.parent.appendChild(host);

    state.mounted = true;
    window.__zduDiag.mounted = true;
    render();
    return host;
  }

  /* ---------------------------------------------------------------- 渲染 */

  /* 模型配色：按 modelId 建立一张全局映射表，同一个模型在任何图里都是同一个颜色。
   *
   * 早先版本三处各自按"当前列表的下标"取色（小时图按小时内排序、图例按首次出现
   * 顺序、按模型按总量降序），于是同一个模型在 24 小时图里是蓝色、在"按模型"里
   * 却是绿色，图例和条形还对不上——肉眼一看就是"颜色搞混了"。
   *
   * 排序规则：与原生趋势图一致，取当日 totalTokens 最大的前 6 个模型；
   * 它们按总量降序固定分配 1..6 号色。排名外的模型共用最后一个色位。 */
  var COLORS = [
    "var(--color-usage-chart-1, #3b82f6)",
    "var(--color-usage-chart-2, #10b981)",
    "var(--color-usage-chart-3, #f59e0b)",
    "var(--color-usage-chart-4, #ef4444)",
    "var(--color-usage-chart-5, #a855f7)",
    "var(--color-usage-chart-6, #06b6d4)"
  ];

  var modelColorMap = {};     // modelId -> css color
  var MAX_MODEL_SLOTS = 6;

  /* 每次收到新快照重建映射，保证"今日总量最大"的模型拿到固定的第一色。 */
  function buildModelColors(models) {
    modelColorMap = {};
    var ranked = (models || []).slice().sort(function (a, b) {
      return (b.totalTokens || 0) - (a.totalTokens || 0);
    }).slice(0, MAX_MODEL_SLOTS);
    ranked.forEach(function (m, i) {
      modelColorMap[m.modelId] = COLORS[i % COLORS.length];
    });
    return ranked;
  }

  /* 查模型颜色；未登记（排名外）的给最后一个色位。 */
  function colorOfModel(modelId) {
    if (modelColorMap[modelId]) return modelColorMap[modelId];
    return COLORS[MAX_MODEL_SLOTS - 1];
  }

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function statCell(label, value, sub) {
    var w = el("div", "zdu-cell");
    w.appendChild(el("div", "zdu-cell-v", value));
    w.appendChild(el("div", "zdu-cell-l", label));
    if (sub) w.appendChild(el("div", "zdu-cell-s", sub));
    return w;
  }

  /* 24 小时堆叠柱：SVG。宽度自适应容器，高 132。
   * 每小时一段，段内按模型堆叠（与原生"每日×模型"趋势图同思路，只是换成小时）。
   *
   * viewBox 宽度必须等于 CSS 渲染宽度的像素数：preserveAspectRatio="none"
   * 会把 viewBox 非等比拉伸，若 viewBox 用 100 这类虚拟单位，24 个槽位会挤在
   * 左侧一小块（离线预览截图实测）。
   *
   * 宽度从已挂载的宿主卡片量，而不是新建的 wrap —— 元素没进 DOM 时
   * clientWidth 恒为 0，会退回 640 这个猜测值，窗口宽窄都对不上。 */
  function buildHourly(hourly, hostWidth) {
    var wrap = el("div", "zdu-chart");
    var W = Math.max(240, hostWidth || 640);
    var H = 132, padB = 18, padT = 6;
    var max = 0;
    hourly.forEach(function (h) { if (h.totalTokens > max) max = h.totalTokens; });
    if (max <= 0) max = 1;

    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "zdu-svg");

    var plotH = H - padB - padT;
    var slot = W / 24;
    var barW = Math.max(1.2, slot * 0.62);

    hourly.forEach(function (h, i) {
      var x = i * slot + (slot - barW) / 2;
      if (h.totalTokens <= 0) {
        /* 空小时：画一条极淡基线，让"没用量"也可见 */
        var l = document.createElementNS("http://www.w3.org/2000/svg", "line");
        l.setAttribute("x1", String(x)); l.setAttribute("x2", String(x + barW));
        l.setAttribute("y1", String(H - padB)); l.setAttribute("y2", String(H - padB));
        l.setAttribute("class", "zdu-empty");
        svg.appendChild(l);
        return;
      }
      var acc = 0;
      var models = (h.models || []).slice(0, MAX_MODEL_SLOTS);
      models.forEach(function (m) {
        var frac = (m.totalTokens || 0) / max;
        var segH = Math.max(0.35, frac * plotH);
        var y = H - padB - (acc + frac) * plotH;
        var rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", String(x));
        rect.setAttribute("y", String(y));
        rect.setAttribute("width", String(barW));
        rect.setAttribute("height", String(segH));
        /* 按 modelId 取色，不按当前列表下标 —— 保证跨图一致 */
        rect.setAttribute("fill", colorOfModel(m.modelId));
        rect.setAttribute("class", "zdu-bar");
        svg.appendChild(rect);
        acc += frac;
      });
    });

    /* 基线 */
    var base = document.createElementNS("http://www.w3.org/2000/svg", "line");
    base.setAttribute("x1", "0"); base.setAttribute("x2", String(W));
    base.setAttribute("y1", String(H - padB)); base.setAttribute("y2", String(H - padB));
    base.setAttribute("class", "zdu-axis");
    svg.appendChild(base);

    wrap.appendChild(svg);

    /* 刻度：0 / 6 / 12 / 18 时 */
    var ticks = el("div", "zdu-ticks");
    [0, 6, 12, 18].forEach(function (hh) {
      var t = el("span", "zdu-tick", String(hh).padStart(2, "0") + ":00");
      ticks.appendChild(t);
    });
    wrap.appendChild(ticks);
    return wrap;
  }

  /* 图例：只列全局映射表里的那些模型（当日总量前 6），顺序与「按模型」一致。
   * 颜色同样走 colorOfModel，不再按"首次出现顺序"另发一套。 */
  function legendFor(ranked) {
    if (!ranked || !ranked.length) return null;
    var lg = el("div", "zdu-legend");
    ranked.forEach(function (m) {
      var s = el("span", "zdu-lg");
      var dot = el("i", "zdu-dot");
      dot.style.background = colorOfModel(m.modelId);
      s.appendChild(dot);
      s.appendChild(el("span", "zdu-lg-t", shortModel(m.modelId)));
      lg.appendChild(s);
    });
    return lg;
  }

  function shortModel(id) {
    if (!id) return "?";
    var s = String(id);
    var i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function render() {
    if (stale()) return;
    var host = document.querySelector(".zdu-root");
    if (!host) return;
    var d = state.data;

    host.innerHTML = "";
    if (!d || d.ok === false) {
      var card0 = el("div", "zdu-card");
      card0.appendChild(head(L("今日用量", "Today's usage")));
      card0.appendChild(el("div", "zdu-empty-t",
        d && d.error ? (L("读取失败：", "Failed: ") + d.error) : L("等待数据…", "Waiting for data…")));
      host.appendChild(card0);
      return;
    }

    var s = d.summary || {};
    var card = el("div", "zdu-card");
    card.setAttribute("data-zdu-card", "today");

    /* ---- 标题行 ---- */
    var hd = head(L("今日用量", "Today's usage"));
    hd.appendChild(el("span", "zdu-date", (d.range && d.range.date) || ""));
    card.appendChild(hd);

    /* ---- 概览数字 ---- */
    var row = el("div", "zdu-stats");
    row.appendChild(statCell(L("合计 token", "Total tokens"), fmt(s.totalTokens)));
    row.appendChild(statCell(L("请求", "Requests"), fmtFull(s.requests),
      L(s.totalTurns + " 轮", s.totalTurns + " turns")));
    row.appendChild(statCell(L("缓存命中", "Cache hit"),
      s.cacheHitRate != null ? (s.cacheHitRate * 100).toFixed(1) + "%" : "--",
      L("新增 " + fmt(s.cacheFreshTokens), "fresh " + fmt(s.cacheFreshTokens))));
    row.appendChild(statCell(L("活跃时段", "Active hours"),
      (s.activeHours || 0) + "/24",
      s.firstAt ? (hhmm(s.firstAt) + " – " + hhmm(s.lastAt)) : ""));
    card.appendChild(row);

    /* ---- 24 小时分布 ---- */
    card.appendChild(el("div", "zdu-sec-t", L("24 小时分布（按模型堆叠）", "24-hour distribution (stacked by model)")));
    /* 卡片此刻尚未入 DOM，量不到宽度；先入 DOM 再补图表，或用宿主的可用宽度。
     * 宿主（.zdu-root）已在页面里，能量到。 */
    host.appendChild(card);
    var avail = (host.clientWidth || 0) - 32;   // 减去卡片左右内边距
    /* 先按"当日总量降序"建立模型→颜色映射，之后 24 小时图、图例、按模型三处
     * 共用同一张表，同一模型必然同色。 */
    var ranked = buildModelColors(d.models || []);
    card.appendChild(buildHourly(d.hourly || [], avail));
    var lg = legendFor(ranked);
    if (lg) card.appendChild(lg);

    /* ---- 两栏：模型 / 会话 ---- */
    var cols = el("div", "zdu-cols");

    var c1 = el("div", "zdu-col");
    c1.appendChild(el("div", "zdu-col-t", L("按模型", "By model")));
    var mmax = 0;
    ranked.forEach(function (m) { if (m.totalTokens > mmax) mmax = m.totalTokens; });
    if (!mmax) mmax = 1;
    ranked.forEach(function (m) {
      var it = el("div", "zdu-row");
      var nm = el("span", "zdu-name", shortModel(m.modelId));
      nm.title = m.modelId;
      it.appendChild(nm);
      var track = el("div", "zdu-track");
      var fill = el("i", "zdu-fill");
      fill.style.width = ((m.totalTokens / mmax) * 100).toFixed(1) + "%";
      fill.style.background = colorOfModel(m.modelId);
      track.appendChild(fill);
      it.appendChild(track);
      it.appendChild(el("span", "zdu-val", fmt(m.totalTokens)));
      c1.appendChild(it);
    });
    if (!ranked.length) c1.appendChild(el("div", "zdu-empty-t", "--"));
    cols.appendChild(c1);

    var c2 = el("div", "zdu-col");
    c2.appendChild(el("div", "zdu-col-t", L("按会话", "By session")));
    (d.sessions || []).slice(0, 6).forEach(function (x) {
      var it = el("div", "zdu-row zdu-row-s");
      var nm = el("span", "zdu-name", x.title);
      nm.title = (x.title || "") + (x.directory ? "\n" + x.directory : "");
      it.appendChild(nm);
      var sub = el("span", "zdu-sub",
        (x.isSub ? L("子代理 ", "sub ") : "") + fmt(x.totalTokens) +
        " · " + x.requests + L("次", "req") + " · " + hhmm(x.lastAt));
      it.appendChild(sub);
      c2.appendChild(it);
    });
    if (!(d.sessions || []).length) c2.appendChild(el("div", "zdu-empty-t", "--"));
    cols.appendChild(c2);

    card.appendChild(cols);

    /* ---- 底栏：主/子代理 + 工具 ---- */
    var foot = el("div", "zdu-foot");
    foot.appendChild(el("span", null,
      L("主会话 ", "main ") + fmt(s.mainTokens) + " (" + (s.mainRequests || 0) + L("次)", "req)") +
      L(" · 子代理 ", " · subagent ") + fmt(s.subTokens) + " (" + (s.subRequests || 0) + L("次)", "req)")));
    foot.appendChild(el("span", null,
      L("工具 ", "tools ") + fmtFull(s.toolCalls) + L(" 次", " calls") +
      (s.toolErrors ? L(" · 失败 ", " · err ") + s.toolErrors : "")));
    card.appendChild(foot);

    /* 卡片已在上方 appendChild 到 host（为了量宽度），这里不再重复挂载。 */
  }

  function head(title) {
    var h = el("div", "zdu-head");
    h.appendChild(el("span", "zdu-title", title));
    return h;
  }

  /* ---------------------------------------------------------------- 样式 */

  var CSS = [
    ".zdu-root{margin:16px 0 8px}",
    ".zdu-card{border:1px solid var(--color-border,rgba(127,127,127,.22));border-radius:12px;background:var(--color-surface,#fff);padding:16px}",
    ".zdu-head{display:flex;align-items:baseline;gap:10px;margin-bottom:14px}",
    ".zdu-title{font-size:15px;font-weight:600;color:var(--color-foreground,inherit)}",
    ".zdu-date{margin-left:auto;font-size:12px;color:var(--color-foreground-subtle,inherit);opacity:.8}",
    ".zdu-stats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}",
    ".zdu-cell{flex:1 1 130px;min-width:0;padding:10px 12px;border-radius:10px;background:var(--color-surface-secondary,rgba(127,127,127,.06))}",
    ".zdu-cell-v{font-size:19px;font-weight:600;color:var(--color-foreground,inherit);font-variant-numeric:tabular-nums;line-height:1.2}",
    ".zdu-cell-l{margin-top:2px;font-size:12px;color:var(--color-foreground-subtle,inherit)}",
    ".zdu-cell-s{margin-top:1px;font-size:11px;color:var(--color-foreground-subtle,inherit);opacity:.75;font-variant-numeric:tabular-nums}",
    ".zdu-sec-t{margin:0 0 8px;font-size:13px;font-weight:500;color:var(--color-foreground,inherit)}",
    ".zdu-chart{position:relative}",
    ".zdu-svg{width:100%;height:132px;display:block}",
    ".zdu-bar{rx:1;transition:opacity .15s}",
    ".zdu-bar:hover{opacity:.75}",
    ".zdu-axis{stroke:var(--color-border,rgba(127,127,127,.3));stroke-width:.4}",
    ".zdu-empty{stroke:var(--color-border,rgba(127,127,127,.18));stroke-width:.5}",
    ".zdu-ticks{display:flex;justify-content:space-between;margin-top:2px}",
    ".zdu-tick{font-size:10px;color:var(--color-foreground-subtle,inherit);opacity:.7}",
    ".zdu-legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}",
    ".zdu-lg{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--color-foreground-subtle,inherit)}",
    ".zdu-dot{width:8px;height:8px;border-radius:2px;display:inline-block}",
    ".zdu-lg-t{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".zdu-cols{display:flex;flex-wrap:wrap;gap:18px;margin-top:18px}",
    ".zdu-col{flex:1 1 260px;min-width:0}",
    ".zdu-col-t{margin-bottom:8px;font-size:12px;font-weight:500;color:var(--color-foreground-subtle,inherit)}",
    ".zdu-row{display:flex;align-items:center;gap:8px;padding:4px 0}",
    ".zdu-row-s{display:block}",
    ".zdu-name{flex:0 0 auto;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--color-foreground,inherit)}",
    ".zdu-track{flex:1 1 auto;min-width:40px;height:6px;border-radius:3px;background:var(--color-surface-secondary,rgba(127,127,127,.12));overflow:hidden}",
    ".zdu-fill{display:block;height:100%;border-radius:3px}",
    ".zdu-val{flex:0 0 auto;font-size:11px;color:var(--color-foreground-subtle,inherit);font-variant-numeric:tabular-nums}",
    ".zdu-sub{display:block;margin-top:1px;font-size:11px;color:var(--color-foreground-subtle,inherit);opacity:.8;font-variant-numeric:tabular-nums}",
    ".zdu-foot{display:flex;flex-wrap:wrap;gap:14px;justify-content:space-between;margin-top:16px;padding-top:12px;border-top:1px solid var(--color-border,rgba(127,127,127,.15));font-size:11px;color:var(--color-foreground-subtle,inherit)}",
    ".zdu-empty-t{padding:20px 0;text-align:center;font-size:12px;color:var(--color-foreground-subtle,inherit)}"
  ].join("");

  function injectStyle() {
    try {
      var old = document.getElementById("zdu-style");
      if (old) old.remove();
      var st = document.createElement("style");
      st.id = "zdu-style";
      st.textContent = CSS;
      document.head.appendChild(st);
    } catch (e) { err("style", e); }
  }

  /* ---------------------------------------------------------------- 监听 */

  /* 设置页是客户端路由切出来的，DOM 会整体重挂。用 MutationObserver 盯 body：
   * 目标不在就挂上，目标消失就摘掉（切走设置时不留残影）。 */
  var lastTick = 0;
  function tick() {
    if (stale()) return;
    var now = Date.now();
    if (now - lastTick < 400) return;
    lastTick = now;

    var here = isSettingsUsagePage();
    var cur = document.querySelector(".zdu-root");
    if (here) {
      if (!cur || !cur.isConnected) mountHost();
      else if (!state.data) render();
    } else if (cur) {
      cur.remove();
      state.mounted = false;
    }
  }

  /* 泵现在保证"无新写入时也定期推"（idle_push_ms，默认 4s），
   * 所以页面挂载后最多等一个周期就有数据，无需主动索要。
   *
   * 曾试过渲染端经 window.zcode 发 IPC 索取，实测 preload 暴露的 63 个方法
   * 全是业务 invoke，没有通用 ipcRenderer.send，走不通，故去掉该路径。 */
  function startWatch() {
    if (stale()) return;
    try {
      var mo = new MutationObserver(function () { tick(); });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) { err("observer", e); }
    /* 图表宽度按容器 clientWidth 建坐标系，窗口缩放后必须重画，
     * 否则 SVG 会被拉伸变形。去抖 250ms 避免拖拽时反复重排。 */
    var rzTimer = 0;
    try {
      window.addEventListener("resize", function () {
        clearTimeout(rzTimer);
        rzTimer = setTimeout(function () {
          if (!stale() && document.querySelector(".zdu-root")) render();
        }, 250);
      });
    } catch (e) { }
    /* 兜底：即便 MutationObserver 因批量更新被节流，2s 一次也能收敛 */
    setInterval(tick, 2000);
    tick();
  }

  /* ---------------------------------------------------------------- 数据入口 */

  window.__zduUpdate = function (payload) {
    if (stale()) return;
    if (!payload || typeof payload !== "object") return;
    state.data = payload;
    tick();
    /* 数据到了但页面还没判定为用量页，下一次 tick 会挂载 */
    if (isSettingsUsagePage() && !document.querySelector(".zdu-root")) mountHost();
  };

  /* ---------------------------------------------------------------- 启动 */

  injectStyle();
  syncTheme();
  startWatch();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startWatch, { once: true });
  }
  info("loaded");
})();
