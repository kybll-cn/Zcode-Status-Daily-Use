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

## 4. 本插件的做法

### 时间窗由本机定，原样传给远端

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

### 远端脚本部署到哪

`~/.zcode/zcode-status-daily-use/zdu.py`（与客户端自己的目录同族，不污染 home）。
部署用 base64 + stdin 管道，见 `zdu_remote.deploy()`。

### 合并口径

见 `zdu_aggregate.merge()` 的文档字符串。要点：

- `summary` 逐字段相加，但 `cacheHitRate` 按合并后的分子分母**重算**；
- `activeHours` 按合并后的 24 个桶重算（各源相加会重复计同一时段）；
- 模型 `share` 在合并后的模型集合上重算；
- **刻意不跨源去重 session** —— 不同机器不可能有同一个 session_id，
  唯一的重复来源是「同一台机器被配了两次」，那是配置错误，要暴露而不是静默吸收。
  同源内的重复 sid 才会去重。

---

## 5. 本机现状（2026-10-22 实测）

WSL 里装了完整的 ZCode server 3.16.2 linux-x64：

```
~/.zcode/server/current.json   → version 3.16.2, target linux-x64
~/.zcode/server/releases/3.16.2-linux-x64-947eb91d3dd7/runtime/
    zcode.cjs       (15243891 B，与桌面端同版本)
    server-cli.js   ( 1613272 B)
    node            (121509208 B，自带 node 运行时)
~/.zcode/server/run/status.json → state "ready", port 35369, host 127.0.0.1
```

但 `~/.zcode/cli/` **还不存在** —— 远程 agent 还没跑过会话，
远端用量库（`~/.zcode/cli/db/db.sqlite`）也就还没建出来。
等真正在 WSL 里跑第一个会话，它才会出现。

---

## 6. 复现这些结论的命令

```bash
# 客户端 agent 打包代码（15MB 单行压缩，用 Python 正则搜更靠谱）
RES=~/.zcode/server/releases/*/runtime/zcode.cjs
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
```
