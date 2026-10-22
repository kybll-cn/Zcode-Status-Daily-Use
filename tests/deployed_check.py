"""用**安装目录**里的实际文件跑一遍多源取数，验证部署产物可用。

不碰源码目录 —— 装到用户机器上的就是那一份，验它才对。
"""
import json
import subprocess
import sys
from pathlib import Path

DEST = Path(r"C:\Users\kybll\.zcode\Zcode-Status-Daily-Use")
PY = r"C:\Users\kybll\AppData\Local\Programs\Python\Python312\python.exe"

print("=== 安装目录 ===")
for f in ("inject-main.cjs", "overlay.js", "zdu.py", "zdu_multi.py",
          "zdu_remote.py", "zdu_aggregate.py", "config.json"):
    p = DEST / f
    print(f"  {'OK ' if p.is_file() else 'MISS'} {f}")

cfg = json.loads((DEST / "config.json").read_text(encoding="utf-8"))
print("\n=== 配置 ===")
print("  plugin_version:", cfg.get("plugin_version"))
print("  remote_sources:", json.dumps(cfg.get("remote_sources"), ensure_ascii=False))

print("\n=== 用安装目录跑 zdu_multi.py json ===")
p = subprocess.run([PY, str(DEST / "zdu_multi.py"), "json"],
                   capture_output=True, text=True, encoding="utf-8", timeout=180)
if p.returncode != 0:
    print("  失败 rc=", p.returncode)
    print("  stderr:", (p.stderr or "")[:800])
    sys.exit(1)

line = ""
for ln in p.stdout.splitlines():
    if ln.strip().startswith("{"):
        line = ln.strip()
        break
if not line:
    print("  没有 JSON 输出")
    print("  stdout:", p.stdout[:400])
    sys.exit(1)

d = json.loads(line)
print("  ok:", d.get("ok"), "error:", d.get("error"))
s = d.get("summary") or {}
print(f"  合计 token: {s.get('totalTokens')}  请求: {s.get('requests')}")
print("  localLabel:", d.get("localLabel"))
print("  来源:")
for src in d.get("sources") or []:
    if src.get("ok") is False:
        print(f"    - {src['source']}: 失败 -> {src.get('error')}")
    else:
        print(f"    - {src['source']}: {src.get('totalTokens')} token, "
              f"{src.get('requests')} 次")

# 断言：本地有量、WSL 有量、两者之和 = 合计
ok = True
if not (s.get("totalTokens") or 0) > 0:
    print("  ✗ 本地没有数据")
    ok = False
srcs = {x["source"]: x for x in (d.get("sources") or [])}
wsl = srcs.get("WSL:Ubuntu-24.04")
if not wsl or wsl.get("ok") is not True:
    print("  ✗ WSL 源不可用:", (wsl or {}).get("error"))
    ok = False
else:
    print(f"  ✓ WSL 源取到 {wsl.get('totalTokens')} token")

if ok:
    tot = sum(x.get("totalTokens", 0) for x in d["sources"] if x.get("ok"))
    if tot == s.get("totalTokens"):
        print("  ✓ 各源之和 = 合计")
    else:
        print(f"  ✗ 各源之和 {tot} != 合计 {s.get('totalTokens')}")
        ok = False

print()
print("DEPLOYED OK" if ok else "DEPLOYED FAIL")
sys.exit(0 if ok else 1)
