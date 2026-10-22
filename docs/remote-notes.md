# 客户端的远程链路（实测结论）

> 这份文档记录的是**从 app.asar 与 zcode.cjs 里读出来的代码事实**，不是推测。
> 每条结论后面都附了代码片段，位置可以用 grep 复现。

## 一句话结论

**客户端不会把远程任务的用量汇总到本机。** 插件要显示「今天在远程机上用了多少」，
只能自己跨机取数再合并 —— 这就是 v1.2.0 加 `zdu_remote.py` 的原因。

---

## 1. 有哪些远程形态

`out/host/index.js` 里，远程连接档案（connection profile）的 target 有四种：

```js
h.object({kind:h.literal("wsl"), distro:Rn.optional(), user:Rn.optional()}).strict(),
h.object({kind:h.literal("docker"), container:Rn}).strict(),
h.object({kind:h.literal("server"), url:h.url(), name:Rn.optional(), ...}).strict(),
// 以及 kind:"ssh"（host / port / username / privateKeyPath …）
```

遥测里对应的枚举是：

```js
workspace_kind:["local","remote"], remote_kind:["","ssh","wsl","docker","server"]
```

连接标识：

```js
function Gte(e){
  switch(e.kind){
    case"ssh":   return `ssh:${NB(e)}`;
    case"wsl":   return `wsl:${Kte(e.distro)}\0${Kte(e.user)}`;
    case"docker":return `docker:${e.container.trim()}`;
    case"server":return `server:${e.serverId?.trim()||Ije(e.url)}`;
  }
}
```

远程 workspace 通过 RPC 帧协议（`rpc-frame`，带 `bridgeSessionId`）与桌面端通信，
帧封装在 `out/host/index.js` 的 `relayEnvelopeFor` / `measureWebRemoteControl…` 一带。

---

## 2. 用量数据落在哪台机器

**关键事实：用量由发起模型请求的那个进程写进它自己持有的 db。**

写入点在 `resources/glm/zcode.cjs`：

```js
async function YNr(e,t){ … e.prepare(`insert into model_usage (id, … ) values (?, …)`) … }
```

它挂在 session store 上：

```js
async recordModelUsage(t){ return YNr(this.db, t) }
```

调用方是运行时：

```js
async function _I(e,t){ … await n.recordModelUsage({ … }) … }   // n = sessionStore
```

远程 agent 在远端跑模型请求 → 它的 sessionStore 指向远端的库 →
**用量落在远端，本机 db 里没有**。

### 远端库路径怎么定

客户端在 `out/host/index.js` 与 `zcode.cjs` 里都有同一套解析（`resolveAgentSessionDbPath`）：

```js
var DEFAULT_SESSION_DB_PATH = "~/.zcode/cli/db/db.sqlite";

async function resolveAgentSessionDbPath(options2 = {}) {
  const env = options2.env ?? process.env;
  const home = options2.homedirPath ?? homedir2();
  const fromEnv = pickEnvSessionDbPath(env);      // ZCODE_SESSION_DB_PATH / ZCODE_SESSION_DB
  if (fromEnv) return resolveMirroredSessionDbPath(fromEnv, home);
  const userConfigPath = options2.userConfigPath ?? join13(home, ".zcode", "cli", "config.json");
  … const configured = parsed.storage?.sessionDbPath?.trim(); …
  return resolveMirroredSessionDbPath(DEFAULT_SESSION_DB_PATH, home);
}
```

优先级：

1. `ZCODE_SESSION_DB_PATH`（或 `ZCODE_SESSION_DB`）环境变量
2. `~/.zcode/cli/config.json` 的 `storage.sessionDbPath`
3. 默认 `~/.zcode/cli/db/db.sqlite`

本插件的 `zdu_remote.probe()` **用完全相同的顺序**在远端找库，
而不是硬编码路径 —— 否则用户改了 `storage.sessionDbPath` 就读不到。

`resolveMirroredSessionDbPath` 还说明了 `~` 的展开规则：

```js
function resolveMirroredSessionDbPath(path2, home) {
  if (path2.startsWith("~/")) return join13(home, path2.slice(2));
  if (isAbsolute3(path2)) return path2;
  return null;      // 相对路径无法镜像 → 返回 null（不猜）
}
```

---

## 3. 为什么客户端自己汇不出来

桌面的用量服务走的是 `zcodeAgentService.getAppUsageStats`（`out/host/index.js`）：

```js
async getAppUsageStats(y){
  let M = lt.values().next().value;          // ← 只取活动 workspace 那一个 client
  if(!M) throw new Error("no_active_workspace");
  return M.client.request(Nt.usageStats, {range:y.range, timeZone:y.timeZone}, PH);
}
```

`usage/stats` 的 handler（`zcode.cjs`）直接查**当前进程**的 session store：

```js
function tBn(e,t){
  …
  const h = e.deps.sessionStore;                       // ← 本进程的 store
  if(!h?.queryAppUsage) return m6n({…空…}, f);
  const _ = await h.queryAppUsage({since:u, until:i, tzOffsetMs:a});
  return m6n(_, f);
}
```

