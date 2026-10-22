# -*- coding: utf-8 -*-
"""远程源抽象：把 zdu.py 部署到远端并取回快照。

设计约束（与客户端的机制对齐，见 docs/remote-notes.md）：
  - 客户端的用量由「发起模型请求的那个进程」写入自己持有的 db。远程 agent 在远端
    跑，用量就落在远端的 ~/.zcode/cli/db/db.sqlite。本地 db 里永远没有远程那段。
  - 远端 db 路径由远端 agent 的 resolveAgentSessionDbPath 决定：
      ZCODE_SESSION_DB_PATH 环境变量 → ~/.zcode/cli/config.json 的
      storage.sessionDbPath → 默认 ~/.zcode/cli/db/db.sqlite
    所以本模块在远端也用同样的优先级去找库，而不是硬编码路径。
  - 客户端的 getAppUsageStats 只查活动 workspace 那一个 client，没有跨 workspace
    聚合，也没有把远程用量回传本地。所以合并必须由本插件自己做。

远端通道有三种，接口一致：
    {"kind": "wsl",    "distro": "...", "user": "..."}
    {"kind": "ssh",    "host": "...", "user": "...", "port": 22}
    {"kind": "docker", "container": "..."}

每个通道都做两件事：把 zdu.py 送到远端临时目录，执行 `python3 zdu.py json`，
把 stdout 的 JSON 拿回来。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ZDU = HERE / "zdu.py"

# 远端部署目录：放在 ~/.zcode 下，与客户端自己的目录同族，不污染用户 home。
REMOTE_DIR = ".zcode/zcode-status-daily-use"

# 单次远程调用的超时上限（秒）。远端是跨进程 + 可能跨网络，给得比本地宽松。
DEFAULT_TIMEOUT = 20


class RemoteError(Exception):
    """远程源取数失败。调用方负责降级，不让一个源挂掉整个看板。"""


# ---------------------------------------------------------------- 通道实现

def _run(cmd: list[str], timeout: int, cwd: str | None = None,
         stdin: bytes | None = None) -> str:
    """执行命令并返回 stdout。失败时抛 RemoteError，stderr 带进消息里便于排障。

    stdin 传 bytes 时走管道（远端用 `sh -s` 读脚本）。
    """
    try:
        p = subprocess.run(
            cmd,
            input=stdin if stdin is not None else b"",
            capture_output=True,
            timeout=timeout,
            cwd=cwd,
        )
    except FileNotFoundError as e:
        raise RemoteError(f"{cmd[0]} not found: {e}") from e
    except subprocess.TimeoutExpired as e:
        raise RemoteError(f"timeout after {timeout}s: {' '.join(cmd[:3])}") from e
    except Exception as e:
        raise RemoteError(f"{type(e).__name__}: {e}") from e

    if p.returncode != 0:
        err = (p.stderr or b"").decode("utf-8", "replace").strip()
        raise RemoteError(f"exit {p.returncode}: {err[:300] or '(no stderr)'}")
    return (p.stdout or b"").decode("utf-8", "replace")


def _wsl_prefix(src: dict) -> list[str]:
    """wsl.exe 前缀。"""
    cmd = ["wsl.exe"]
    distro = (src.get("distro") or "").strip()
    if distro:
        cmd += ["-d", distro]
    user = (src.get("user") or "").strip()
    if user:
        cmd += ["-u", user]
    cmd += ["--"]
    return cmd


def _ssh_prefix(src: dict) -> list[str]:
    cmd = ["ssh"]
    port = src.get("port")
    if port:
        cmd += ["-p", str(port)]
    host = (src.get("host") or "").strip()
    user = (src.get("user") or "").strip()
    cmd.append(f"{user}@{host}" if user else host)
    # BatchMode：没有免密就直接失败，不要卡在密码提示上等用户。
    cmd += ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
    cmd += ["--"]
    return cmd


def _docker_prefix(src: dict) -> list[str]:
    return ["docker", "exec", "-i", (src.get("container") or "").strip()]


def _prefix(src: dict) -> list[str]:
    kind = (src.get("kind") or "").strip().lower()
    if kind == "wsl":
        return _wsl_prefix(src)
    if kind == "ssh":
        return _ssh_prefix(src)
    if kind == "docker":
        return _docker_prefix(src)
    raise RemoteError(f"unknown remote kind: {kind!r}")


def _sh(src: dict) -> list[str]:
    """在远端跑一段 shell 脚本的完整命令：前缀 + `sh -s`（从 stdin 读）。

    脚本一律走 stdin 管道，不进命令行参数 —— 这样不论脚本里有多少引号、
    反斜杠、换行，都不会被任何一层 shell 二次解析。
    这是踩过的坑：早先版本把脚本塞进 `sh -lc '<script>'`，内层单引号与外层
    单引号打架，远端报 exit 127（命令找不到），错误信息还带着半截被截断的
    命令，完全看不出真正原因。
    """
    return _prefix(src) + ["sh", "-s"]


def _remote_python(src: dict) -> str:
    """远端解释器。python3 是绝大多数 Linux 的标准命令名。"""
    return (src.get("python") or "python3").strip()


def _remote_dir_sh(src: dict) -> str:
    """远端部署目录的 **shell 片段**（已含引号）。

    用 "$HOME/..." 而不是 "~"：`~` 只在词首才展开，且在单引号里不展开 ——
    早先版本用 '~/...' 单引号包路径，远端把 ~ 当普通字符，拼成了相对路径，
    报 "can't open file '/mnt/d/.../~/.zcode/...'"。
    "$HOME" 在双引号里一定会展开，且与当前工作目录无关。
    """
    home = (src.get("home") or "").strip()
    if home:
        if not home.startswith("/"):
            raise RemoteError(f"remote home must be absolute: {home!r}")
        return "'" + home.replace("'", "'\\''") + "/" + REMOTE_DIR + "'"
    return '"$HOME/' + REMOTE_DIR + '"'


def _remote_script(src: dict) -> str:
    """远端 zdu.py 的路径（shell 片段形式，同 _remote_dir_sh）。"""
    return _remote_dir_sh(src) + "/zdu.py"


# ---------------------------------------------------------------- 部署

def _script_bytes() -> bytes:
    return ZDU.read_bytes()


def _script_sha() -> str:
    """本地 zdu.py 的内容哈希。用来判断远端是否已是这份。"""
    import hashlib
    return hashlib.sha256(_script_bytes()).hexdigest()


def _remote_sha(src: dict, timeout: int = DEFAULT_TIMEOUT) -> str | None:
    """远端已部署脚本的哈希。取不到返回 None（视为需要重新部署）。"""
    py = _remote_python(src)
    dir_sh = _remote_dir_sh(src)
    dst_sh = dir_sh + "/zdu.py"
    script = (
        "if [ -f " + dst_sh + " ]; then "
        f"{py} -c \"import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())\" "
        + dst_sh + "; fi\n"
    )
    try:
        out = _run(_sh(src), timeout, stdin=script.encode("utf-8"))
    except RemoteError:
        return None
    for ln in out.splitlines():
        ln = ln.strip()
        if len(ln) == 64 and all(c in "0123456789abcdef" for c in ln):
            return ln
    return None


def deploy(src: dict, timeout: int = DEFAULT_TIMEOUT, force: bool = False) -> str:
    """把 zdu.py 送到远端。

    传输方式：把脚本内容用 base64 编成纯 ASCII，嵌进一段 shell 脚本，
    整段脚本经 stdin 管道送到远端 `sh -s`。远端解码后原子替换。

    为什么 base64：zdu.py 是文本文件，但里面可能有引号、反斜杠、$ 等
    在 shell 里有特殊含义的字符。base64 之后全是 [A-Za-z0-9+/=]，
    塞进 shell 字符串绝对安全。

    幂等：先比对远端脚本的 sha256，一致就跳过传输。取数是每几秒一次，
    每次都重传 20KB 纯浪费 —— 远端脚本只在本地改动后才需要更新。

    返回远端脚本路径（shell 片段形式）。
    """
    import base64

    want = _script_sha()
    if not force:
        try:
            got = _remote_sha(src, timeout)
            if got and got == want:
                return _remote_dir_sh(src) + "/zdu.py"
        except Exception:
            pass    # 比对失败就照常部署

    payload = base64.b64encode(_script_bytes()).decode("ascii")
    dir_sh = _remote_dir_sh(src)
    dst_sh = dir_sh + "/zdu.py"
    py = _remote_python(src)

    # base64 可能很长；sh -s 走 stdin 没有命令行长度限制，但仍分块写文件，
    # 避免单行过长（部分 sh 的行缓冲有限制）。
    chunk = 12000
    parts = [payload[i:i + chunk] for i in range(0, len(payload), chunk)] or [""]

    sh = _sh(src)
    body = ["set -e", f"mkdir -p {dir_sh}", f"tmp={dir_sh}/zdu.py.b64tmp"]
    for i, part in enumerate(parts):
        op = ">" if i == 0 else ">>"
        body.append(f"printf '%s' '{part}' {op} \"$tmp\"")
    body.append(
        f"if command -v base64 >/dev/null 2>&1; then "
        f"base64 -d \"$tmp\" > {dir_sh}/zdu.py.new; "
        f"else {py} -c \"import base64,sys;open(sys.argv[1],'wb').write("
        f"base64.b64decode(open(sys.argv[2],'rb').read()))\" {dir_sh}/zdu.py.new \"$tmp\"; fi"
    )
    body.append(f"mv {dir_sh}/zdu.py.new {dst_sh}")
    body.append(f"rm -f \"$tmp\"")
    body.append(f"chmod +x {dst_sh}")
    body.append("echo OK")

    script = "\n".join(body) + "\n"
    out = _run(sh, timeout, stdin=script.encode("utf-8"))
    if "OK" not in out:
        raise RemoteError(f"deploy did not confirm: {out[:200]!r}")
    return dst_sh


def fetch(src: dict, timeout: int = DEFAULT_TIMEOUT, window: dict | None = None) -> dict:
    """在远端执行 zdu.py json 并解析回快照。

    window 传了就原样交给远端（--window <json>），远端按同一时间窗查。
    """
    dir_sh = _remote_dir_sh(src)
    dst_sh = dir_sh + "/zdu.py"
    py = _remote_python(src)

    if window:
        # 窗口 JSON 里只保留三个数值字段，避免把本机时区名之类的东西带过去。
        w = {"startMs": int(window["startMs"]),
             "endMs": int(window["endMs"]),
             "tzOffsetMs": int(window["tzOffsetMs"])}
        wjson = json.dumps(w).replace("'", "'\\''")
        arg = f"--window '{wjson}'"
    else:
        arg = ""

    script = (
        "set -e\n"
        f"cd {dir_sh}\n"
        f"{py} {dst_sh} json {arg}\n"
    )
    out = _run(_sh(src), timeout, stdin=script.encode("utf-8"))
    line = ""
    for ln in out.splitlines():
        ln = ln.strip()
        if ln.startswith("{"):
            line = ln
            break
    if not line:
        raise RemoteError(f"no JSON in remote output: {out[:200]!r}")
    try:
        return json.loads(line)
    except Exception as e:
        raise RemoteError(f"bad JSON from remote: {e}") from e


def probe(src: dict, timeout: int = DEFAULT_TIMEOUT) -> dict:
    """探测远端是否可用（不部署脚本）。

    返回 {"ok": bool, "dbPath": str|None, "error": str|None}。
    """
    py = _remote_python(src)
    # 远端有没有 python3、有没有 db、db 路径在哪 —— 与客户端同口径的解析顺序。
    # 这段 Python 源码用 heredoc 送进远端 shell，避免任何引号转义问题。
    probe_py = (
        "import os,json\n"
        "p=os.environ.get('ZCODE_SESSION_DB_PATH') or os.environ.get('ZCODE_SESSION_DB')\n"
        "cfg=os.path.expanduser('~/.zcode/cli/config.json')\n"
        "if not p and os.path.exists(cfg):\n"
        "    try:\n"
        "        p=(json.load(open(cfg)).get('storage') or {}).get('sessionDbPath')\n"
        "    except Exception:\n"
        "        p=None\n"
        "p=os.path.expanduser(p) if p else os.path.expanduser('~/.zcode/cli/db/db.sqlite')\n"
        "print(json.dumps({'db':p,'exists':os.path.exists(p)}))\n"
    )
    script = f"{py} - <<'PYEOF'\n{probe_py}PYEOF\n"
    try:
        out = _run(_sh(src), timeout, stdin=script.encode("utf-8"))
    except RemoteError as e:
        return {"ok": False, "dbPath": None, "error": str(e)}
    for ln in out.splitlines():
        ln = ln.strip()
        if ln.startswith("{"):
            try:
                d = json.loads(ln)
                return {"ok": True, "dbPath": d.get("db"), "error": None}
            except Exception:
                pass
    return {"ok": False, "dbPath": None, "error": f"unexpected probe output: {out[:200]!r}"}


def snapshot(src: dict, timeout: int = DEFAULT_TIMEOUT, window: dict | None = None) -> dict:
    """完整取一份远端快照：部署 + 执行。失败抛 RemoteError。"""
    deploy(src, timeout)
    return fetch(src, timeout, window=window)


def source_label(src: dict) -> str:
    """给 UI 用的来源名。"""
    kind = (src.get("kind") or "").lower()
    if kind == "wsl":
        d = (src.get("distro") or "default").strip()
        u = (src.get("user") or "").strip()
        return f"WSL:{d}" + (f"@{u}" if u else "")
    if kind == "ssh":
        u = (src.get("user") or "").strip()
        h = (src.get("host") or "").strip()
        return f"SSH:{u + '@' if u else ''}{h}"
    if kind == "docker":
        return f"Docker:{(src.get('container') or '').strip()}"
    return kind or "remote"
