/* Zcode-Status-Daily-Use 的远程取数通道（主进程侧）。
 *
 * 为什么放在主进程：
 *   - SSH 用客户端自带的 ssh2 库（在 app.asar 里），不需要另装依赖；
 *   - 凭证从客户端自己的 credentials.json 解密（算法与客户端一致），
 *     插件不需要知道密码，用户也不必在配置里写明文；
 *   - 远程连接档案从客户端的 setting.json 自动发现，不用手填。
 *
 * 三个通道的取数流程都一样：
 *   1. 探库（远端有没有 python3、库在哪）
 *   2. 传 zdu.py（base64 + 原子替换，幂等）
 *   3. 执行 zdu.py json --window <json>，拿回快照
 *
 * 与 Python 侧 zdu_remote.py 的关系：那个文件是「独立可用的 Python 实现」，
 * 走 ssh.exe / wsl.exe / docker exec。**主进程走本文件**，因为它能用 ssh2 和
 * 客户端凭证。两者产出的快照结构完全一致，合并层不区分来源。
 */
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const MARK = "zdaily";
const LOG = (...a) => console.error("[" + MARK + "]", ...a);

/* ---------------------------------------------------------------- 客户端资源定位 */

/* ssh2 在 app.asar 的 node_modules 里。Electron 的 fs 层认 asar，所以绝对路径
 * 可以 require；但裸模块名 "ssh2" 解析不到 —— 插件目录在 ~/.zcode/ 下，
 * Node 向上找 node_modules 找不到 asar 内部。
 * 路径从 process.execPath 反推，不硬编码安装位置。 */
let ssh2Cache;
function ssh2() {
  if (ssh2Cache !== undefined) return ssh2Cache;
  try {
    const res = path.join(path.dirname(process.execPath), "resources", "app.asar",
                          "node_modules", "ssh2");
    ssh2Cache = require(res);
  } catch (e) {
    ssh2Cache = null;
    LOG("ssh2 不可用:", e.message);
  }
  return ssh2Cache;
}

/* ---------------------------------------------------------------- 客户端配置读取 */

const SETTINGS = path.join(os.homedir(), ".zcode", "v2", "setting.json");
const CREDS = path.join(os.homedir(), ".zcode", "v2", "credentials.json");

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

/* 客户端的凭证加密：AES-256-GCM，密钥 = sha256(secret)。
 * secret 取 ZCODE_CREDENTIAL_SECRET，没有就回退到
 * `zcode-credential-fallback:<platform>:<homedir>:<username>`。
 * 密文格式 "enc:v1:<b64url nonce12>.<b64url tag16>.<b64url ciphertext>"。
 * —— 与客户端 out/host/index.js 的 createCredentialCipherProvider 逐字对齐。 */
function b64urlDec(s) {
  return Buffer.from(s + "=".repeat((4 - (s.length % 4)) % 4), "base64url");
}

function credentialSecret() {
  if (process.env.ZCODE_CREDENTIAL_SECRET) return process.env.ZCODE_CREDENTIAL_SECRET;
  let user = "unknown";
  try { user = os.userInfo().username; } catch (e) { }
  return `zcode-credential-fallback:${process.platform}:${os.homedir()}:${user}`;
}

function decryptCredential(value) {
  const PREFIX = "enc:v1:";
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return null;
  const parts = value.slice(PREFIX.length).split(".");
  if (parts.length !== 3) return null;
  let nonce, tag, ct;
  try {
    nonce = b64urlDec(parts[0]);
    tag = b64urlDec(parts[1]);
    ct = b64urlDec(parts[2]);
  } catch (e) { return null; }
  if (nonce.length !== 12 || tag.length !== 16) return null;
  const key = crypto.createHash("sha256").update(credentialSecret()).digest();
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch (e) {
    return null;
  }
}

/* 读某个 connection-profile 的密码 */
function loadProfilePassword(profileId) {
  const creds = readJson(CREDS);
  if (!creds) return null;
  const key = `connection-profile:${profileId}:password`;
  if (creds[key] === undefined) return null;
  return decryptCredential(creds[key]);
}

/* ---------------------------------------------------------------- 连接档案发现 */

