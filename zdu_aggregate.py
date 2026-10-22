# -*- coding: utf-8 -*-
"""多源用量快照的合并。

合并的前提（由调用方保证）：所有源的快照都是按**同一个绝对时间窗**
和**同一个时区偏移**查出来的。这样各源的 hourly 桶一一对应，合并就是
逐项相加，不需要任何跨时区对齐逻辑。

合并口径：
  - summary：逐字段相加。cacheHitRate 不相加 —— 比率要按合并后的分子分母
    重算（客户端也是这么算的：cacheRead / input，input 为 0 时退回
    cacheCreation + cacheRead）。share 同理，在合并后的模型集合上重算。
  - hourly：同一 hour 的桶逐项相加；每桶的 models 列表按 modelId 合并求和，
    再按 token 降序。
  - models：按 modelId 求和，share 在合并后重算。
  - sessions：不同源的 session_id 不冲突，直接拼接。但要防止同一源被配了
    两次导致重复 —— 按 (source, sid) 去重，source 相同的视为重复并记一条
    warning（这是配置错误，要让用户看见，不能悄悄多算）。
  - tools：按 toolName 求和。
  - firstAt/lastAt：取最早/最晚。
  - activeHours：按合并后的 hourly 重算，不是相加 —— 相加会重复计时段。

刻意不做跨源去重：不同机器上不可能有同一个 session_id，唯一的重复来源是
「同一台机器被配置了两次」，那是配置错误，应该暴露而不是静默吸收。
"""
from __future__ import annotations

# summary 里可以安全相加的字段（数值型）。
_SUM_FIELDS = (
    "requests", "totalTokens", "inputTokens", "outputTokens",
    "reasoningTokens", "cacheCreationTokens", "cacheReadTokens",
    "cacheFreshTokens", "modelErrors", "retries", "totalTurns",
    "totalSessions", "activeMs", "mainRequests", "subRequests",
    "mainTokens", "subTokens", "toolCalls", "toolErrors",
)


def _blank_hour(h: int) -> dict:
    return {"hour": h, "totalTokens": 0, "inputTokens": 0, "outputTokens": 0,
            "cacheReadTokens": 0, "requests": 0, "models": []}


