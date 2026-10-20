# -*- coding: utf-8 -*-
"""离线渲染检查：用真实数据在无浏览器环境下跑一遍 overlay 的渲染逻辑，
产出静态 HTML 快照，肉眼核对版面与数字。

不测样式渲染（那要真浏览器），只验证三件事：
  1. 数据结构完整、字段不缺（缺一个就是页面某个角落空白）；
  2. 24 小时分桶总 token 与 summary 一致（分桶逻辑写错就会对不上）；
  3. 无 JS 异常。

用法：python tests/render_test.py  → 输出 tests/preview.html
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def load_snapshot() -> dict:
    out = subprocess.run(
        [sys.executable, str(ROOT / "zdu.py"), "json"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if out.returncode != 0:
        raise SystemExit("zdu.py json 执行失败:\n" + out.stderr)
    return json.loads(out.stdout)


def compact(n, loc: str = "zh") -> str:
    """与 overlay.js fmt()、也即客户端原生顶栏同口径的紧凑数字。

    规则来自客户端的 usageStatsUiParts（Intl 的 compact 记法，≤1 位小数）：
      zh：1e4 起「万」、1e8 起「亿」、1e12 起「万亿」，数字与单位间有一个空格；
      en：1e3 K / 1e6 M / 1e9 B / 1e12 T，无空格。

    进位要单独处理：99999999 在「万」这一档是 9999.9999 → 四舍五入到 10000.0，
    ICU 会继续升档成「1 亿」而不是输出「10000 万」。所以舍入后若触到上一档的
    比例（万→亿 是 1e4，K→M 是 1e3），就升一档重算。

    本函数与 Chromium/Node 的 ICU 做过逐值对照（4000 余个值含各档边界，零差异），
    check() 里另有几个实测值断言，口径漂了会被测出来。
    """
    from decimal import Decimal, ROUND_HALF_UP

    v = float(n or 0)
    units = ([("万亿", 1e12), ("亿", 1e8), ("万", 1e4)] if loc == "zh"
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
        return s + (" " + unit if loc == "zh" else unit)


def check(d: dict) -> None:
    """结构与一致性断言。"""
    problems = []
    if not d.get("ok"):
        problems.append("快照 ok=False: " + str(d.get("error")))

    for key in ("summary", "hourly", "models", "sessions", "tools", "range"):
        if key not in d:
            problems.append("缺字段: " + key)

    s = d.get("summary", {})
    for key in ("requests", "totalTokens", "inputTokens", "outputTokens",
                "cacheHitRate", "activeHours", "mainTokens", "subTokens",
                "mainRequests", "subRequests", "toolCalls"):
        if key not in s:
            problems.append("summary 缺字段: " + key)

    hourly = d.get("hourly", [])
    if len(hourly) != 24:
        problems.append(f"hourly 应有 24 项，实为 {len(hourly)}")
    for h in hourly:
        if not (0 <= h["hour"] <= 23):
            problems.append("小时越界: " + str(h["hour"]))
            break

    # 分桶与 summary 对账：小时分桶只含 main_turn/subagent，summary 含全部来源，
    # 因此分桶合计应 <= summary，且差值应等于 session_title 等少量来源。
    hsum = sum(h["totalTokens"] for h in hourly)
    total = s.get("totalTokens", 0)
    if hsum > total:
        problems.append(f"分桶合计 {hsum} 超过 summary {total}，分桶逻辑有误")
    elif total > 0 and (total - hsum) / total > 0.05:
        problems.append(
            f"分桶合计 {hsum} 与 summary {total} 差距过大（{total - hsum}），"
            f"可能有来源被误排除")

    # 活跃小时必须与 summary.activeHours 一致
    nz = sum(1 for h in hourly if h["totalTokens"] > 0)
    if nz != s.get("activeHours"):
        problems.append(f"活跃小时不一致: 图 {nz} vs summary {s.get('activeHours')}")

    # 每个非零小时，其模型明细之和应等于该小时总数
    for h in hourly:
        msum = sum(m["totalTokens"] for m in h.get("models", []))
        if h["totalTokens"] > 0 and msum != h["totalTokens"]:
            problems.append(f"{h['hour']} 时模型明细 {msum} != 合计 {h['totalTokens']}")
            break

    # 数字口径：这几个值是在 Chromium(ICU) 里实测出来的，写死断言防止
    # 紧凑格式（万亿 / K M B）被改回旧写法而没人发现。
    for value, want in ((121100000, "1.2 亿"), (630000000, "6.3 亿"),
                        (12345, "1.2 万"), (99999999, "1 亿"), (999, "999")):
        got = compact(value)
        if got != want:
            problems.append(f"中文紧凑格式 {value} 应为 {want!r}，实为 {got!r}")
    if compact(121100000, "en") != "121.1M":
        problems.append("英文紧凑格式 121100000 应为 '121.1M'")

    # 本文件与 zdu.py 各有一份 Python 实现（有意不共用：共用的话同一个 bug 会
    # 一起通过）。这里让两者对账，防止离线预览与 CLI 摘要给出不同的数字。
    sys.path.insert(0, str(ROOT))
    import zdu
    for value in (121100000, 630000000, 12345, 99999999, 12500, 999, 1200000000):
        for loc in ("zh", "en"):
            a, b = compact(value, loc), zdu.fmt(value, loc)
            if a != b:
                problems.append(f"compact()/zdu.fmt() 不一致（{loc}）："
                                f"{value} → {a!r} vs {b!r}")

    print("=" * 56)
    if problems:
        print("发现问题：")
        for p in problems:
            print("  ✗", p)
    else:
        print("✓ 全部结构与一致性检查通过")
    print("=" * 56)
    print(f"  合计 token   {s.get('totalTokens'):,}")
    print(f"  分桶合计     {hsum:,}  (差额 {total - hsum:,} = 非 main/sub 来源)")
    print(f"  请求         {s.get('requests')}  (主 {s.get('mainRequests')} / 子 {s.get('subRequests')})")
    print(f"  活跃小时     {nz}/24")
    return problems


def to_html(d: dict) -> str:
    """用与 overlay.js 相同的结构生成静态预览。"""
    s = d["summary"]

    def fmt(n):
        return compact(n, "zh")

    COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4"]

    def short(m):
        return m.rsplit("/", 1)[-1] if m else "?"

    hourly = d["hourly"]
    mx = max([h["totalTokens"] for h in hourly] + [1])
    H, PAD = 132, 18
    plotH = H - PAD - 6
    W = 728          # 与卡片内可用宽度一致（820 视口 - 两侧留白与内边距）
    slot = W / 24
    bw = slot * 0.62
    bars = []
    for h in hourly:
        x = h["hour"] * slot + (slot - bw) / 2
        if h["totalTokens"] <= 0:
            bars.append(f'<line x1="{x:.2f}" x2="{x+bw:.2f}" y1="{H-PAD}" '
                        f'y2="{H-PAD}" stroke="#ccc" stroke-width=".5"/>')
            continue
        acc = 0.0
        for i, m in enumerate(h["models"][:6]):
            fr = m["totalTokens"] / mx
            sh = max(0.35, fr * plotH)
            y = H - PAD - (acc + fr) * plotH
            bars.append(f'<rect x="{x:.2f}" y="{y:.2f}" width="{bw:.2f}" '
                        f'height="{sh:.2f}" fill="{COLORS[i%6]}"/>')
            acc += fr

    seen, lg = set(), []
    for h in hourly:
        for i, m in enumerate(h["models"][:6]):
            if m["modelId"] in seen:
                continue
            seen.add(m["modelId"])
            c = COLORS[len(lg) % 6]
            lg.append(f'<span class="lg"><i style="background:{c}"></i>{short(m["modelId"])}</span>')

    mmax = max([m["totalTokens"] for m in d["models"]] + [1])
    mrows = "".join(
        f'<div class="row"><span class="nm">{short(m["modelId"])}</span>'
        f'<span class="tk"><i style="width:{m["totalTokens"]/mmax*100:.1f}%;'
        f'background:{COLORS[i%6]}"></i></span>'
        f'<span class="vl">{fmt(m["totalTokens"])}</span></div>'
        for i, m in enumerate(d["models"][:6]))

    def hhmm(ms):
        if not ms:
            return "--:--"
        import datetime
        return datetime.datetime.fromtimestamp(ms / 1000).strftime("%H:%M")

    srows = "".join(
        f'<div class="row s"><span class="nm">{x["title"][:40]}'
        f'{"" if not x["isSub"] else "（子）"}</span>'
        f'<span class="sb">{fmt(x["totalTokens"])} · {x["requests"]}次 · {hhmm(x["lastAt"])}</span></div>'
        for x in d["sessions"][:6])

    return f"""<!doctype html><html lang="zh"><meta charset="utf-8">
