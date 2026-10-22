# -*- coding: utf-8 -*-
"""远程（多源）用量的回归测试。

覆盖三件事：
  1. 合并口径 —— 逐字段相加、比率重算、活跃时段不重复计。
  2. 远端通道 —— 真实连 WSL，取回数字与本地一致。
  3. 窗口对齐 —— 各源按同一绝对时间窗查询，合并的 hourly 桶一一对应。

跑法：python tests/remote_test.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import zdu
import zdu_aggregate
import zdu_multi
import zdu_remote

FAILED: list[str] = []

def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILED.append(name)


def mk_snapshot(source: str, total: int, reqs: int, hours: dict[int, int],
                models: dict[str, int], sessions: list[dict] | None = None,
                tools: dict[str, tuple[int, int]] | None = None) -> dict:
    """造一份与生产同构的快照。"""
    hourly = []
    for h in range(24):
        t = hours.get(h, 0)
        hourly.append({
            "hour": h, "totalTokens": t, "inputTokens": t, "outputTokens": 0,
            "cacheReadTokens": 0, "requests": 1 if t else 0,
            "models": [{"modelId": m, "totalTokens": v} for m, v in models.items()]
            if t else [],
        })
    mlist = []
    msum = sum(models.values()) or 1
    for m, v in models.items():
        mlist.append({"modelId": m, "totalTokens": v, "inputTokens": v,
                      "outputTokens": 0, "requestCount": 1,
                      "share": v / msum})
    return {
        "ok": True, "error": None, "generatedAt": int(time.time() * 1000),
        "timeZone": "Asia/Shanghai",
        "range": {"startMs": 0, "endMs": 0, "date": "2026-10-22", "startHour": 0},
        "summary": {
            "requests": reqs, "totalTokens": total, "inputTokens": total,
            "outputTokens": 0, "reasoningTokens": 0, "cacheCreationTokens": 0,
            "cacheReadTokens": 0, "cacheFreshTokens": total,
            "cacheHitRate": 0.0, "modelErrors": 0, "retries": 0,
            "totalTurns": reqs, "totalSessions": 1, "activeMs": 0,
            "mainRequests": reqs, "subRequests": 0, "mainTokens": total,
            "subTokens": 0, "toolCalls": 0, "toolErrors": 0,
            "firstAt": 1, "lastAt": 2, "activeHours": len(hours),
        },
        "hourly": hourly,
        "models": mlist,
        "sessions": sessions or [],
        "tools": [{"toolName": k, "callCount": v[0], "errorCount": v[1]}
                  for k, v in (tools or {}).items()],
    }


# ---------------------------------------------------------------- 1. 合并口径

print("=== 1. 合并口径 ===")

a = mk_snapshot("本机", 1000, 10, {1: 500, 2: 500}, {"m1": 1000})
b = mk_snapshot("远端", 2000, 20, {1: 1000, 5: 1000}, {"m1": 1000, "m2": 1000})
m = zdu_aggregate.merge([{"source": "本机", "snapshot": a},
                         {"source": "远端", "snapshot": b}])

check("summary.totalTokens 相加", m["summary"]["totalTokens"] == 3000,
      f"got {m['summary']['totalTokens']}")
check("summary.requests 相加", m["summary"]["requests"] == 30,
      f"got {m['summary']['requests']}")
check("hourly 同桶相加",
      m["hourly"][1]["totalTokens"] == 1500 and m["hourly"][2]["totalTokens"] == 500
      and m["hourly"][5]["totalTokens"] == 1000,
      f"h1={m['hourly'][1]['totalTokens']} h2={m['hourly'][2]['totalTokens']} "
      f"h5={m['hourly'][5]['totalTokens']}")
check("activeHours 按合并后桶重算（不是相加）",
      m["summary"]["activeHours"] == 3,
      f"got {m['summary']['activeHours']}（相加会得 4）")
check("models 按 modelId 合并",
      {x["modelId"]: x["totalTokens"] for x in m["models"]} ==
      {"m1": 2000, "m2": 1000},
      str([(x["modelId"], x["totalTokens"]) for x in m["models"]]))
check("模型 share 重算",
      abs(m["models"][0]["share"] - 2000 / 3000) < 1e-9,
      f"got {m['models'][0]['share']}")
check("hourly 桶内 models 分层合并",
      {x["modelId"]: x["totalTokens"] for x in m["hourly"][1]["models"]} ==
      {"m1": 2000, "m2": 1000},
      str(m["hourly"][1]["models"]))
check("sources 列出每个来源",
      len(m["sources"]) == 2 and m["sources"][0]["source"] == "本机",
      str(m["sources"]))

# 缓存命中率必须按合并后的分子分母重算，不能相加
a2 = mk_snapshot("A", 1000, 10, {1: 1000}, {"m1": 1000})
b2 = mk_snapshot("B", 1000, 10, {1: 1000}, {"m1": 1000})
a2["summary"]["inputTokens"] = 1000
a2["summary"]["cacheReadTokens"] = 100
a2["summary"]["cacheHitRate"] = 0.1
b2["summary"]["inputTokens"] = 1000
b2["summary"]["cacheReadTokens"] = 900
b2["summary"]["cacheHitRate"] = 0.9
m2 = zdu_aggregate.merge([{"source": "A", "snapshot": a2},
                          {"source": "B", "snapshot": b2}])
check("cacheHitRate 按合并后重算（不相加）",
      abs(m2["summary"]["cacheHitRate"] - 1000 / 2000) < 1e-9,
      f"got {m2['summary']['cacheHitRate']}（相加会得 1.0）")

# 会话：不同源不冲突；同源重复 sid 要去重
s1 = [{"sid": "s1", "title": "甲", "directory": "/a", "requests": 1,
       "totalTokens": 100, "lastAt": 1, "isSub": False}]
s2 = [{"sid": "s1", "title": "乙", "directory": "/b", "requests": 2,
       "totalTokens": 200, "lastAt": 2, "isSub": False}]
c1 = mk_snapshot("A", 100, 1, {1: 100}, {"m1": 100}, sessions=s1)
c2 = mk_snapshot("B", 200, 2, {1: 200}, {"m1": 200}, sessions=s2)
m3 = zdu_aggregate.merge([{"source": "A", "snapshot": c1},
                          {"source": "B", "snapshot": c2}])
check("不同源的同名 session 都保留",
      len(m3["sessions"]) == 2, f"got {len(m3['sessions'])}")
c3 = mk_snapshot("A", 300, 3, {1: 300}, {"m1": 300}, sessions=s1 + s1)
m4 = zdu_aggregate.merge([{"source": "A", "snapshot": c3}])
check("同源重复 session 去重", len(m4["sessions"]) == 1,
      f"got {len(m4['sessions'])}")

# 失败源不参与合并，但要在 sources 里体现
bad = mk_snapshot("坏源", 999, 99, {1: 999}, {"m1": 999})
bad["ok"] = False
bad["error"] = "连不上"
m5 = zdu_aggregate.merge([{"source": "本机", "snapshot": a},
                          {"source": "坏源", "snapshot": bad}])
check("失败的源不计入合计",
      m5["summary"]["totalTokens"] == 1000,
      f"got {m5['summary']['totalTokens']}")

# ---------------------------------------------------------------- 2. 远端通道

print("\n=== 2. 远端通道（真实 WSL） ===")
SRC = {"kind": "wsl", "distro": "Ubuntu-24.04", "user": "kybll",
       "label": "WSL:Ubuntu-24.04", "timeout": 40}

try:
    pr = zdu_remote.probe(SRC, timeout=40)
    check("远端可连接", pr.get("ok") is True, str(pr))
except Exception as e:
    check("远端可连接", False, f"{type(e).__name__}: {e}")

# 远端还没有用量库时（还没在 WSL 里跑过会话），先种一份已知数据，
# 这样后面的断言有确定的期望值。已存在则跳过。
try:
    rs_probe = zdu_remote.probe(SRC, timeout=40)
    db_exists = rs_probe.get("dbPath")
    if db_exists:
        import subprocess as _sp
        chk = _sp.run(
            ["wsl.exe", "-d", "Ubuntu-24.04", "-u", "kybll", "--",
             "sh", "-lc", f'test -f "{db_exists}" && echo yes || echo no'],
            capture_output=True, text=True, timeout=30)
        have = "yes" in (chk.stdout or "")
    else:
        have = False
    if not have:
        print("  （远端还没有用量库，先种一份测试数据）")
        from seed_wsl_db import seed_wsl
        print("   ", seed_wsl())
        check("远端测试数据已种下", True)
    else:
        print("  （远端已有库，直接用）")
except Exception as e:
    check("远端测试数据就绪", False, f"{type(e).__name__}: {e}")

try:
    dst = zdu_remote.deploy(SRC, timeout=40)
    check("远端部署成功", bool(dst), str(dst))
except Exception as e:
    check("远端部署成功", False, f"{type(e).__name__}: {e}")

# 幂等：第二次 deploy 应该跳过传输
try:
    t0 = time.time()
    zdu_remote.deploy(SRC, timeout=40)
    dt = time.time() - t0
    check("远端部署幂等（sha 一致则跳过）", dt < 8, f"耗时 {dt:.1f}s")
except Exception as e:
    check("远端部署幂等（sha 一致则跳过）", False, f"{type(e).__name__}: {e}")

try:
    cfg = zdu.load_config()
    window = zdu_multi._local_window(cfg)
    rs = zdu_remote.fetch(SRC, timeout=40, window=window)
    check("远端取数 ok", rs.get("ok") is True, str(rs.get("error")))
    if rs.get("ok"):
        rs_sum = rs["summary"]
        check("远端 totalTokens 与种入数据一致",
              rs_sum["totalTokens"] == 2100000,
              f"got {rs_sum['totalTokens']}，期望 2100000")
        check("远端 requests = 6", rs_sum["requests"] == 6,
              f"got {rs_sum['requests']}")
        # 分桶合计 ≤ 概览合计（session_title 不进分桶）
        bucket = sum(h["totalTokens"] for h in rs["hourly"])
        check("远端分桶合计 ≤ 概览合计",
              bucket <= rs_sum["totalTokens"],
              f"bucket={bucket} total={rs_sum['totalTokens']}")
        check("远端 hourly 恒 24 桶", len(rs["hourly"]) == 24,
              f"got {len(rs['hourly'])}")
except Exception as e:
    check("远端取数 ok", False, f"{type(e).__name__}: {e}")

# ---------------------------------------------------------------- 3. 端到端合并

print("\n=== 3. 端到端多源合并 ===")
try:
    cfg2 = dict(zdu.load_config())
    cfg2["remote_sources"] = [SRC]
    merged = zdu_multi.collect(cfg2)
    check("多源合并 ok", merged.get("ok") is True, str(merged.get("error")))
    srcs = {s["source"]: s for s in merged.get("sources") or []}
    check("包含本地源", "本机" in srcs, str(list(srcs)))
    check("包含 WSL 源", "WSL:Ubuntu-24.04" in srcs, str(list(srcs)))
    if "WSL:Ubuntu-24.04" in srcs and srcs["WSL:Ubuntu-24.04"].get("ok"):
        check("本地 + 远端 = 合计",
              merged["summary"]["totalTokens"] ==
              srcs["本机"]["totalTokens"] + srcs["WSL:Ubuntu-24.04"]["totalTokens"],
              f"{merged['summary']['totalTokens']}")
    check("localLabel 已带出", merged.get("localLabel") == "本机",
          str(merged.get("localLabel")))
except Exception as e:
    check("多源合并 ok", False, f"{type(e).__name__}: {e}")

# ---------------------------------------------------------------- 结果

print()
if FAILED:
    print(f"FAILED {len(FAILED)}: " + ", ".join(FAILED))
    sys.exit(1)
print("ALL PASS")
