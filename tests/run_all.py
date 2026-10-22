# -*- coding: utf-8 -*-
"""一次跑完全部测试。

需要 Electron 的三个测试（要 require asar 里的 ssh2）会自动用
ZCode.exe 的 ELECTRON_RUN_AS_NODE 模式跑；找不到 ZCode.exe 就跳过并提示。

用法：python tests/run_all.py
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
PY = sys.executable

# (标签, 命令前缀, 脚本, 需要 Electron)
CASES = [
    ("注入语法",      "node",  "tests/push_test.js",          False),
    ("泵限频",        "node",  "tests/pump_test.js",          False),
    ("配色一致",      "node",  "tests/color_test.js",         False),
    ("来源分区渲染",  "node",  "tests/render_remote_test.js", False),
    ("本地渲染对账",  "py",    "tests/render_test.py",        False),
    ("合并口径+WSL",  "py",    "tests/remote_test.py",        False),
    ("常驻 serve",    "py",    "tests/serve_test.py",         False),
    ("远程通道",      "electron", "tests/remote_main_test.js", True),
    ("端到端合并",    "electron", "tests/e2e_merge_test.js",   True),
    ("部署产物",      "electron", "tests/deployed_check.js",   True),
]


def find_zcode() -> str | None:
    """定位 ZCode.exe —— 优先用插件的 asar_path 反推，再试常见安装位置。"""
    cands = []
    cfg = Path.home() / ".zcode" / "Zcode-Status-Daily-Use" / "config.json"
    try:
        import json
        d = json.loads(cfg.read_text(encoding="utf-8-sig"))
        if d.get("asar_path"):
            # .../ZCode/resources/app.asar → .../ZCode/ZCode.exe
            p = Path(d["asar_path"])
            cands.append(p.parent.parent / "ZCode.exe")
    except Exception:
        pass
    cands.append(Path(os.environ.get("LOCALAPPDATA", "")) /
                 "Programs" / "ZCode" / "ZCode.exe")
    for c in cands:
        if c and c.is_file():
            return str(c)
    return None


def main() -> int:
    zcode = find_zcode()
    env_el = dict(os.environ)
    if zcode:
        env_el["ELECTRON_RUN_AS_NODE"] = "1"
        env_el["ZDU_PYTHON"] = PY
    else:
        print("!! 没找到 ZCode.exe，需要 Electron 的测试会跳过\n")

    failed = []
    skipped = []
    for label, kind, script, need_el in CASES:
        p = ROOT / script
        if not p.is_file():
            print(f"SKIP  {label:14s} （{script} 不存在）")
            skipped.append(label)
            continue
        if kind == "electron":
            if not zcode:
                print(f"SKIP  {label:14s} （需要 Electron）")
                skipped.append(label)
                continue
            cmd = [zcode, str(p)]
            env = env_el
        elif kind == "node":
            cmd = ["node", str(p)]
            env = os.environ
        else:
            cmd = [PY, str(p)]
            env = env_el if need_el else os.environ

        try:
            r = subprocess.run(cmd, cwd=str(ROOT), env=env,
                               capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=400)
            out = (r.stdout or "") + (r.stderr or "")
        except subprocess.TimeoutExpired:
            print(f"FAIL  {label:14s} 超时")
            failed.append(label)
            continue

        bad = ("FAIL" in out) or ("Traceback" in out) or ("Error:" in out) or r.returncode != 0
        if bad:
            print(f"FAIL  {label:14s}")
            tail = [x for x in out.splitlines()
                    if x.strip() and "ExperimentalWarning" not in x
                    and "trace-warnings" not in x][-8:]
            for ln in tail:
                print("        " + ln)
            failed.append(label)
        else:
            print(f"PASS  {label:14s}")

    print()
    print(f"通过 {len(CASES) - len(failed) - len(skipped)} / "
          f"失败 {len(failed)} / 跳过 {len(skipped)}")
    if failed:
        print("失败: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
