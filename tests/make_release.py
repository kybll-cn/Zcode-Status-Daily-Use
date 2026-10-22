"""打包发布 zip：与 v1.1.0 的包结构保持一致。

包内容：源码 + 文档 + 测试 + 安装/卸载脚本。
不含 config.json（安装器生成，含本机绝对路径）、不含 __pycache__、
不含 dist 本身。
"""
from __future__ import annotations

import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME = "Zcode-Status-Daily-Use"
VERSION = "1.3.0"

FILES = [
    ".gitattributes",
    ".gitignore",
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "inject-main.cjs",
    "install.bat",
    "install.py",
    "overlay.js",
    "uninstall.bat",
    "zdu.py",
    "zdu_multi.py",
    "zdu_remote.py",
    "zdu_aggregate.py",
    "zdu_remote_main.cjs",
]

DIRS = ["docs", "tests"]

EXCLUDE_NAMES = {"__pycache__", "preview.html", ".DS_Store"}


def main() -> None:
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    out = dist / f"{NAME}-v{VERSION}.zip"
    if out.exists():
        out.unlink()

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in FILES:
            p = ROOT / rel
            if not p.is_file():
                raise SystemExit(f"缺文件: {rel}")
            z.write(p, f"{NAME}/{rel}")

        for d in DIRS:
            base = ROOT / d
            if not base.is_dir():
                continue
            for p in sorted(base.rglob("*")):
                if not p.is_file():
                    continue
                if any(part in EXCLUDE_NAMES for part in p.parts):
                    continue
                rel = p.relative_to(ROOT).as_posix()
                z.write(p, f"{NAME}/{rel}")

    print(f"已生成: {out}")
    print(f"大小: {out.stat().st_size} 字节")
    with zipfile.ZipFile(out) as z:
        for n in z.namelist():
            print("  ", n)


if __name__ == "__main__":
    main()