/* 客户端的 setting.json 里有 connectionProfiles 与 sourceServers。
 * 每个 profile 的 target 就是一个远程目标：
 *   {kind:"ssh", host, port, username, passwordCredentialKey, privateKeyPath, …}
 *   {kind:"wsl", distro, user}
 *   {kind:"docker", container}
 * 我们把它们转成插件的 remote source 描述。
 *
 * 过滤条件：只取「客户端自己认的」活跃档案 —— lifecycleState 不是 retired、
 * 且有 target 的。retired 的档案是历史遗留，连上去会失败。 */
function discoverProfiles() {
  const s = readJson(SETTINGS);
  if (!s) return [];
  const out = [];
  for (const p of (s.connectionProfiles || [])) {
    if (!p || !p.target) continue;
    if (p.lifecycleState && p.lifecycleState !== "active") continue;
    const t = p.target;
    if (t.kind === "ssh") {
      out.push({
        kind: "ssh",
        host: t.host,
        port: t.port || 22,
        user: t.username,
        profileId: p.profileId,
        displayName: p.displayName || t.host,
        hasPassword: !!t.passwordCredentialKey,
        hasPrivateKey: !!t.privateKeyPath,
      });
    } else if (t.kind === "wsl") {
      out.push({
        kind: "wsl",
        distro: t.distro || "",
        user: t.user || "",
        profileId: p.profileId,
        displayName: p.displayName || t.distro || "WSL",
      });
    } else if (t.kind === "docker") {
      out.push({
        kind: "docker",
        container: t.container,
        profileId: p.profileId,
        displayName: p.displayName || t.container,
      });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 通道实现 */

const DEFAULT_TIMEOUT = 25;

/* SSH 的连接要复用：每次重连一次要 3-4 秒（TCP + 握手 + 认证），
 * 而一次取数要跑好几条命令（探 home、查 sha256、传脚本、跑取数）。
 * 所以把「一条连接跑完整个流程」做成一个会话对象。 */
function openSsh(src) {
  return new Promise((resolve, reject) => {
    const mod = ssh2();
    if (!mod) return reject(new Error("ssh2 不可用（客户端未提供）"));
    const conn = new mod.Client();
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const timer = setTimeout(() => {
      try { conn.end(); } catch (e) { }
      finish(reject, new Error("ssh 连接超时"));
    }, 20000);
    conn.on("ready", () => {
      clearTimeout(timer);
      finish(resolve, {
        exec(cmd) {
          return new Promise((res, rej) => {
            let done = false;
            const t = setTimeout(() => {
              if (done) return;
              done = true;
              rej(new Error("ssh exec 超时"));
            }, DEFAULT_TIMEOUT * 1000);
            conn.exec(cmd, (err, stream) => {
              if (err) {
                clearTimeout(t); done = true;
                return rej(new Error(err.message));
              }
              let out = "", se = "";
              stream.on("data", (d) => { out += d.toString("utf8"); });
              stream.stderr.on("data", (d) => { se += d.toString("utf8"); });
              stream.on("close", (code) => {
                clearTimeout(t); done = true;
                res({ stdout: out, stderr: se, code: code === undefined ? 0 : code });
              });
            });
          });
        },
        close() { try { conn.end(); } catch (e) { } },
      });
    });
    conn.on("error", (e) => {
      clearTimeout(timer);
      finish(reject, new Error(e.message));
    });
    try {
      conn.connect(sshConfig(src));
    } catch (e) {
      clearTimeout(timer);
      finish(reject, new Error(e.message));
    }
  });
}

/* 一个「会话」：能 exec、能上传。SSH 走一条连接；WSL/Docker 每次 spawn。 */
function openSession(src) {
  if (src.kind === "ssh") {
    return openSsh(src).then((s) => ({
      exec: (cmd, timeout) => s.exec(cmd, timeout),
      upload: (remotePath, content, timeout) => uploadViaExec(s, remotePath, content, timeout),
      close: () => s.close(),
    }));
  }
  /* WSL / Docker：每次命令一个 spawn（没有可复用的连接概念） */
  const sess = {
    exec: (cmd, timeout) => execLocal(src, cmd, timeout),
    close: () => { },
  };
  sess.upload = (remotePath, content, timeout) =>
    uploadViaExec(sess, remotePath, content, timeout);
  return Promise.resolve(sess);
}

/* 通过会话上传（base64 + 原子替换）。 */
function uploadViaExec(sess, remotePath, content, timeout) {
  const b64 = content.toString("base64");
  const dir = remotePath.slice(0, remotePath.lastIndexOf("/"));
  /* 路径是绝对路径（探库拿到的 home），单引号安全。
   * 用 .new + mv 做原子替换 —— 直接写的话，中途失败会留下半个脚本。 */
  const cmd =
    `set -e; mkdir -p '${dir}'; ` +
    `printf '%s' '${b64}' | base64 -d > '${remotePath}.new' && ` +
    `mv '${remotePath}.new' '${remotePath}' && ` +
    `chmod +x '${remotePath}' && echo OK\n`;
  return sess.exec(cmd, timeout).then((r) => {
    if (r.code !== 0 || !/\bOK\b/.test(r.stdout || "")) {
      throw new Error("上传失败: " + (r.stderr || r.stdout || "").slice(0, 200));
    }
    return remotePath;
  });
}

/* ---- SSH ---- */

function sshConfig(src) {
  const cfg = {
    host: src.host,
    port: src.port || 22,
    username: src.user,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
  };
  const pw = src.password !== undefined ? src.password : loadProfilePassword(src.profileId);
  if (pw) {
    cfg.password = pw;
    cfg.tryKeyboard = true;
  }
  if (src.privateKeyPath) {
    try {
      cfg.privateKey = fs.readFileSync(
        src.privateKeyPath.replace(/^~/, os.homedir()));
    } catch (e) {
      LOG("读私钥失败:", e.message);
    }
  }
  return cfg;
}

/* ---- WSL / Docker ---- */

function execLocal(src, cmd, timeout) {
  return new Promise((resolve, reject) => {
    let argv;
    if (src.kind === "wsl") {
      argv = ["wsl.exe"];
      if (src.distro) argv.push("-d", src.distro);
      if (src.user) argv.push("-u", src.user);
      argv.push("--", "sh", "-s");
    } else if (src.kind === "docker") {
      argv = ["docker", "exec", "-i", src.container, "sh", "-s"];
    } else {
      return reject(new Error("未知通道: " + src.kind));
    }
    const child = spawn(argv[0], argv.slice(1), { windowsHide: true });
    let out = "", se = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { }
      reject(new Error(`超时 ${timeout}s`));
    }, (timeout || DEFAULT_TIMEOUT) * 1000);
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { se += d.toString("utf8"); });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(e.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: out, stderr: se, code: code === null ? 0 : code });
    });
    try { child.stdin.write(cmd); child.stdin.end(); } catch (e) { }
  });
}

