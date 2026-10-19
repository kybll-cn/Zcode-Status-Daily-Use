/* 验证泵的限频分支：验证"无新写入也定期推"的判定与限频数值。
 * 从 inject-main.cjs 抽出 maybeSpawn 的判定部分重放，不依赖 electron。
 */
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "inject-main.cjs"), "utf8");

/* ---- 静态检查：关键改动是否在文件里 ---- */
const checks = [
  ["有 idle_push_ms 配置项", /idle_push_ms/.test(src)],
  ["心跳默认 6000", /heartbeat_ms: 6000/.test(src)],
  ["心跳下限 4000", /Math\.max\(4000, readCfg\(\)\.heartbeat_ms/.test(src)],
  ["无新写入不再直接 return", !/const st = dbStamp\(\);\s*\n\s*if \(st && st === lastStamp\) return;/.test(src)],
  ["按 fresh 分支选限频", /const fresh = st && st !== lastStamp;/.test(src)],
  ["热更新后重置时间戳", /lastStamp = 0;/.test(src)],
  ["overlay 走 maybeSpawn 补拉", /scheduleRetry\(400\)/.test(src)],
];

let ok = true;
console.log("=".repeat(56));
for (const [name, pass] of checks) {
  console.log((pass ? "  ✓ " : "  ✗ ") + name);
  if (!pass) ok = false;
}
console.log("=".repeat(56));

/* ---- 行为检查：重放限频判定 ---- */
function decide(st, lastStamp, lastSpawn, now, cfg) {
  if (busy) return { go: false, why: "busy" };
  const fresh = st && st !== lastStamp;
  const wait = fresh
    ? Math.max(2000, cfg.activity_min_ms | 0 || 8000)
    : Math.max(1500, cfg.idle_push_ms | 0 || 4000);
  if (now - lastSpawn < wait) return { go: false, why: "rate-limited", wait };
  return { go: true, fresh, wait };
}

let busy = false;
const cfg = { activity_min_ms: 8000, idle_push_ms: 4000 };
const NOW = 1_000_000;

const cases = [
  ["db 有新写入刚发生过", { st: 111, lastStamp: 111, lastSpawn: NOW - 10000 }, true],
  ["db 有新写入", { st: 222, lastStamp: 111, lastSpawn: NOW - 10000 }, true],
  ["db 无新写入，间隔已过", { st: 111, lastStamp: 111, lastSpawn: NOW - 5000 }, true],
  ["db 无新写入，间隔未到", { st: 111, lastStamp: 111, lastSpawn: NOW - 1000 }, false],
  ["首次调用 lastStamp=0", { st: 111, lastStamp: 0, lastSpawn: 0 }, true],
];

console.log("\n限频行为重放：");
for (const [name, args, want] of cases) {
  const r = decide(args.st, args.lastStamp, args.lastSpawn, NOW, cfg);
  const pass = r.go === want;
  if (!pass) ok = false;
  console.log(`  ${pass ? "✓" : "✗"} ${name.padEnd(26)} go=${r.go} ` +
              `${r.why ? "(" + r.why + ")" : ""} wait=${r.wait ?? "-"}`);
}

console.log("\n" + "=".repeat(56));
console.log(ok ? "全部通过" : "存在失败项");
process.exit(ok ? 0 : 1);
