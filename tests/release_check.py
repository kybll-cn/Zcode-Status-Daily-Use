"""检查发布 zip：.bat 必须是 CRLF，.py/.js/.cjs 必须是 LF。"""
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ZIP = ROOT / "dist" / "Zcode-Status-Daily-Use-v1.2.0.zip"

FAILED = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILED.append(name)


print("=== 发布包换行符检查 ===")
with zipfile.ZipFile(ZIP) as z:
    names = z.namelist()
    for n in names:
        if n.endswith("/"):
            continue
        data = z.read(n)
        base = n.rsplit("/", 1)[-1]
        crlf = data.count(b"\r\n")
        lf = data.count(b"\n")
        if base.endswith(".bat"):
            check(f"{base} 是 CRLF", crlf > 0 and crlf == lf,
                  f"CRLF={crlf} LF={lf}")
        elif base.endswith((".py", ".js", ".cjs", ".md", ".json")):
            check(f"{base} 是 LF", crlf == 0, f"CRLF={crlf}")
        elif base.endswith(".gitattributes") or base.endswith(".gitignore"):
            pass    # 这两个本身描述换行规则，不强制

    check("含 zdu_multi.py", any(n.endswith("zdu_multi.py") for n in names))
    check("含 zdu_remote.py", any(n.endswith("zdu_remote.py") for n in names))
    check("含 zdu_aggregate.py", any(n.endswith("zdu_aggregate.py") for n in names))
    check("含 docs/remote-notes.md",
          any(n.endswith("docs/remote-notes.md") for n in names))
    check("不含 config.json",
          not any(n.endswith("/config.json") for n in names))
    check("不含 __pycache__",
          not any("__pycache__" in n for n in names))
    check("不含 preview.html",
          not any(n.endswith("tests/preview.html") for n in names))

    # 安装器能从一个干净的解压目录跑起来吗
    print("=== 安装器自检 ===")
    install_py = z.read("Zcode-Status-Daily-Use/install.py").decode("utf-8")
    check("安装器版本号是 1.2.0", 'PLUGIN_VERSION = "1.2.0"' in install_py)
    for f in ("zdu_multi.py", "zdu_remote.py", "zdu_aggregate.py"):
        check(f"安装器会带上 {f}", f'"{f}"' in install_py)

print()
if FAILED:
    print(f"FAILED {len(FAILED)}: " + ", ".join(FAILED))
    sys.exit(1)
print("ALL PASS")