/* ---------------------------------------------------------------- 取数流程 */

const REMOTE_DIR = ".zcode/zcode-status-daily-use";

/* 远端 home。
 *
 * 一律用**绝对路径**，不用 "~" 或 "$HOME"：
 *   - "~" 在单引号里不展开，会被当成普通字符拼成相对路径；
 *   - "$HOME" 虽然在双引号里能展开，但一旦这个字符串又被切分、拼接
 *     （切目录再拼回去），就会出现 "$HOME/a/$HOME/a/zdu.py" 这样的重复。
 * 探库那一步顺带就能拿到远端 home（Python 的 os.path.expanduser），
 * 拿不到再退回 "~"（并在命令里用双引号）。 */
async function remoteHome(sess, timeout) {
  const py = "python3";
  const cmd = `${py} -c "import os;print(os.path.expanduser('~'))"\n`;
  const r = await sess.exec(cmd, timeout);
  if (r.code !== 0) return "~";
  const home = (r.stdout || "").trim().split("\n").filter(Boolean)[0];
  return (home && home.startsWith("/")) ? home : "~";
}

function remoteScriptPath(home) {
  return `${home}/${REMOTE_DIR}/zdu.py`;
}

/* 探库：远端有没有 python3、库在哪 —— 与客户端 resolveAgentSessionDbPath 同口径。 */
const PROBE_PY = [
  "import os,json",
  "p=os.environ.get('ZCODE_SESSION_DB_PATH') or os.environ.get('ZCODE_SESSION_DB')",
  "cfg=os.path.expanduser('~/.zcode/cli/config.json')",
  "if not p and os.path.exists(cfg):",
  "    try:",
  "        p=(json.load(open(cfg)).get('storage') or {}).get('sessionDbPath')",
  "    except Exception:",
  "        p=None",
  "p=os.path.expanduser(p) if p else os.path.expanduser('~/.zcode/cli/db/db.sqlite')",
  "print(json.dumps({'db':p,'exists':os.path.exists(p)}))",
].join("\n");

