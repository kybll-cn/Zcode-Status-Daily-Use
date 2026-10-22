# -*- coding: utf-8 -*-
"""多源快照编排：本地 + 若干远程源，合并成一份快照。

流程：
  1. 本地按当前时刻算出「今天」的绝对时间窗与时区偏移。
  2. 本地快照按这个窗口查。
  3. 每个远程源收到**同一个窗口**，在远端查同样的库，得到同口径的快照。
  4. 合并。

为什么窗口要由本地定、并且原样传给远端：
  - 客户端的用量按各自机器的本地时间分桶。如果各源各按自己的本地日切，
    合并时会出现跨时区错位（东八区的 23:00 和 UTC 的 15:00 是同一时刻）。
  - 定一个绝对窗口给所有源，各源在同一组分桶上求值，合并就是相加。
  - 代价：远端「今天」的口径以本机时区为准。这是刻意的取舍 —— 看板是
    给本机用户看的，按本机的自然日切最符合直觉。

远程源配置（在 config.json 的 remote_sources 里）：
  [
    {"kind": "wsl", "distro": "Ubuntu-24.04", "user": "kybll", "enabled": true},
    {"kind": "ssh", "host": "1.2.3.4", "user": "root", "port": 22},
    {"kind": "docker", "container": "zcode-agent"}
  ]

每个源可选：
  enabled    默认 true，设 false 则跳过
  label      覆盖显示名
  timeout    单次调用超时秒数，默认 20
  python     远端解释器，默认 python3
  home       远端 home（~ 展开的基准）

一个源失败不影响其它源：失败时记一条 error 放进 sources，合并照常进行。
看板要能看到「远端连不上」，而不是整块数据都不显示。
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import zdu
import zdu_aggregate
import zdu_remote

DEFAULT_TIMEOUT = 20


def _remote_sources(cfg: dict) -> list[dict]:
    srcs = cfg.get("remote_sources") or []
    if not isinstance(srcs, list):
        return []
    out = []
    for s in srcs:
        if isinstance(s, dict) and (s.get("enabled") is not False):
            out.append(s)
    return out


def _local_window(cfg: dict) -> dict:
    """本地的「今天」窗口。"""
    now = int(time.time() * 1000)
    time_zone = os.environ.get("TZ") or zdu._system_tz()
    tz = zdu.tz_offset_ms(time_zone, now)
    day_start = zdu.local_day_start_ms(now, tz)
    return {"startMs": day_start, "endMs": now, "tzOffsetMs": tz,
            "timeZone": time_zone}


def collect(cfg: dict | None = None, window: dict | None = None) -> dict:
    """采一份多源合并快照。

    window 传了就用它当时间窗（各源都按这同一个窗口查）；
    不传则按本机当前时间算「今天」。
    """
    cfg = cfg or zdu.load_config()
    if not window:
        window = _local_window(cfg)
    else:
        # 外部窗口可能没带时区名，补上本机的（分桶用的是 tzOffsetMs，
        # 时区名只用于显示）。
        window = dict(window)
        window.setdefault("timeZone", os.environ.get("TZ") or zdu._system_tz())

    snapshots: list[dict] = []
    errors: list[dict] = []

    # ---- 本地 ----
    local_label = cfg.get("local_label") or "本机"
    try:
        local = zdu.daily_snapshot(cfg, window=window)
        if local.get("ok") is False:
            errors.append({"source": local_label, "error": local.get("error")})
        else:
            snapshots.append({"source": local_label, "snapshot": local})
    except Exception as e:
        errors.append({"source": local_label, "error": f"{type(e).__name__}: {e}"})

    # ---- 远程 ----
    for src in _remote_sources(cfg):
        label = src.get("label") or zdu_remote.source_label(src)
        timeout = int(src.get("timeout") or DEFAULT_TIMEOUT)
        try:
            remote = zdu_remote.snapshot(src, timeout=timeout, window=window)
            if remote.get("ok") is False:
                errors.append({"source": label,
                               "error": remote.get("error") or "remote error"})
            else:
                snapshots.append({"source": label, "snapshot": remote})
        except zdu_remote.RemoteError as e:
            errors.append({"source": label, "error": str(e)})
        except Exception as e:
            errors.append({"source": label, "error": f"{type(e).__name__}: {e}"})

    merged = zdu_aggregate.merge(snapshots)
    merged["sources"] = merged.get("sources") or []
    for e in errors:
        merged["sources"].append({"source": e["source"], "ok": False,
                                  "error": e["error"], "totalTokens": 0,
                                  "requests": 0, "totalTurns": 0})
    # 没有任何源成功时才算整体失败。
    if not snapshots:
        merged["ok"] = False
        merged["error"] = errors[0]["error"] if errors else "no data source"
    merged["timeZone"] = window["timeZone"]
    # 渲染层用它区分「本地源」和「远程源」，给不同配色。
    merged["localLabel"] = local_label
    return merged


def serve() -> None:
    """常驻查询服务：stdin 每行一个请求，stdout 每行一个 JSON。

    协议（与 zdu.py 的 serve 一致）：
      - **空行忽略**（心跳/保活不发查询）；
      - 非空行 = 查一次多源快照。若该行是 JSON 且带 window 字段，
        则按该时间窗查（远端执行场景）；
      - JSON 行不带 window 时，等同普通查询。

    主进程（inject-main.cjs）写入的是 "q\\n" —— 不能写空行，
    空行会被这里跳过，主进程就永远等不到结果。

    每次请求都重新采一遍多源（本地 + 远程），因为远程数据随时在变。
    """
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    cfg = zdu.load_config()
    while True:
        line = sys.stdin.readline()
        if not line:
            return
        if not line.strip():
            continue
        window = None
        s = line.strip()
        if s.startswith("{"):
            try:
                req = json.loads(s)
                if isinstance(req, dict) and isinstance(req.get("window"), dict):
                    window = req["window"]
            except Exception:
                window = None
        try:
            out = json.dumps(collect(cfg, window=window), ensure_ascii=True)
        except Exception as e:
            out = json.dumps({"ok": False, "error": str(e)[:300]})
        sys.stdout.write(out + "\n")
        sys.stdout.flush()


def main() -> None:
    argv = sys.argv[1:]
    cfg = zdu.load_config()
    if argv and argv[0] == "serve":
        serve()
        return
    if argv and argv[0] == "json":
        print(json.dumps(collect(cfg), ensure_ascii=True))
        return
    s = collect(cfg)
    if not s.get("ok"):
        print("读取失败: " + str(s.get("error")))
        return
    z = s["summary"]
    L = zdu._load_lang(cfg)
    f = lambda n: zdu.fmt(n, L)
    print(f"■ {L('今日', 'Today')} ({s['range']['date']}  {s['timeZone']})")
    print(f"  合计 {f(z['totalTokens'])}  请求 {z['requests']}  轮 {z['totalTurns']}")
    for src in s.get("sources") or []:
        if src.get("ok") is False:
            print(f"  [{src['source']}] 失败: {src.get('error')}")
        else:
            print(f"  [{src['source']}] {f(src.get('totalTokens'))}  "
                  f"{src.get('requests')} 次")


if __name__ == "__main__":
    main()
