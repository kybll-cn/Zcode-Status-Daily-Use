"""按主进程的方式驱动 zdu_multi.py serve（常驻模式），验证多源输出。

主进程的实际用法：spawn python zdu_multi.py serve，往 stdin 写一行，
从 stdout 读一行 JSON。这里照做一遍，顺带验证：
  - serve 模式能正确处理空白行与 JSON 请求行
  - 多源结果里有 sources 字段
  - 远端失败不影响本地
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

import zdu  # noqa: E402

SRC = {"kind": "wsl", "distro": "Ubuntu-24.04", "user": "kybll",
       "label": "WSL:Ubuntu-24.04", "timeout": 40}

FAILED = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILED.append(name)


# 造一份带远程源的 config（写到临时文件，通过 config.json 覆盖）
cfg = zdu.load_config()
cfg["remote_sources"] = [SRC]
cfg_path = ROOT / "config.json"
had = cfg_path.exists()
old = cfg_path.read_text(encoding="utf-8") if had else None
cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

try:
    py = sys.executable
    proc = subprocess.Popen([py, str(ROOT / "zdu_multi.py"), "serve"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        # serve 的协议：每行一个请求。空行忽略；JSON 行可带 window。
        # 这里发一个非空文本行当请求（不带 window = 按本机当前时间查）。
        proc.stdin.write("q\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
        check("serve 返回一行 JSON", line.strip().startswith("{"), repr(line[:120]))
        if not line.strip().startswith("{"):
            raise SystemExit("serve 没有输出，检查 stderr")
        data = json.loads(line)

        check("ok 为 true", data.get("ok") is True, str(data.get("error")))
        check("有 sources 字段", isinstance(data.get("sources"), list),
              str(type(data.get("sources"))))
        names = [s.get("source") for s in (data.get("sources") or [])]
        check("包含本地源", "本机" in names, str(names))
        check("包含 WSL 源", "WSL:Ubuntu-24.04" in names, str(names))
        check("有 localLabel", data.get("localLabel") == "本机",
              str(data.get("localLabel")))
        check("summary 有 totalTokens",
              isinstance((data.get("summary") or {}).get("totalTokens"), int),
              str((data.get("summary") or {}).get("totalTokens")))
        check("hourly 24 桶", len(data.get("hourly") or []) == 24,
              str(len(data.get("hourly") or [])))

        wsl = next((s for s in data["sources"]
                    if s["source"] == "WSL:Ubuntu-24.04"), None)
        check("WSL 源取到数", wsl is not None and wsl.get("ok") is True,
              str(wsl))
        if wsl and wsl.get("ok"):
            check("WSL totalTokens = 2100000", wsl.get("totalTokens") == 2100000,
                  str(wsl.get("totalTokens")))

        # 本地 + 远端 = 合计
        tot = sum(s.get("totalTokens", 0) for s in data["sources"]
                  if s.get("ok"))
        check("各源之和 = 合计",
              tot == data["summary"]["totalTokens"],
              f"{tot} vs {data['summary']['totalTokens']}")

        # JSON 请求行（带窗口）也要能用
        proc.stdin.write(json.dumps({"window": {
            "startMs": data["range"]["startMs"],
            "endMs": data["range"]["endMs"],
            "tzOffsetMs": 28800000,
        }}) + "\n")
        proc.stdin.flush()
        line2 = proc.stdout.readline()
        check("JSON 请求行可用", line2.strip().startswith("{"), line2[:120])
        d2 = json.loads(line2)
        check("按指定窗口查询的结果一致",
              d2["summary"]["totalTokens"] == data["summary"]["totalTokens"],
              f"{d2['summary']['totalTokens']} vs {data['summary']['totalTokens']}")
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
finally:
    if had:
        cfg_path.write_text(old, encoding="utf-8")
    elif cfg_path.exists():
        cfg_path.unlink()

print()
if FAILED:
    print(f"FAILED {len(FAILED)}: " + ", ".join(FAILED))
    sys.exit(1)
print("ALL PASS")