两处合起来说明：

- 只有一个活动 workspace 的数据，**没有跨 workspace 聚合**；
- handler 查的是**本进程**的库，**没有把远程用量回传本地**。

> 另有一条 `v4/usage/stats` 走 ZCode 云端 gateway（`requireV4Gateway()`），
> 但那是**云端托管会话**的通道，与本地 db 的用量统计是两条路，
> 桌面端的原生用量页用的仍是本地那一条。

---

## 4. 插件怎么绕过这些限制

### 4.1 时间窗由本机定，原样传给远端

各源如果各按自己的本地日切分，合并时会跨时区错位
（东八区 23:00 与 UTC 15:00 是同一时刻）。
所以本插件先在本地算出「今天」的**绝对时间窗**与时区偏移，
把这个窗连同同一个 `tzOffsetMs` 交给远端去查：

```python
window = {"startMs": …, "endMs": …, "tzOffsetMs": …}
```

远端按完全相同的口径分桶返回，本地只需逐项相加。
代价是「今天」以**本机时区**为准 —— 这是刻意的取舍：
看板是给本机用户看的，按本机的自然日切最符合直觉。

### 4.2 借客户端的 ssh2 与凭证（v1.3.0）

v1.2.0 用系统 `ssh.exe` + `BatchMode=yes`，**连不上用密码认证的服务器**。
v1.3.0 改成用客户端自己的东西：

**（1）ssh2 库就在 asar 里**，客户端的 `SSHBackend` 用的就是它：

```js
// out/host/chunk-D4ZBCI2G.js
import{Client as oe}from"ssh2"
```

`app.asar` 的 `node_modules/ssh2/lib/client.js` 有 64 KB。
**普通 Node 的 `require` 不认 asar，但 Electron 的 fs 层认** ——
插件跑在主进程，正好能用。裸模块名 `ssh2` 解析不到（插件目录在 `~/.zcode/` 下，
Node 向上找 `node_modules` 找不到 asar 内部），
要用绝对路径，并从 `process.execPath` 反推：

```js
path.join(path.dirname(process.execPath), "resources", "app.asar",
          "node_modules", "ssh2")
```

**（2）凭证能自己解。** 客户端把密码存在 `~/.zcode/v2/credentials.json`，
格式与密钥推导在 `out/host/index.js` 的 `createCredentialCipherProvider`：

```js
_A="enc:v1:", nK="aes-256-gcm", oK=12, jpe=16, Zpe="ZCODE_CREDENTIAL_SECRET"
deriveCipherKey = sha256(secret)
defaultCredentialSecret = `zcode-credential-fallback:${platform}:${homedir}:${username}`
格式 = "enc:v1:" + b64url(nonce) + "." + b64url(tag) + "." + b64url(ciphertext)
```

三个容易踩的点：

- **格式是三段，用 `.` 分隔**，不是一整串 base64（base64url 不含 `.`）；
- 密钥优先取环境变量 `ZCODE_CREDENTIAL_SECRET`，没有才回退；
- **`platform` 要用 Node 的 `process.platform`（`win32`），
  不是 Python 的 `platform.system()`（`Windows`）** —— 我在这上面栽过，
  用 Python 解不开，换成 Node 立刻就通了。
- AES-GCM 别指望 `openssl enc`（它不支持 GCM）；用 Node 的 `node:crypto`。

**（3）连接档案从 `~/.zcode/v2/setting.json` 读**：

```js
{"connectionProfiles":[
  {"profileId":"…","transport":"ssh","lifecycleState":"active",
   "target":{"kind":"ssh","host":"…","port":…,"username":"…",
             "passwordCredentialKey":"connection-profile:<id>:password"}},
  {"transport":"wsl","target":{"kind":"wsl","distro":"Ubuntu-24.04","user":"kybll"}}
]}
```

只认 `lifecycleState` 不是 `retired` 的（退役档案连上去会失败）。

### 4.3 远程通道在主进程，Python 只管本地

主进程能拿 ssh2 与凭证，所以**远程取数全在主进程**（`zdu_remote_main.cjs`）；
Python 只做本地查询与合并。主进程把各远程快照连同时间窗一起发给 Python：

```json
{"window": {"startMs":…,"endMs":…,"tzOffsetMs":…},
 "remote": [{"source":"SSH:1.2.3.4","snapshot":{…}}, …]}
```

**两边都取会把同一个源算两遍** —— 我确实撞上过：主进程自动发现的 WSL 与
Python 侧自己取的那个同名，合计里出现两个 WSL。现在主进程给了 `remote`，
Python 就不自己取；合并层还有一道同名源去重。

### 4.4 性能：连接复用 + 命令合并

