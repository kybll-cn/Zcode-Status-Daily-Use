/* 端到端：主进程侧取远程 → 按主进程的协议发给 Python → 验证合并结果。
 *
 * 模拟 inject-main.cjs 的 runQuery()：
 *   1. currentWindow() 算窗口
 *   2. collectRemote(window) 取各远程快照
 *   3. buildRequest(remote) 造请求行
 *   4. 写给常驻 zdu_multi.py serve，读回合并结果
 *
 * 必须用 Electron 跑（require asar 里的 ssh2）。
 */
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const PLUGIN = path.join(__dirname, "..");
const rem = require(path.join(PLUGIN, "zdu_remote_main.cjs"));

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log("  PASS  " + name);
  else { console.log("  FAIL  " + name + "  " + (detail || "")); failed++; }
}

function currentWindow() {
  const now = Date.now();
  let tz = 0;
  try {
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: tzName, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(now)).reduce((a, x) => {
      if (x.type !== "literal") a[x.type] = x.value; return a;
    }, {});
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    tz = wall - (now - (now % 1000));
    if (Math.abs(tz) >= 15 * 3600000) tz = 0;
  } catch (e) { tz = 0; }
  const dayIndex = Math.floor((now + tz) / 86400000);
  return { startMs: dayIndex * 86400000 - tz, endMs: now, tzOffsetMs: tz };
}

(async () => {
  console.log("=== 1. 主进程侧取远程 ===");
  const w = currentWindow();
  console.log("  窗口:", JSON.stringify(w));
  const profiles = rem.discoverProfiles();
  const remote = await Promise.all(profiles.map(async (p) => {
    const label = rem.sourceLabel(p);
    try {
      const snap = await rem.fetchSnapshot(p, w, 30000);
      console.log("  " + label + " → " + (snap.summary || {}).totalTokens);
      return { source: label, snapshot: snap };
    } catch (e) {
      console.log("  " + label + " → 失败: " + e.message);
      return { source: label, error: e.message };
    }
  }));
  check("远程快照已取回", remote.length > 0);

  console.log("=== 2. 按主进程协议发给 Python ===");
  const req = JSON.stringify({ window: w, remote });
  const py = process.env.ZDU_PYTHON || "python";
  const proc = spawn(py, [path.join(PLUGIN, "zdu_multi.py"), "serve"], {
    stdio: ["pipe", "pipe", "pipe"], encoding: "utf8",
  });
  let out = "", err = "";
  proc.stdout.on("data", (d) => { out += d; });
  proc.stderr.on("data", (d) => { err += d; });

  proc.stdin.write(req + "\n");
  const t0 = Date.now();
  await new Promise((resolve) => {
    const iv = setInterval(() => { if (out.includes("\n")) { clearInterval(iv); resolve(); } }, 100);
    setTimeout(() => { clearInterval(iv); resolve(); }, 120000);
  });
  const dt = Date.now() - t0;
  try { proc.stdin.end(); } catch (e) { }
  try { proc.kill(); } catch (e) { }

  if (err.trim()) console.log("  python stderr:", err.slice(0, 300));
  const line = out.split("\n").find((l) => l.trim().startsWith("{"));
  check("Python 返回了 JSON", !!line, out.slice(0, 200));
  if (!line) { console.log("FAILED"); process.exit(1); }
  const merged = JSON.parse(line);

  console.log("=== 3. 验证合并结果 ===");
  console.log("  耗时 " + dt + "ms");
  console.log("  合计=" + merged.summary.totalTokens +
    " 请求=" + merged.summary.requests + " 轮=" + merged.summary.totalTurns);
  console.log("  来源:");
  for (const s of merged.sources || []) {
    console.log("    - " + s.source + ": ok=" + s.ok +
      " tokens=" + s.totalTokens + " req=" + s.requests +
      (s.error ? " err=" + s.error : ""));
  }
  console.log("  非零小时: [" + (merged.hourly || [])
    .filter(h => h.totalTokens > 0).map(h => h.hour).join(",") + "]");
  console.log("  模型: " + (merged.models || []).slice(0, 6)
    .map(m => m.modelId + "=" + m.totalTokens).join(", "));

  check("合并结果 ok", merged.ok === true, merged.error);
  check("localLabel 已带出", merged.localLabel === "本机", merged.localLabel);
  check("包含本地源", (merged.sources || []).some(s => s.source === "本机"));

  /* 源不能重复 —— 曾真的发生过：主进程自动发现的 WSL 与 Python 自己取的那个
   * 同名，合计里算了两遍。 */
  const names = (merged.sources || []).map(s => s.source);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  check("来源无重复", dupes.length === 0, "重复: " + JSON.stringify(dupes));
  console.log("  来源列表: " + names.join(" | "));

  const remoteOk = (merged.sources || []).filter(s => s.ok !== false && s.source !== "本机");
  check("包含远程源", remoteOk.length > 0,
    JSON.stringify((merged.sources || []).map(s => s.source)));

  /* 各源之和 = 合计 */
  const sum = (merged.sources || [])
    .filter(s => s.ok !== false)
    .reduce((a, s) => a + (s.totalTokens || 0), 0);
  check("各源之和 = 合计", sum === merged.summary.totalTokens,
    `${sum} vs ${merged.summary.totalTokens}`);

  /* 远程有量时，合计必须大于本地 */
  const local = (merged.sources || []).find(s => s.source === "本机");
  if (local && remoteOk.length) {
    check("合计 > 本地（远程已并入）",
      merged.summary.totalTokens > local.totalTokens,
      `${merged.summary.totalTokens} vs ${local.totalTokens}`);
  }

  /* hourly 24 桶 + 分桶合计 ≤ 概览 */
  check("hourly 恒 24 桶", (merged.hourly || []).length === 24);
  const bucket = (merged.hourly || [])
    .reduce((a, h) => a + (h.totalTokens || 0), 0);
  check("分桶合计 ≤ 概览合计", bucket <= merged.summary.totalTokens,
    `bucket=${bucket} total=${merged.summary.totalTokens}`);

  console.log("=".repeat(60));
  if (failed) { console.log("FAILED " + failed); process.exit(1); }
  console.log("ALL PASS");
  process.exit(0);
})();
