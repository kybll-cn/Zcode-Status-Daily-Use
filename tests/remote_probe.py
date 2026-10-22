"""远端通道探测：不部署脚本，只看能不能连上、远端 db 在哪。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import zdu_remote

SRCS = [
    {"kind": "wsl", "distro": "Ubuntu-24.04", "user": "kybll"},
]

for s in SRCS:
    label = zdu_remote.source_label(s)
    print(f"=== {label} ===")
    r = zdu_remote.probe(s, timeout=30)
    print("  ", json.dumps(r, ensure_ascii=False))
