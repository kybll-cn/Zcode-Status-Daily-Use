/* 验证推送代码：含 U+2028/2029 的会话标题不能破坏注入的 JS 语法。
 * 这是"页面永远没数据"的隐藏原因 —— executeJavaScript 抛语法错误，
 * 而 pushOnce 把失败 catch 掉了，表现为静默无数据。
 */
"use strict";

const SEP = new RegExp(
  "[" + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + "]", "g"
);

/* 与 inject-main.cjs 的 pushOnce 完全同构 */
function buildJs(payload) {
  const json = JSON.stringify(payload).replace(SEP, function (c) {
    return c === String.fromCharCode(0x2028) ? "\\u2028" : "\\u2029";
  });
  return "window.__zduUpdate && window.__zduUpdate(" + json + ")";
}

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

const cases = [
  ["普通数据", { ok: true, summary: { totalTokens: 12345 } }],
  ["标题含 U+2028", { sessions: [{ title: "标题" + LS + "后续" }] }],
  ["标题含 U+2029", { sessions: [{ title: "标题" + PS + "后续" }] }],
  ["目录含分隔符", { sessions: [{ dir: "D:\\a" + LS + "\\b" }] }],
  ["同时含两种", { a: LS, b: PS, c: LS + PS }],
  ["空 payload", {}],
];

let ok = true;
console.log("=".repeat(60));
for (const [name, payload] of cases) {
  const js = buildJs(payload);
  const hasRaw = js.includes(LS) || js.includes(PS);
  let valid = true, err = "";
  try {
    new Function(js);
  } catch (e) {
    valid = false;
    err = e.message;
  }
  const pass = valid && !hasRaw;
  if (!pass) ok = false;
  console.log(`  ${pass ? "✓" : "✗"} ${name.padEnd(18)} 语法${valid ? "合法" : "错误"} ` +
              `裸分隔符=${hasRaw ? "有(危险)" : "无"}`);
  if (err) console.log(`      ${err}`);
}

/* 反向验证：如果不转义会怎样 —— 说明这个修复为什么必要 */
console.log("\n对照：不转义直接用 JSON.stringify 会怎样：");
const bad = "f(" + JSON.stringify({ t: "标题" + LS + "后续" }) + ")";
try {
  new Function(bad);
  console.log("  ？ 未转义也合法（浏览器已修复该问题）");
} catch (e) {
  console.log("  ✗ 不转义则语法错误:", e.message.split("\n")[0]);
  console.log("    → 这正是页面无数据的原因（executeJavaScript 失败被静默 catch）");
}

console.log("=".repeat(60));
console.log(ok ? "✓ 全部通过" : "✗ 存在失败项");
process.exit(ok ? 0 : 1);
