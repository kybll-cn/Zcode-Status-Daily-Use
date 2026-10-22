# -*- coding: utf-8 -*-
"""Zcode-Status-Daily-Use 数据层（只读访问 ~/.zcode/cli/db/db.sqlite）。

提供「今天」用量分析所需的小时级聚合，口径严格对齐客户端自身的
getUsageStats 实现（zcode.cjs 的 h2r + JLn），因此本页数字与
ZCode 设置→用量 页面在同一天同一区间下必然一致。

三点口径说明（与客户端一致，不是自创规则）：
  1. 时间窗字段用 started_at，不用 completed_at —— 与客户端 h2r 的
     所有 where 条件相同。客户端聚合模型请求时以请求发起时间为准。
  2. 时区偏移 vai(tz, now)：把当前时刻换算到目标时区的墙上时间，
     再算与 UTC 的差值；日/小时分桶统一用 (started_at + tzOffsetMs) / 桶宽。
     这样跨时区与夏令时下分桶仍对齐用户所在时区的自然日。
  3. totalTokens 用 computed_total_tokens（= input + output，缓存读已含在
     input 内），不是 provider 报的 total，与客户端 summary.totalTokens 同源。

只 SELECT，不写库；优先只读连接，WAL/shm 不可用时退回普通连接。

-------------------------------------------------- 多源（远程）聚合
客户端的用量由「发起模型请求的那个进程」写进自己持有的 db。远程 agent 在
远端跑，用量就落在远端的库；本机 db 里永远没有那段数据，而客户端的
getAppUsageStats 只查活动 workspace 那一个 client，没有跨机聚合。

所以「今天」在本插件里定义为**本机日历日的一个绝对时间窗**，并把这个窗
连同同一个时区偏移一起交给远端去查：远端按完全相同的口径分桶、返回，
本地只需逐项相加即可合并。这也避免了「各按各自本地日切分再对齐」的
跨时区错位问题。

远端执行的是本文件的副本（zdu_remote.py 负责部署），远端那一侧永远走
单源模式（--single），不会递归去拉别的远端。
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

DB_PATH = Path.home() / ".zcode" / "cli" / "db" / "db.sqlite"
CONFIG_PATH = Path(__file__).resolve().parent / "config.json"

_MS_DAY = 86_400_000
_MS_HOUR = 3_600_000


def load_config() -> dict:
    cfg = {"lang": "zh", "include_subagent": True, "poll_ms": 0}
    try:
        cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    except Exception:
        pass
    return cfg


def connect() -> sqlite3.Connection:
    """只读连接优先。

    sqlite3.connect 对不存在的路径会新建空库，可能与尚未初始化数据库的
    ZCode 产生交互，所以 fallback 前先确认文件存在。
    """
    try:
        con = sqlite3.connect(f"file:{DB_PATH.as_posix()}?mode=ro", uri=True, timeout=3)
        con.execute("select 1 from model_usage limit 1").fetchone()
    except sqlite3.OperationalError:
        if not DB_PATH.exists():
            raise
        con = sqlite3.connect(str(DB_PATH), timeout=3)
    con.row_factory = sqlite3.Row
    return con


# ---------------------------------------------------------------- 时区与分桶

def tz_offset_ms(time_zone: str, now_ms: int) -> int:
    """目标时区与 UTC 的偏移（毫秒）。

    客户端 vai() 的算法：把 now 按目标时区 formatToParts 取年月日时分秒，
    用 Date.UTC(...) 重建为"当作 UTC 的墙上时间"，再减去 now 的 UTC 秒部分。
    两者之差即该时刻的时区偏移。

    注意这个差值只在「同一时刻」上取，秒以下被 trunc 掉，因此结果稳定在
    ±14h 量级；若换算有误会退化成整天的巨大值，用下面的范围断言挡住。
    """
    try:
        from datetime import datetime as _dt, timezone as _tz
        from zoneinfo import ZoneInfo

        local = _dt.fromtimestamp(now_ms / 1000, ZoneInfo(time_zone))
        wall = _dt(
            local.year, local.month, local.day,
            local.hour, local.minute, local.second, tzinfo=_tz.utc,
        ).timestamp() * 1000
        off = int(wall - (now_ms // 1000) * 1000)
        # 合法时区偏移绝对值 < 15h；越界说明换算出错，退回 0（UTC）而不是喂给分桶
        return off if abs(off) < 15 * _MS_HOUR else 0
    except Exception:
        return 0


def local_day_start_ms(now_ms: int, tz_offset_ms_val: int) -> int:
    """目标时区里「今天 00:00」对应的 UTC 毫秒。

    做法与客户端一致：dayIndex = floor((started_at + tzOffset)/86400000)，
    当前所在自然日的 dayIndex 即 today_index，于是
    day_start_ms = today_index * 86400000 - tzOffset。
    """
    today_index = (now_ms + tz_offset_ms_val) // _MS_DAY
    return today_index * _MS_DAY - tz_offset_ms_val


# ---------------------------------------------------------------- 格式化

def _load_lang(cfg: dict) -> str:
    lang = str(cfg.get("lang") or "zh")
    return "en" if lang == "en" else "zh"


def fmt(n, lang: str = "zh") -> str:
    """token 量的紧凑写法，与 overlay.js / 客户端原生用量页顶栏同口径。

    zh：1e4 起「万」、1e8 起「亿」、1e12 起「万亿」，数字与单位间有一个空格
        （空格是客户端自己的选择，理由见 overlay.js 里 fmt() 的注释）；
    en：K / M / B / T，无空格。小数最多一位 —— 也跟客户端一样。

    舍入后要检查是否该升档：99999999 在「万」档是 9999.9999，一位小数舍入成
    10000.0，ICU 给的是「1 亿」而不是「10000 万」，所以触到上一档比例就升一档重算。
    这个实现与 Chromium/Node 的 ICU 逐值对照过（见 tests/render_test.py 的 compact()），
    两边必须保持一致。
    """
    from decimal import Decimal, ROUND_HALF_UP

    zh = lang != "en"
    v = float(n or 0)
    units = ([("万亿", 1e12), ("亿", 1e8), ("万", 1e4)] if zh
             else [("T", 1e12), ("B", 1e9), ("M", 1e6), ("K", 1e3)])
    idx = next((i for i, (_, scale) in enumerate(units) if abs(v) >= scale), None)
    if idx is None:
        return str(int(round(v)))
    while True:
        unit, scale = units[idx]
        r = Decimal(repr(v / scale)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
        ratio = units[idx - 1][1] / scale if idx > 0 else None
        if ratio is not None and abs(r) >= ratio:
            idx -= 1
            continue
        s = str(r)
        if s.endswith(".0"):
            s = s[:-2]
        return s + (" " + unit if zh else unit)


# ---------------------------------------------------------------- 主聚合

def daily_snapshot(cfg: dict | None = None, window: dict | None = None) -> dict:
    """产出「今天」的小时级用量快照。

    window: 可选的外部时间窗 {"startMs", "endMs", "tzOffsetMs"}。
      传了就用它，不再按本机当前时间重算日界 —— 远端执行时走这条路，
      以保证各源落在同一个绝对时间窗、同一组分桶上。

    返回结构：
      {
        ok: bool, error: str|None, generatedAt, timeZone,
        range: {startMs, endMs, date, startHour},
        summary: {requests, turns, totalTokens, inputTokens, outputTokens,
                  reasoningTokens, cacheCreationTokens, cacheReadTokens,
                  cacheHitRate, cacheFreshTokens, toolCalls, toolErrors,
                  modelErrors, retries, mainRequests, subRequests,
                  mainTokens, subTokens, firstAt, lastAt, activeHours},
        hourly: [{hour, totalTokens, inputTokens, outputTokens, cacheReadTokens,
                  requests, models:[{modelId, totalTokens}]}],
        models: [{modelId, totalTokens, inputTokens, outputTokens,
                  requestCount, share}],
        sessions: [{sid, title, directory, requests, totalTokens, lastAt,
                    isSub}],
        tools:  [{toolName, callCount, errorCount}],
      }
    """
    cfg = cfg or load_config()
    include_sub = cfg.get("include_subagent", True) is not False
    now = int(time.time() * 1000)
    time_zone = os.environ.get("TZ") or _system_tz()

    if window:
        # 外部给定窗口：起止与时区偏移都由调用方定，保证多源同一口径。
        day_start = int(window["startMs"])
        now = int(window["endMs"])
        tz = int(window["tzOffsetMs"])
    else:
        tz = tz_offset_ms(time_zone, now)
        day_start = local_day_start_ms(now, tz)

    empty = {
        "ok": True, "error": None, "generatedAt": now, "timeZone": time_zone,
        "range": {"startMs": day_start, "endMs": now,
                  "date": datetime.fromtimestamp(day_start / 1000).strftime("%Y-%m-%d"),
                  "startHour": 0},
        "summary": {}, "hourly": [], "models": [], "sessions": [], "tools": [],
    }

    try:
        con = connect()
    except Exception as e:
        return {**empty, "ok": False, "error": f"db open failed: {e}"}

    try:
        return _aggregate(con, now, tz, day_start, include_sub, time_zone)
    except Exception as e:
        return {**empty, "ok": False, "error": str(e)[:300]}
    finally:
        con.close()


def _system_tz() -> str:
    try:
        import time as _t

        name = _t.tzname[0] if _t.tzname else ""
        return "Asia/Shanghai" if name in ("CST", "中国标准时间") else "UTC"
    except Exception:
        return "UTC"


_SRC_FILTER = "and query_source in ('main_turn','subagent')"


def _aggregate(con, now, tz, day_start, include_sub, time_zone) -> dict:
    """核心聚合。SQL 与客户端 h2r 同构，只把天桶换成小时桶并按需过滤来源。"""

    # ---- 请求级汇总（与客户端 totals 同口径）----
    r = con.execute(
        """select
             coalesce(sum(computed_total_tokens),0) as totalTokens,
             coalesce(sum(input_tokens),0) as inputTokens,
             coalesce(sum(output_tokens),0) as outputTokens,
             coalesce(sum(reasoning_tokens),0) as reasoningTokens,
             coalesce(sum(cache_creation_input_tokens),0) as cacheCreationTokens,
             coalesce(sum(cache_read_input_tokens),0) as cacheReadTokens,
             count(*) as requests,
             coalesce(sum(case when status='error' then 1 else 0 end),0) as modelErrors,
             coalesce(sum(retry_count),0) as retries,
             min(started_at) as firstAt, max(started_at) as lastAt
           from model_usage
           where started_at >= ? and started_at <= ?""",
        (day_start, now),
    ).fetchone()

    base_input = r["inputTokens"] or 0
    cache_read = r["cacheReadTokens"] or 0
    # 客户端 cacheHitRate：优先 input，分母为 0 时退回 缓存写+缓存读
    denom = base_input if base_input > 0 else (
        (r["cacheCreationTokens"] or 0) + cache_read
    )
    hit_rate = (cache_read / denom) if denom > 0 else 0.0

    # ---- 按小时 × 模型 ----
    # hourBucket 是"自 Unix 纪元起的小时数"，不是 0~23 的钟点。
    # 减去当天 00:00 所在的小时桶基数，才得到 0~23。
    hour_origin = (day_start + tz) // _MS_HOUR
    hourly_rows = con.execute(
        f"""select
              cast((started_at + ?) / ? as integer) as hourBucket,
              model_id as modelId,
              coalesce(sum(computed_total_tokens),0) as totalTokens,
              coalesce(sum(input_tokens),0) as inputTokens,
              coalesce(sum(output_tokens),0) as outputTokens,
              coalesce(sum(cache_read_input_tokens),0) as cacheReadTokens,
              count(*) as requests
            from model_usage
            where started_at >= ? and started_at <= ?
            {_SRC_FILTER}
            group by hourBucket, model_id""",
        (tz, _MS_HOUR, day_start, now),
    ).fetchall()

    hourly: list[dict] = []

    def blank(h: int) -> dict:
        return {"hour": h, "totalTokens": 0, "inputTokens": 0, "outputTokens": 0,
                "cacheReadTokens": 0, "requests": 0, "models": []}

    for row in hourly_rows:
        h = int(row["hourBucket"]) - hour_origin
        if not (0 <= h <= 23):
            continue
        while len(hourly) <= h:
            hourly.append(blank(len(hourly)))
        e = hourly[h]
        e["totalTokens"] += int(row["totalTokens"] or 0)
        e["inputTokens"] += int(row["inputTokens"] or 0)
        e["outputTokens"] += int(row["outputTokens"] or 0)
        e["cacheReadTokens"] += int(row["cacheReadTokens"] or 0)
        e["requests"] += int(row["requests"] or 0)
        e["models"].append({"modelId": row["modelId"],
                            "totalTokens": int(row["totalTokens"] or 0)})
    while len(hourly) < 24:
        hourly.append(blank(len(hourly)))
    for e in hourly:
        e["models"].sort(key=lambda x: -x["totalTokens"])

    # ---- 按模型（当天）----
    model_rows = con.execute(
        """select model_id as modelId,
                  coalesce(sum(computed_total_tokens),0) as totalTokens,
                  coalesce(sum(input_tokens),0) as inputTokens,
                  coalesce(sum(output_tokens),0) as outputTokens,
                  count(*) as requestCount
           from model_usage
           where started_at >= ? and started_at <= ?
           group by model_id order by totalTokens desc""",
        (day_start, now),
    ).fetchall()
    models = [
        {"modelId": m["modelId"] or "(未知)", "totalTokens": int(m["totalTokens"] or 0),
         "inputTokens": int(m["inputTokens"] or 0),
         "outputTokens": int(m["outputTokens"] or 0),
         "requestCount": int(m["requestCount"] or 0)}
        for m in model_rows
    ]
    msum = sum(m["totalTokens"] for m in models) or 1
    for m in models:
        m["share"] = m["totalTokens"] / msum

    # ---- 主会话 / 子代理拆分 ----
    split = con.execute(
        """select
             coalesce(sum(case when query_source='subagent' then 1 else 0 end),0) as subRequests,
             coalesce(sum(case when query_source='subagent' then computed_total_tokens else 0 end),0) as subTokens,
             coalesce(sum(case when query_source!='subagent' then 1 else 0 end),0) as mainRequests,
             coalesce(sum(case when query_source!='subagent' then computed_total_tokens else 0 end),0) as mainTokens
           from model_usage where started_at >= ? and started_at <= ?""",
        (day_start, now),
    ).fetchone()

    # ---- 轮次与工具 ----
    turns = con.execute(
        """select count(*) as totalTurns,
                  count(distinct session_id) as totalSessions,
                  coalesce(sum(case when status='completed' then duration_ms else 0 end),0) as activeMs
           from turn_usage where started_at >= ? and started_at <= ?""",
        (day_start, now),
    ).fetchone()
    tools = [
        {"toolName": t["toolName"], "callCount": int(t["callCount"] or 0),
         "errorCount": int(t["errorCount"] or 0)}
        for t in con.execute(
            """select tool_name as toolName, count(*) as callCount,
                      coalesce(sum(case when status='error' then 1 else 0 end),0) as errorCount
               from tool_usage where started_at >= ? and started_at <= ?
               group by tool_name order by callCount desc limit 12""",
            (day_start, now),
        ).fetchall()
    ]
    tool_calls = sum(t["callCount"] for t in tools) or 1
    # 工具全量计数可能超过 limit 12，用单独一条取准
    tool_total = con.execute(
        """select count(*) as c,
                  coalesce(sum(case when status='error' then 1 else 0 end),0) as e
           from tool_usage where started_at >= ? and started_at <= ?""",
        (day_start, now),
    ).fetchone()

    # ---- 会话维度 ----
    sessions = [
        {"sid": s["sid"], "title": s["title"] or "(无标题)",
         "directory": s["directory"] or "", "requests": int(s["n"] or 0),
         "totalTokens": int(s["tot"] or 0), "lastAt": int(s["lastAt"] or 0),
         "isSub": bool(s["isSub"])}
        for s in con.execute(
            """select m.session_id as sid,
                      coalesce(s.title,'') as title,
                      coalesce(s.directory,'') as directory,
                      count(*) as n,
                      coalesce(sum(m.computed_total_tokens),0) as tot,
                      max(m.started_at) as lastAt,
                      max(case when m.session_id like 'sess_subagent%' then 1 else 0 end) as isSub
               from model_usage m left join session s on s.id = m.session_id
               where m.started_at >= ? and m.started_at <= ?
                 and (? = 1 or m.session_id not like 'sess_subagent%')
               group by m.session_id order by tot desc limit 12""",
            (day_start, now, 1 if include_sub else 0),
        ).fetchall()
    ]

    active_hours = sum(1 for e in hourly if e["totalTokens"] > 0)
    summary = {
        "requests": int(r["requests"] or 0),
        "totalTokens": int(r["totalTokens"] or 0),
        "inputTokens": base_input,
        "outputTokens": int(r["outputTokens"] or 0),
        "reasoningTokens": int(r["reasoningTokens"] or 0),
        "cacheCreationTokens": int(r["cacheCreationTokens"] or 0),
        "cacheReadTokens": cache_read,
        "cacheFreshTokens": max(0, base_input - cache_read),
        "cacheHitRate": hit_rate,
        "modelErrors": int(r["modelErrors"] or 0),
        "retries": int(r["retries"] or 0),
        "totalTurns": int(turns["totalTurns"] or 0),
        "totalSessions": int(turns["totalSessions"] or 0),
        "activeMs": int(turns["activeMs"] or 0),
        "mainRequests": int(split["mainRequests"] or 0),
        "subRequests": int(split["subRequests"] or 0),
        "mainTokens": int(split["mainTokens"] or 0),
        "subTokens": int(split["subTokens"] or 0),
        "toolCalls": int(tool_total["c"] or 0),
        "toolErrors": int(tool_total["e"] or 0),
        "firstAt": int(r["firstAt"] or 0),
        "lastAt": int(r["lastAt"] or 0),
        "activeHours": active_hours,
    }

    return {
        "ok": True, "error": None, "generatedAt": now, "timeZone": time_zone,
        "range": {
            "startMs": day_start, "endMs": now,
            "date": datetime.fromtimestamp(day_start / 1000).strftime("%Y-%m-%d"),
            "startHour": 0,
        },
        "summary": summary,
        "hourly": hourly,
        "models": models,
        "sessions": sessions,
        "tools": tools,
        "includeSubagent": include_sub,
    }


# ---------------------------------------------------------------- 常驻服务

def serve() -> None:
    """常驻查询服务：stdin 每行一个请求（空行忽略），stdout 每行一个 JSON。

    每次请求新开连接，不持长读事务，WAL checkpoint 不受阻（与 TypeBar 同思路）。
    EOF = 上游退出，随即退出，孤儿进程自清理。

    请求行可以是纯文本，也可以是 JSON：
      {"window": {"startMs":…, "endMs":…, "tzOffsetMs":…}}
    带 window 的是远端执行场景 —— 远端按调用方给的同一时间窗查，
    保证多源落在同一组分桶上。
    """
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    cfg = load_config()
    while True:
        line = sys.stdin.readline()
        if not line:
            return
        line = line.strip()
        if not line:
            continue
        window = None
        if line.startswith("{"):
            # JSON 请求行：只取 window，其余字段本版不使用。
            try:
                req = json.loads(line)
                if isinstance(req, dict) and isinstance(req.get("window"), dict):
                    window = req["window"]
            except Exception:
                window = None
        try:
            out = json.dumps(daily_snapshot(cfg, window=window), ensure_ascii=True)
        except Exception as e:
            out = json.dumps({"ok": False, "error": str(e)[:300]})
        sys.stdout.write(out + "\n")
        sys.stdout.flush()


def _console_utf8(stream=None) -> None:
    """对齐控制台编码：中文 Windows 的 cmd 是 GBK，强制 utf-8 会乱码。"""
    for s in ((stream,) if stream else (sys.stdout, sys.stderr)):
        try:
            enc = (s.encoding or "").lower()
            if "utf" in enc:
                s.reconfigure(encoding="utf-8", errors="replace")
            else:
                s.reconfigure(encoding=enc or None, errors="replace")
        except Exception:
            pass


def render_text(cfg: dict, window: dict | None = None) -> str:
    s = daily_snapshot(cfg, window=window)
    if not s.get("ok"):
        return "读取失败: " + str(s.get("error"))
    z = s["summary"]
    L = _load_lang(cfg)
    tag = "Today" if L == "en" else "今日"
    f = lambda n: fmt(n, L)
    out = [
        f"■ {tag} ({s['range']['date']}  {s['timeZone']})",
        f"  请求 {z['requests']}  轮 {z['totalTurns']}  会话 {z['totalSessions']}",
        f"  input {f(z['inputTokens'])} (缓存读 {f(z['cacheReadTokens'])}, "
        f"命中 {z['cacheHitRate'] * 100:.2f}%)  output {f(z['outputTokens'])}  "
        f"合计 {f(z['totalTokens'])}",
        f"  主会话 {z['mainRequests']}req/{f(z['mainTokens'])}  "
        f"子代理 {z['subRequests']}req/{f(z['subTokens'])}",
        f"  活跃时段 {z['activeHours']}/24  工具 {z['toolCalls']} 次",
    ]
    return "\n".join(out)


def main(argv) -> None:
    _console_utf8()
    cfg = load_config()
    args = list(argv or [])
    cmd = args[0] if args else "text"

    # --window <json>：远端执行时由调用方给定时间窗，保证与本机同一组分桶。
    window = None
    if "--window" in args:
        i = args.index("--window")
        if i + 1 < len(args):
            try:
                window = json.loads(args[i + 1])
            except Exception:
                window = None

    if cmd == "serve":
        serve()
    elif cmd == "json":
        print(json.dumps(daily_snapshot(cfg, window=window), ensure_ascii=True))
    else:
        print(render_text(cfg, window=window))


if __name__ == "__main__":
    main(sys.argv[1:])