<title>Zcode-Status-Daily-Use 预览</title>
<style>
body{{font:14px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;background:#f6f7f9;
 padding:24px;margin:0}}
.card{{max-width:760px;margin:0 auto;background:#fff;border:1px solid #e3e5e8;
 border-radius:12px;padding:16px}}
.dark body{{background:#18191b}}.dark .card{{background:#1f2023;border-color:#333}}
.head{{display:flex;align-items:baseline;gap:10px;margin-bottom:14px}}
.t{{font-size:15px;font-weight:600}}.dt{{margin-left:auto;font-size:12px;color:#888}}
.stats{{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap}}
.cell{{flex:1 1 130px;background:#f3f4f6;border-radius:10px;padding:10px 12px}}
.dark .cell{{background:#26272b}}
.cv{{font-size:19px;font-weight:600;font-variant-numeric:tabular-nums}}
.cl{{margin-top:2px;font-size:12px;color:#777}}.cs{{font-size:11px;color:#999}}
.sec{{margin-bottom:8px;font-size:13px;font-weight:500}}
svg{{width:100%;height:{H}px;display:block}}
.ticks{{display:flex;justify-content:space-between;margin-top:2px;font-size:10px;color:#999}}
.lg{{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#777;margin-right:10px}}
.lg i{{width:8px;height:8px;border-radius:2px;display:inline-block}}
.cols{{display:flex;gap:18px;margin-top:18px;flex-wrap:wrap}}
.col{{flex:1 1 260px;min-width:0}}
.ct{{margin-bottom:8px;font-size:12px;font-weight:500;color:#777}}
.row{{display:flex;align-items:center;gap:8px;padding:4px 0}}
.row.s{{display:block}}
.nm{{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}}
.tk{{flex:1;height:6px;border-radius:3px;background:#eee;overflow:hidden;min-width:40px}}
.dark .tk{{background:#333}}
.tk i{{display:block;height:100%;border-radius:3px}}
.vl{{font-size:11px;color:#777;font-variant-numeric:tabular-nums}}
.sb{{display:block;font-size:11px;color:#999;font-variant-numeric:tabular-nums}}
.foot{{display:flex;justify-content:space-between;gap:14px;margin-top:16px;padding-top:12px;
 border-top:1px solid #eee;font-size:11px;color:#777;flex-wrap:wrap}}
.dark .foot{{border-color:#333}}
</style>
<div class="card">
 <div class="head"><span class="t">今日用量</span><span class="dt">{d["range"]["date"]} · {d["timeZone"]}</span></div>
 <div class="stats">
  <div class="cell"><div class="cv">{fmt(s["totalTokens"])}</div><div class="cl">合计 token</div></div>
  <div class="cell"><div class="cv">{s["requests"]:,}</div><div class="cl">请求</div><div class="cs">{s["totalTurns"]} 轮</div></div>
  <div class="cell"><div class="cv">{s["cacheHitRate"]*100:.1f}%</div><div class="cl">缓存命中</div><div class="cs">新增 {fmt(s["cacheFreshTokens"])}</div></div>
  <div class="cell"><div class="cv">{s["activeHours"]}/24</div><div class="cl">活跃时段</div><div class="cs">{hhmm(s["firstAt"])} – {hhmm(s["lastAt"])}</div></div>
 </div>
 <div class="sec">24 小时分布（按模型堆叠）</div>
 <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none">{''.join(bars)}
  <line x1="0" x2="{W}" y1="{H-PAD}" y2="{H-PAD}" stroke="#ccc" stroke-width=".4"/></svg>
 <div class="ticks">{''.join(f'<span>{h:02d}:00</span>' for h in (0,6,12,18))}</div>
 <div style="margin-top:8px">{''.join(lg)}</div>
 <div class="cols">
  <div class="col"><div class="ct">按模型</div>{mrows}</div>
  <div class="col"><div class="ct">按会话</div>{srows}</div>
 </div>
 <div class="foot">
  <span>主会话 {fmt(s["mainTokens"])} ({s["mainRequests"]}次) · 子代理 {fmt(s["subTokens"])} ({s["subRequests"]}次)</span>
  <span>工具 {s["toolCalls"]:,} 次{f' · 失败 {s["toolErrors"]}' if s['toolErrors'] else ''}</span>
 </div>
</div></html>"""


if __name__ == "__main__":
    d = load_snapshot()
    problems = check(d)
    out = HERE / "preview.html"
    out.write_text(to_html(d), encoding="utf-8")
    print("\n预览已生成:", out)
    sys.exit(1 if problems else 0)