async function probe(src, timeout) {
  const py = src.python || "python3";
  const sess = await openSession(src);
  try {
    const cmd = `${py} - <<'PYEOF'\n${PROBE_PY}\nPYEOF\n`;
    const r = await sess.exec(cmd, timeout);
    if (r.code !== 0) {
      throw new Error("探测失败: " + (r.stderr || r.stdout || "").slice(0, 200));
    }
    for (const ln of (r.stdout || "").split("\n")) {
      const s = ln.trim();
      if (s.startsWith("{")) {
        const d = JSON.parse(s);
        return { ok: true, dbPath: d.db, exists: !!d.exists };
      }
    }
    throw new Error("探测无输出");
  } finally {
    sess.close();
  }
}

/* 取一份远端快照。window 传了就按该时间窗查（多源对齐用）。
 *
 * 命令合并：探 home 与查 sha256 合成一条，省一次往返
 * （跨境网络上一次 SSH exec 要 1-2 秒）。
 * 输出两行：第一行 home（可能是空），第二行 sha256（可能是空）。 */
const PROBE_AND_HASH = [
  "printf '%s\\n' \"$HOME\"",
  "if [ -f \"$HOME/.zcode/zcode-status-daily-use/zdu.py\" ]; then",
  "  sha256sum \"$HOME/.zcode/zcode-status-daily-use/zdu.py\" | cut -d' ' -f1",
  "fi",
].join("\n");

async function fetchSnapshot(src, window, timeout) {
  timeout = timeout || DEFAULT_TIMEOUT;
  const py = src.python || "python3";
  const sess = await openSession(src);
  try {
    /* 1. 一条命令拿到 home 与远端脚本的 sha256 */
    const probeR = await sess.exec(PROBE_AND_HASH + "\n", timeout);
    const lines = (probeR.stdout || "").split("\n").map(s => s.trim()).filter(Boolean);
    let home = lines[0] || "";
    let have = lines[1] || null;
    if (!home.startsWith("/")) home = "~";

    const script = remoteScriptPath(home);
    const dir = script.slice(0, script.lastIndexOf("/"));

    /* 2. 部署（幂等：sha256 一致就跳过传输） */
    const local = path.join(__dirname, "zdu.py");
    const content = fs.readFileSync(local);
    const want = crypto.createHash("sha256").update(content).digest("hex");
    if (have !== want) {
      await sess.upload(script, content, timeout);
    }

    /* 3. 执行取数 */
    const wjson = JSON.stringify({
      startMs: window.startMs, endMs: window.endMs, tzOffsetMs: window.tzOffsetMs,
    });
    const cmd = `cd '${dir}' && ${py} '${script}' json --window '${wjson}'\n`;
    const r = await sess.exec(cmd, timeout);
    if (r.code !== 0) {
      throw new Error("取数失败: " + (r.stderr || r.stdout || "").slice(0, 200));
    }
    for (const ln of (r.stdout || "").split("\n")) {
      const s = ln.trim();
      if (s.startsWith("{")) return JSON.parse(s);
    }
    throw new Error("远端无 JSON 输出: " + (r.stdout || "").slice(0, 200));
  } finally {
    sess.close();
  }
}

function sourceLabel(src) {
  if (src.kind === "ssh") {
    return `SSH:${src.displayName || src.host}`;
  }
  if (src.kind === "wsl") {
    return `WSL:${src.displayName || src.distro || "default"}`;
  }
  if (src.kind === "docker") {
    return `Docker:${src.displayName || src.container}`;
  }
  return src.kind || "remote";
}

module.exports = {
  discoverProfiles,
  loadProfilePassword,
  decryptCredential,
  fetchSnapshot,
  probe,
  sourceLabel,
  ssh2Available: () => !!ssh2(),
};
