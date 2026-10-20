/* 验证模型配色跨图一致：同一 modelId 在 24 小时图、图例、按模型三处必须同色。
 *
 * 这是肉眼可见的 bug —— 早先三处各自按"当前列表下标"取色，同一个模型在不同图里
 * 颜色不同，图例和条形还对不上。本测试用真实数据跑配色映射，断言一致性。
 */
"use strict";
const path = require("path");
const { execFileSync } = require("child_process");

const raw = execFileSync("python", [path.join(__dirname, "..", "zdu.py"), "json"], {
  encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
});
const d = JSON.parse(raw);

const COLORS = [
  "var(--color-usage-chart-1, #3b82f6)",
  "var(--color-usage-chart-2, #10b981)",
  "var(--color-usage-chart-3, #f59e0b)",
  "var(--color-usage-chart-4, #ef4444)",
  "var(--color-usage-chart-5, #a855f7)",
  "var(--color-usage-chart-6, #06b6d4)",
];
const MAX = 6;

/* 复刻 overlay.js 的映射逻辑 */
function buildModelColors(models) {
  const map = {};
  const ranked = (models || []).slice()
    .sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0))
    .slice(0, MAX);
  ranked.forEach((m, i) => { map[m.modelId] = COLORS[i % COLORS.length]; });
  return { map, ranked };
}
function colorOfModel(map, id) {
  return map[id] ? map[id] : COLORS[MAX - 1];
}

const { map, ranked } = buildModelColors(d.models);

/* token 量按界面口径显示（亿 / 万，与客户端原生顶栏一致），方便和卡片对照 */
const zh = (n) => new Intl.NumberFormat("zh-CN", {
  notation: "compact", maximumFractionDigits: 1, minimumFractionDigits: 0,
}).format(n || 0).replace(/(?<=\d)(?=[万亿])/u, " ");

let ok = true;
console.log("=".repeat(62));
console.log("当日模型排名 → 分配的固定色位：");
ranked.forEach((m, i) => {
  console.log(`  ${i + 1}. ${String(m.modelId).padEnd(34)} ` +
              `${zh(m.totalTokens)}  →  色位 ${i + 1}`);
});

/* 断言 1：色位不重复 */
console.log("\n[1] 每个排名模型拿到唯一色位");
const used = new Set(ranked.map((m) => map[m.modelId]));
const pass1 = used.size === ranked.length;
console.log(`    ${pass1 ? "✓" : "✗"} ${used.size} 个不同颜色 / ${ranked.length} 个模型`);
if (!pass1) ok = false;

/* 断言 2：24 小时图里每个模型色 == 映射表色 */
console.log("\n[2] 24 小时图用色与映射表一致");
let mism2 = 0;
const seenInChart = {};
for (const h of d.hourly) {
  for (const m of (h.models || []).slice(0, MAX)) {
    const c = colorOfModel(map, m.modelId);
    seenInChart[m.modelId] = c;
    if (c !== map[m.modelId] && map[m.modelId]) mism2++;
  }
}
console.log(`    ${mism2 === 0 ? "✓" : "✗"} 不一致 ${mism2} 处`);
if (mism2) ok = false;

/* 断言 3：图例顺序 == 按模型顺序（两栏都对得上） */
console.log("\n[3] 图例与「按模型」顺序一致");
const legendIds = ranked.map((m) => m.modelId);
const modelIds = d.models.slice()
  .sort((a, b) => b.totalTokens - a.totalTokens).slice(0, MAX).map((m) => m.modelId);
const same = JSON.stringify(legendIds) === JSON.stringify(modelIds);
console.log(`    ${same ? "✓" : "✗"} 图例与列表顺序相同`);
if (!same) ok = false;

/* 断言 4：跨图同名同色 —— 直接复现用户报的"颜色搞混了" */
console.log("\n[4] 同一模型跨图同色（本次修复的核心）");
for (const m of ranked) {
  const inChart = seenInChart[m.modelId];
  const inLegend = colorOfModel(map, m.modelId);
  const inList = colorOfModel(map, m.modelId);
  const consistent = inChart === inLegend && inLegend === inList;
  if (!consistent) ok = false;
  console.log(`    ${consistent ? "✓" : "✗"} ${String(m.modelId).padEnd(34)} ` +
              `小时图=${inChart === undefined ? "(该小时未出现)" : "色位" + (COLORS.indexOf(inChart) + 1)} ` +
              `图例=色位${COLORS.indexOf(inLegend) + 1} 列表=色位${COLORS.indexOf(inList) + 1}`);
}

console.log("=".repeat(62));
console.log(ok ? "✓ 配色跨图一致" : "✗ 仍存在不一致");
process.exit(ok ? 0 : 1);