一次取数要跑好几条远端命令（探 home、查 sha256、传脚本、跑取数）。
每条命令重连一次的话，跨境网络下要 11.8 秒。
改成**一条 SSH 连接跑完全流程** + **探 home 与查 sha256 合并成一条命令**，
降到 3.4 秒。

### 4.5 远端脚本部署到哪

`~/.zcode/zcode-status-daily-use/zdu.py`（与客户端自己的目录同族，不污染 home）。
部署用 base64 + stdin 管道，比对 sha256 幂等。

### 4.6 合并口径

见 `zdu_aggregate.merge()` 的文档字符串。要点：

- `summary` 逐字段相加，但 `cacheHitRate` 按合并后的分子分母**重算**；
- `activeHours` 按合并后的 24 个桶重算（各源相加会重复计同一时段）；
- 模型 `share` 在合并后的模型集合上重算；
- **同名源去重**（防同一台机器被算两遍）；
- **刻意不跨源去重 session** —— 不同机器不可能有同一个 session_id，
  唯一的重复来源是「同一台机器被配了两次」，那是配置错误，要暴露而不是静默吸收。
  同源内的重复 sid 才会去重。

---

## 5. 本机现状（2026-10-22 实测）

**SSH 远端**（`156.254.7.57:49070`，root，密码认证）—— 客户端里配着且状态可用：

```
客户端 setting.json 的 connectionProfiles:
  {transport:"ssh", target:{kind:"ssh", host:"156.254.7.57", port:49070,
                            username:"root",
                            passwordCredentialKey:"connection-profile:11f5…:password"},
   lifecycleState:"active"}
远端实测：主机 NB472247111 / x86_64 / Python 3.12.3
          ~/.zcode/cli/db/db.sqlite 已存在（agent 跑过会话，有真实用量）
```

**WSL**（Ubuntu-24.04）—— 装了完整的 ZCode server 3.16.2 linux-x64：

```
~/.zcode/server/current.json   → version 3.16.2, target linux-x64
~/.zcode/server/releases/3.16.2-linux-x64-947eb91d3dd7/runtime/
    zcode.cjs       (15243891 B，与桌面端同版本)
    server-cli.js   ( 1613272 B)
    node            (121509208 B，自带 node 运行时)
~/.zcode/server/run/status.json → state "ready", port 35369, host 127.0.0.1
```

实测时 WSL 里的 `~/.zcode/cli/` 还不存在（远程 agent 没跑过会话），
所以那个源最初显示「不可用」。测试时往那里种了一份与真实同构的库
（`tests/seed_wsl_db.py`），等真的在 WSL 里跑会话，会被真实数据覆盖。

---

## 6. 复现这些结论的命令

```bash
# 客户端 agent 打包代码（15MB 单行压缩，用 Python 正则搜更靠谱）
python3 - <<'EOF'
import re,glob
src=open(glob.glob('/home/kybll/.zcode/server/releases/*/runtime/zcode.cjs')[0],
         encoding='utf-8',errors='replace').read()
for pat in [r'insert\s+into\s+model_usage', r'recordModelUsage',
            r'resolveAgentSessionDbPath', r'usage/stats']:
    print(pat, [m.start() for m in re.finditer(pat,src)][:5])
EOF

# 桌面端 asar 里的 host 进程（用量服务在这）
python3 - <<'EOF'
import json,struct
p='/mnt/c/Users/kybll/AppData/Local/Programs/ZCode/resources/app.asar'
f=open(p,'rb'); h=f.read(16); n=struct.unpack('<IIII',h)[3]
idx=json.loads(f.read(n).decode()); base=16+n
node=idx['files']['out']['files']['host']['files']['index.js']
f.seek(base+int(node['offset']))
src=f.read(int(node['size'])).decode('utf-8','replace')
i=src.find('getAppUsageStats')
print(src[i-100:i+400])
EOF

# ssh2 在 asar 里（我的 walk 曾漏掉 lib/ 子目录，误判成"没有源码"）
python3 - <<'EOF'
import json,struct
p='/mnt/c/Users/kybll/AppData/Local/Programs/ZCode/resources/app.asar'
f=open(p,'rb'); h=f.read(16); n=struct.unpack('<IIII',h)[3]
idx=json.loads(f.read(n).decode())
lib=idx['files']['node_modules']['files']['ssh2']['files']['lib']['files']
print({k:v['size'] for k,v in lib.items()})
EOF
```

插件的三个测试（都要用 Electron 跑，因为要 require asar 里的 ssh2）：

```bash
ZCODE=<ZCode.exe 路径>
# 远程通道：ssh2 可用性、凭证解密、自动发现、逐个取数
ELECTRON_RUN_AS_NODE=1 "$ZCODE" tests/remote_main_test.js
# 端到端：主进程取远程 → 按协议发给 Python → 验证合并
ELECTRON_RUN_AS_NODE=1 "$ZCODE" tests/e2e_merge_test.js
# 部署产物：用安装目录里的实际文件跑完整链路
ELECTRON_RUN_AS_NODE=1 "$ZCODE" tests/deployed_check.js
```
