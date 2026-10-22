/* 用**安装目录**里的实际文件跑一遍完整链路，验证部署产物可用。
 *
 * 不碰源码目录 —— 装到用户机器上的就是那一份，验它才对。
 * 必须用 Electron 跑（require asar 里的 ssh2）。
 */
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const DEST = "C:/Users/kybll/.zcode/Zcode-Status-Daily-Use";
const PY = "C:/Users/kybll/AppData/Local/Programs/Python/Python312/python.exe";

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
  console.log("=== 1. 安装目录 ===");
  for (const f of ["inject-main.cjs", "overlay.js", "zdu.py", "zdu_multi.py",
                   "zdu_remote.py", "zdu_aggregate.py", "zdu_remote_main.cjs",
                   "config.json"]) {
    check("文件在位: " + f, fs.existsSync(path.join(DEST, f)));
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(DEST, "config.json"), "utf8"));
  check("discover_remote 已开", cfg.discover_remote === true, String(cfg.discover_remote));

  const rem = require(path.join(DEST, "zdu_remote_main.cjs"));
  check("ssh2 可用", rem.ssh2Available() === true);

  console.log("=== 2. 自动发现 + 取远程 ===");
  const profiles = rem.discoverProfiles();
  console.log("  发现 " + profiles.length + " 个档案");
  for (const p of profiles) {
    console.log("    " + p.kind + " → " + (p.displayName || ""));
  }
  check("发现档案", profiles.length > 0);

  const w = currentWindow();
  const remote = await Promise.all(profiles.map(async (p) => {
    const label = rem.sourceLabel(p);
    try {
      const snap = await rem.fetchSnapshot(p, w, 30000);
      console.log("  " + label + " → " + (snap.summary || {}).totalTokens + " token");
      return { source: label, snapshot: snap };
    } catch (e) {
      console.log("  " + label + " → 失败: " + e.message);
      return { source: label, error: e.message };
    }
  }));

  console.log("=== 3. 发给 Python 合并 ===");
  const proc = spawn(PY, [path.join(DEST, "zdu_multi.py"), "serve"], {
    stdio: ["pipe", "pipe", "pipe"], encoding: "utf8",
  });
  let out = "", err = "";
  proc.stdout.on("data", (d) => { out += d; });
  proc.stderr.on("data", (d) => { err += d; });
  proc.stdin.write(JSON.stringify({ window: w, remote }) + "\n");
  await new Promise((res) => {
    const iv = setInterval(() => { if (out.includes("\n")) { clearInterval(iv); res(); } }, 100);
    setTimeout(() => { clearInterval(iv); res(); }, 90000);
  });
  try { proc.stdin.end(); } catch (e) { }
  try { proc.kill(); } catch (e) { }
  if (err.trim()) console.log("  stderr:", err.slice(0, 300));

  const line = out.split("\n").find((l) => l.trim().startsWith("{"));
  check("Python 返回 JSON", !!line, out.slice(0, 200));
  if (!line) { console.log("FAILED"); process.exit(1); }
  const merged = JSON.parse(line);

  console.log("  合计=" + merged.summary.totalTokens + " 请求=" + merged.summary.requests);
  for (const s of merged.sources || []) {
    console.log("    - " + s.source + ": ok=" + s.ok + " tokens=" + s.totalTokens +
      (s.error ? " err=" + s.error : ""));
  }

  check("合并 ok", merged.ok === true, merged.error);
  const names = (merged.sources || []).map(s => s.source);
  check("来源无重复", new Set(names).size === names.length, JSON.stringify(names));
  const sum = (merged.sources || []).filter(s => s.ok !== false)
    .reduce((a, s) => a + (s.totalTokens || 0), 0);
  check("各源之和 = 合计", sum === merged.summary.totalTokens,
    `${sum} vs ${merged.summary.totalTokens}`);
  const remoteOk = names.filter(n => n !== "本机");
  check("包含远程源", remoteOk.length > 0, JSON.stringify(names));

  console.log("=".repeat(56));
  if (failed) { console.log("FAILED " + failed); process.exit(1); }
  console.log("DEPLOYED OK");
  process.exit(0);
})();
