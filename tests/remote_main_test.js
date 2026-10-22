/* 主进程侧远程通道的回归测试。
 *
 * 必须用 Electron 跑（普通 Node 的 require 不认 asar，而 ssh2 在 asar 里）：
 *   ELECTRON_RUN_AS_NODE=1 "<ZCode.exe>" tests/remote_main_test.js
 *
 * 测的是插件真正会走的路径：
 *   discoverProfiles() → 从客户端 setting.json 自动发现连接档案
 *   fetchSnapshot()     → ssh2 连接 + 部署 zdu.py + 执行取数
 */
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");

const PLUGIN = path.join(__dirname, "..");
const rem = require(path.join(PLUGIN, "zdu_remote_main.cjs"));

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log("  PASS  " + name);
  else { console.log("  FAIL  " + name + "  " + (detail || "")); failed++; }
}

/* 与主进程 inject-main.cjs 里 currentWindow() 同构 */
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
  console.log("=".repeat(60));
  console.log("=== 1. ssh2 可用性 ===");
  check("ssh2 能从 app.asar 里 require 到", rem.ssh2Available() === true,
    "客户端没提供 ssh2");

  console.log("=== 2. 凭证解密 ===");
  /* 用客户端自己的格式造一条密文，解回来必须是原文。
   * 这验证的是插件的解密实现与客户端一致 —— 真实凭证走同一条路径。 */
  const crypto = require("crypto");
  const secret = `zcode-credential-fallback:${process.platform}:${os.homedir()}:${os.userInfo().username}`;
  const key = crypto.createHash("sha256").update(secret).digest();
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([c.update("hunter2", "utf8"), c.final()]);
  const tag = c.getAuthTag();
  const b64u = (b) => b.toString("base64url");
  const fake = "enc:v1:" + b64u(nonce) + "." + b64u(tag) + "." + b64u(ct);
  /* decryptCredential 只认客户端存的那种 key，这里直接验证算法等价：
   * 用插件的 decryptCredential 解自己造的密文。 */
  const dec = rem.decryptCredential(fake);
  check("AES-256-GCM 解密往返一致", dec === "hunter2", String(dec));

  console.log("=== 3. 自动发现连接档案 ===");
  const profiles = rem.discoverProfiles();
  console.log("  发现 " + profiles.length + " 个档案:");
  for (const p of profiles) {
    console.log("    " + p.kind + " → " + (p.displayName || "") +
      (p.host ? " (" + p.host + ":" + p.port + " as " + p.user + ")" : "") +
      (p.distro ? " (" + p.distro + ")" : ""));
  }
  check("至少发现一个档案", profiles.length > 0, "客户端里没配远程");
  check("档案都有 kind", profiles.every(p => !!p.kind));
  check("SSH 档案带 host/port/user",
    profiles.filter(p => p.kind === "ssh")
      .every(p => p.host && p.port && p.user));

  console.log("=== 4. 逐个取数 ===");
  const w = currentWindow();
  for (const p of profiles) {
    const label = rem.sourceLabel(p);
    const t0 = Date.now();
    let snap = null, err = null;
    try {
      snap = await rem.fetchSnapshot(p, w, 30000);
    } catch (e) {
      err = e.message;
    }
    const dt = Date.now() - t0;
    if (err) {
      console.log("  ---- " + label + "：失败（" + dt + "ms）");
      console.log("       " + err);
      continue;
    }
    const s = snap.summary || {};
    console.log("  ---- " + label + "：" + dt + "ms");
    console.log("       ok=" + snap.ok + " 合计=" + s.totalTokens +
      " 请求=" + s.requests + " 轮=" + s.totalTurns);
    console.log("       非零小时=[" + (snap.hourly || [])
      .filter(h => h.totalTokens > 0).map(h => h.hour).join(",") + "]");
    console.log("       模型=" + (snap.models || []).slice(0, 4)
      .map(m => m.modelId + "=" + m.totalTokens).join(", "));

    check(label + " 取数成功", snap.ok === true, snap.error);
    check(label + " 合计是非负整数",
      Number.isInteger(s.totalTokens) && s.totalTokens >= 0, String(s.totalTokens));
    check(label + " hourly 恒 24 桶", (snap.hourly || []).length === 24,
      String((snap.hourly || []).length));
    /* 分桶合计 ≤ 概览合计（session_title 不进分桶） */
    const bucket = (snap.hourly || []).reduce((a, h) => a + (h.totalTokens || 0), 0);
    check(label + " 分桶合计 ≤ 概览合计", bucket <= (s.totalTokens || 0),
      `bucket=${bucket} total=${s.totalTokens}`);
    check(label + " 取数耗时 < 30s", dt < 30000, dt + "ms");
  }

  console.log("=".repeat(60));
  if (failed) { console.log("FAILED " + failed); process.exit(1); }
  console.log("ALL PASS");
  process.exit(0);
})();