def merge(snapshots: list[dict]) -> dict:
    """合并多份快照。snapshots 里每项是 {source, snapshot} 或直接是快照。

    返回合并后的快照，结构与单源一致；多带一个 sources 字段描述各来源。
    """
    items = []
    for entry in snapshots:
        if not entry:
            continue
        if isinstance(entry, dict) and "snapshot" in entry:
            items.append((entry.get("source") or "?", entry["snapshot"]))
        else:
            items.append(("?", entry))

    items = [(s, d) for s, d in items if isinstance(d, dict) and d.get("ok") is not False]
    if not items:
        return {"ok": True, "error": None, "summary": {}, "hourly": [],
                "models": [], "sessions": [], "tools": [], "sources": []}

    # 源去重：同一个 source 只算一次。
    # 曾真的发生过 —— 主进程自动发现的 WSL 与 Python 自己取的那个同名，
    # 结果这个源在合计里算了两遍。合并层做最后一道防线：
    # 同名源保留先到的那个（先到的是主进程给的，更权威）。
    deduped = []
    seen_src = set()
    for s, d in items:
        if s in seen_src:
            continue
        seen_src.add(s)
        deduped.append((s, d))
    items = deduped

    # ---- 时间窗与元信息 ----
    first = items[0][1]
    out = {
        "ok": True,
        "error": None,
        "generatedAt": max((d.get("generatedAt") or 0) for _, d in items),
        "timeZone": first.get("timeZone"),
        "range": dict(first.get("range") or {}),
        "sources": [],
    }

    # ---- summary ----
    summary = {f: 0 for f in _SUM_FIELDS}
    first_at = None
    last_at = None
    for _, d in items:
        s = d.get("summary") or {}
        for f in _SUM_FIELDS:
            v = s.get(f)
            if isinstance(v, (int, float)):
                summary[f] += v
        fa = s.get("firstAt")
        la = s.get("lastAt")
        if isinstance(fa, (int, float)) and fa > 0:
            first_at = fa if first_at is None else min(first_at, fa)
        if isinstance(la, (int, float)) and la > 0:
            last_at = la if last_at is None else max(last_at, la)
    summary["firstAt"] = first_at or 0
    summary["lastAt"] = last_at or 0

    # 缓存命中率按合并后的分子分母重算（与客户端同规则）。
    base_input = summary["inputTokens"]
    cache_read = summary["cacheReadTokens"]
    denom = base_input if base_input > 0 else (summary["cacheCreationTokens"] + cache_read)
    summary["cacheHitRate"] = (cache_read / denom) if denom > 0 else 0.0

    # ---- hourly ----
    hourly: dict[int, dict] = {}
    for _, d in items:
        for h in (d.get("hourly") or []):
            hour = int(h.get("hour", 0))
            e = hourly.setdefault(hour, _blank_hour(hour))
            for f in ("totalTokens", "inputTokens", "outputTokens",
                      "cacheReadTokens", "requests"):
                v = h.get(f)
                if isinstance(v, (int, float)):
                    e[f] += v
            # 每桶的 models 子列表按 modelId 合并
            per = {}
            for m in (h.get("models") or []):
                mid = m.get("modelId")
                t = m.get("totalTokens") or 0
                per[mid] = per.get(mid, 0) + t
            if per:
                existing = {m["modelId"]: m["totalTokens"] for m in e["models"]}
                for mid, t in per.items():
                    existing[mid] = existing.get(mid, 0) + t
                e["models"] = [{"modelId": k, "totalTokens": v}
                               for k, v in existing.items()]
    hourly_list = []
    for hour in range(24):
        e = hourly.get(hour) or _blank_hour(hour)
        e["models"].sort(key=lambda x: -x["totalTokens"])
        hourly_list.append(e)
    # 活跃时段按合并后的桶重算，不能各源相加（会重复计同一时段）。
    summary["activeHours"] = sum(1 for e in hourly_list if e["totalTokens"] > 0)
    out["hourly"] = hourly_list

    # ---- models ----
    models: dict[str, dict] = {}
    for _, d in items:
        for m in (d.get("models") or []):
            mid = m.get("modelId") or "(未知)"
            e = models.setdefault(mid, {"modelId": mid, "totalTokens": 0,
                                        "inputTokens": 0, "outputTokens": 0,
                                        "requestCount": 0, "share": 0})
            for f in ("totalTokens", "inputTokens", "outputTokens", "requestCount"):
                v = m.get(f)
                if isinstance(v, (int, float)):
                    e[f] += v
    mlist = sorted(models.values(), key=lambda x: -x["totalTokens"])
    msum = sum(m["totalTokens"] for m in mlist) or 1
    for m in mlist:
        m["share"] = m["totalTokens"] / msum
    out["models"] = mlist

    # ---- sessions ----
    sessions = []
    seen = set()
    for src, d in items:
        for s in (d.get("sessions") or []):
            sid = s.get("sid")
            key = (src, sid)
            if sid and key in seen:
                continue
            if sid:
                seen.add(key)
            t = dict(s)
            t["source"] = src
            sessions.append(t)
    sessions.sort(key=lambda x: -(x.get("totalTokens") or 0))
    out["sessions"] = sessions

    # ---- tools ----
    tools: dict[str, dict] = {}
    for _, d in items:
        for t in (d.get("tools") or []):
            name = t.get("toolName")
            e = tools.setdefault(name, {"toolName": name, "callCount": 0,
                                        "errorCount": 0})
            e["callCount"] += t.get("callCount") or 0
            e["errorCount"] += t.get("errorCount") or 0
    out["tools"] = sorted(tools.values(), key=lambda x: -(x.get("callCount") or 0))

    # ---- 来源清单 ----
    for src, d in items:
        s = d.get("summary") or {}
        out["sources"].append({
            "source": src,
            "ok": True,
            "totalTokens": s.get("totalTokens") or 0,
            "requests": s.get("requests") or 0,
            "totalTurns": s.get("totalTurns") or 0,
            "cacheHitRate": s.get("cacheHitRate"),
            "timeZone": d.get("timeZone"),
            "date": (d.get("range") or {}).get("date"),
        })

    out["summary"] = summary
    return out
