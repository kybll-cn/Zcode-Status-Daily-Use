#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Zcode-Status-Daily-Use 安装器 / 卸载器（Windows）。

做四件事：
  1. 把插件文件复制到 %USERPROFILE%\\.zcode\\Zcode-Status-Daily-Use；
  2. 生成 config.json（写入当前 Python 路径与 app.asar 路径）；
  3. 在 app.asar 主进程入口末尾追加一行动态 import，并重算 asar 头部里的
     文件大小、偏移与 SHA256 完整性信息；
  4. 备份原 app.asar。

与 Status-TypeBar 完全独立：注入标记不同、注入行各自匹配自己的正则，
安装/卸载互不影响，也不移除对方的注入。

运行前请完全退出 ZCode。重复运行 = 升级/修复（先移除旧注入行再加新的）。
卸载：python install.py --uninstall
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

PLUGIN_NAME = "Zcode-Status-Daily-Use"
PLUGIN_VERSION = "1.0.0"
PLUGIN_FILES = ("inject-main.cjs", "overlay.js", "zdu.py")
INJECT_MARKER = "[zdaily] load failed"

# 匹配本安装器写入的注入行（整行删除，重复安装不会叠加）。
# 按 console.error 里的专属标记匹配，而不是按路径 —— 插件目录可由 --dest 改成
# 任意位置（含路径大小写差异），按路径匹配会漏删，导致重复安装叠加注入行。
INJECT_RE = re.compile(
    r'(?m)^[ \t]*;?import\("file:///[^"\r\n]*inject-main\.cjs"\)'
    r'\.then\(\(\) => null, \(e\) => console\.error\("\[zdaily\] load failed", e\)\);[ \t]*\r?\n?'
)

DEFAULT_CONFIG = {
    "activity_min_ms": 8000,
    "heartbeat_ms": 60000,
    "hot_reload": True,
    "resident": True,
    "include_subagent": True,
    "lang": "zh",
}


# ---------------------------------------------------------------- 控制台输出
def say(msg: str = "") -> None:
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        print(msg.encode("utf-8", "replace").decode("utf-8", "replace"), flush=True)


def fail(msg: str) -> NoReturn:
    say("\n[错误] " + msg)
    raise SystemExit(1)


# ------------------------------------------------------------------ asar 读写
def parse_asar(fh) -> tuple[dict, int]:
    """读取 asar 头部，返回 (header, 数据区起始偏移)。

    asar 头部是 Chromium pickle：4/len(b)/len(c)/len(json) 四个 uint32，
    之后是 JSON。其中 b = json_len + 8，数据区从 8 + b 开始。
    """
    raw = fh.read(16)
    if len(raw) != 16:
        raise ValueError("文件太小，不是有效的 asar")
    magic, b, c, d = struct.unpack("<IIII", raw)
    if magic != 4 or d <= 0 or b != d + 8 or c != d + 4:
        raise ValueError("不是有效的 asar 头部（pickle 字段异常）")
    header = json.loads(fh.read(d))
    if not isinstance(header, dict) or not isinstance(header.get("files"), dict):
        raise ValueError("asar 头部缺少 files 目录")
    return header, 8 + b


def iter_entries(header: dict):
    """按头部顺序遍历所有叶子条目，产出 (内部路径, 条目 dict)。"""
    def walk(node: dict, prefix: str):
        for name, entry in node.get("files", {}).items():
            full = prefix + "/" + name if prefix else name
            if isinstance(entry, dict) and "files" in entry:
                yield from walk(entry, full)
            else:
                yield full, entry

    yield from walk(header, "")


def get_entry(header: dict, path: str):
    node = header
    for seg in path.replace("\\", "/").strip("/").split("/"):
        node = node.get("files", {}).get(seg)
        if node is None:
            return None
    return node


def read_entry(fh, data_start: int, entry: dict) -> bytes:
    fh.seek(data_start + int(entry["offset"]))
    return fh.read(int(entry["size"]))


def make_integrity(data: bytes, block_size: int = 4 * 1024 * 1024) -> dict:
    blocks = [hashlib.sha256(data[i:i + block_size]).hexdigest()
              for i in range(0, len(data), block_size)]
    return {
        "algorithm": "SHA256",
        "hash": hashlib.sha256(data).hexdigest(),
        "blockSize": block_size,
        "blocks": blocks,
    }


def repack_asar(src: Path, replacements: dict[str, bytes]) -> Path:
    """完整重打包 asar：只替换 replacements 中的文件，其余逐字节复制。

    输出路径由 src 推导（同目录下的固定临时文件名），不接受外部传入的目标
    路径 —— 调用方无法把任意路径带进写操作。原 app.asar 由调用方在校验
    通过后 os.replace 换入。
    """
    dst = src.with_name(src.name + ".zdu-tmp")
    with open(src, "rb") as fin:
        header, data_start = parse_asar(fin)

        items = []
        for full, entry in iter_entries(header):
            if entry.get("unpacked") or "link" in entry or "offset" not in entry:
                items.append((full, entry, None, 0, None))
                continue
            items.append((full, entry, int(entry["offset"]),
                          int(entry["size"]), replacements.get(full)))

        # 按头部顺序重新分配偏移（asar 文件区顺序与头部遍历顺序一致）
        cursor = 0
        for full, entry, old_off, old_size, new_data in items:
            if old_off is None:
                continue
            size = len(new_data) if new_data is not None else old_size
            entry["size"] = size
            entry["offset"] = str(cursor)
            if new_data is not None and "integrity" in entry:
                entry["integrity"] = make_integrity(new_data)
            cursor += size

        header_bytes = json.dumps(
            header, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        prefix = struct.pack("<IIII", 4, len(header_bytes) + 8,
                             len(header_bytes) + 4, len(header_bytes))

        with open(dst, "wb") as fout:
            fout.write(prefix)
            fout.write(header_bytes)
            for full, entry, old_off, old_size, new_data in items:
                if old_off is None:
                    continue
                if new_data is not None:
                    fout.write(new_data)
                    continue
                fin.seek(data_start + old_off)
                remaining = old_size
                while remaining:
                    chunk = fin.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError(f"读取 asar 内容失败（文件被截断）: {full}")
                    fout.write(chunk)
                    remaining -= len(chunk)
            fout.flush()
            os.fsync(fout.fileno())
    return dst


def asar_version_and_main(asar_path: Path) -> tuple[str, str]:
    with open(asar_path, "rb") as fh:
        header, data_start = parse_asar(fh)
        pkg_entry = get_entry(header, "package.json")
        if not pkg_entry or "offset" not in pkg_entry:
            return "unknown", "out/main/index.js"
        try:
            pkg = json.loads(read_entry(fh, data_start, pkg_entry).decode("utf-8"))
        except Exception:
            return "unknown", "out/main/index.js"
        version = str(pkg.get("version") or "unknown")
        main = str(pkg.get("main") or "out/main/index.js").replace("\\", "/")
        if main.startswith("./"):
            main = main[2:]
    return version, main.lstrip("/")


def patch_asar(asar_path: Path, entry_path: str, url: str | None) -> dict:
    """在入口文件末尾追加/替换/移除注入行。

    url 为 None 表示只移除本插件的注入行（卸载路径），不写入任何新行。
    """
    with open(asar_path, "rb") as fh:
        header, data_start = parse_asar(fh)
        entry = get_entry(header, entry_path)
        if not entry or "offset" not in entry:
            raise ValueError(f"在 asar 中找不到入口文件: {entry_path}")
        text = read_entry(fh, data_start, entry).decode("utf-8")
        had_injection = INJECT_MARKER in text

        cleaned = INJECT_RE.sub("", text).rstrip()
        if url is None:
            if not had_injection:
                return {"entry": entry_path, "old_size": len(text.encode("utf-8")),
                        "new_size": len(cleaned.encode("utf-8")),
                        "had_injection": False}
            patched = cleaned + "\n"
            expect = 0
        else:
            line = (';import(' + json.dumps(url, ensure_ascii=False) +
                    ').then(() => null, (e) => console.error("[zdaily] load failed", e));')
            patched = cleaned + "\n\n" + line + "\n"
            expect = 1
        if patched.count(INJECT_MARKER) != expect:
            raise ValueError(f"注入行生成异常（标记数量为 {patched.count(INJECT_MARKER)}，"
                             f"期望 {expect}），已中止，未修改客户端")
        data = patched.encode("utf-8")
        replacements = {entry_path: data}

    try:
        tmp = repack_asar(asar_path, replacements)
        # 校验临时包：入口可解析、注入标记数量正确、哈希一致、package.json 可读
        with open(tmp, "rb") as fh:
            new_header, new_start = parse_asar(fh)
            new_entry = get_entry(new_header, entry_path)
            content = read_entry(fh, new_start, new_entry).decode("utf-8")
            if content.count(INJECT_MARKER) != expect:
                raise ValueError("临时 asar 校验失败：注入标记数量不符")
            if "integrity" in new_entry:
                if hashlib.sha256(content.encode("utf-8")).hexdigest() != new_entry["integrity"]["hash"]:
                    raise ValueError("临时 asar 校验失败：SHA256 不一致")
            pkg_entry = get_entry(new_header, "package.json")
            if pkg_entry:
                json.loads(read_entry(fh, new_start, pkg_entry).decode("utf-8"))
        os.replace(tmp, asar_path)
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise

    return {"entry": entry_path, "old_size": len(text.encode("utf-8")),
            "new_size": len(data), "had_injection": had_injection}


def has_injection(asar_path: Path, entry_path: str) -> bool:
    try:
        with open(asar_path, "rb") as fh:
            header, data_start = parse_asar(fh)
            entry = get_entry(header, entry_path)
            if not entry or "offset" not in entry:
                return False
            text = read_entry(fh, data_start, entry).decode("utf-8")
            return INJECT_MARKER in text
    except Exception:
        return False


# ------------------------------------------------------------------ 通用工具
def is_zcode_running() -> bool:
    if os.name != "nt":
        return False
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq ZCode.exe", "/NH"],
            capture_output=True, text=True, errors="ignore", timeout=10,
        ).stdout
        return "ZCode.exe" in out
    except Exception:
        return False


def find_asar(explicit: str | None, plugin_dir: Path) -> Path:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    cfg_path = plugin_dir / "config.json"
    if cfg_path.exists():
        try:
            asar_cfg = json.loads(cfg_path.read_text(encoding="utf-8")).get("asar_path")
            if asar_cfg:
                candidates.append(Path(asar_cfg))
        except Exception:
            pass
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates.append(Path(local) / "Programs" / "ZCode" / "resources" / "app.asar")
        candidates.append(Path(local) / "ZCode" / "resources" / "app.asar")
    for env in ("PROGRAMFILES", "PROGRAMFILES(X86)"):
        base = os.environ.get(env)
        if base:
            candidates.append(Path(base) / "ZCode" / "resources" / "app.asar")
    for c in candidates:
        try:
            if c.is_file():
                return c.resolve()
        except OSError:
            pass
    fail("没有找到 ZCode 的 app.asar。请用 --asar 参数指定，例如：\n"
         r'  python install.py --asar "C:\Users\你\AppData\Local\Programs\ZCode\resources\app.asar"')


def find_src_dir() -> Path:
    """定位插件源码目录（install.py 自身所在目录）。

    桌面的一键脚本用固定路径调用本文件；那条路径若拼错（例如漏了目录分隔符），
    只要 install.py 本身能被成功执行，安装就能靠 __file__ 自我定位继续走下去，
    不再依赖批处理里手工拼出的目录字符串。
    """
    here = Path(__file__).resolve().parent
    if (here / "inject-main.cjs").is_file():
        return here
    fail("插件文件不完整：源码目录里找不到 inject-main.cjs\n  " + str(here) +
         "\n请确认 install.py 与 inject-main.cjs / overlay.js / zdu.py 在同一目录。")


def copy_plugin_files(src_dir: Path, dest_dir: Path) -> None:
    missing = [f for f in PLUGIN_FILES if not (src_dir / f).is_file()]
    if missing:
        fail("安装包不完整，缺少文件: " + ", ".join(missing))
    if src_dir.resolve() == dest_dir.resolve():
        return
    dest_dir.mkdir(parents=True, exist_ok=True)
    for f in PLUGIN_FILES:
        shutil.copy2(src_dir / f, dest_dir / f)


def write_json_atomic(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def do_uninstall(dest_dir: Path, asar_path: Path, entry_path: str) -> None:
    """移除注入行 + 删除插件目录（config.json 若存在也删）。"""
    if has_injection(asar_path, entry_path):
        patch_asar(asar_path, entry_path, None)   # url=None 表示只移除
        say("已从 app.asar 移除注入行（" + entry_path + "）")
    else:
        say("app.asar 中没有本插件的注入行，跳过")

    if dest_dir.exists():
        shutil.rmtree(dest_dir, ignore_errors=True)
        say("已删除插件目录: " + str(dest_dir))
    else:
        say("插件目录不存在，跳过: " + str(dest_dir))


# ---------------------------------------------------------------------- 主流程
def main() -> None:
    parser = argparse.ArgumentParser(
        description="安装/卸载 Zcode-Status-Daily-Use（Windows）。运行前请完全退出 ZCode。")
    parser.add_argument("--asar", help="ZCode 的 app.asar 路径（默认自动查找）")
    parser.add_argument("--dest", help="插件安装目录（默认 %%USERPROFILE%%\\.zcode\\"
                                      + PLUGIN_NAME + "）")
    parser.add_argument("--uninstall", action="store_true", help="移除注入并删除插件目录")
    parser.add_argument("--force", action="store_true",
                        help="跳过 ZCode 进程检查（仅建议用于测试副本）")
    parser.add_argument("--standalone", action="store_true",
                        help="由桌面的 .bat 调用：外层已确认 ZCode 退出，"
                             "不再重复检查进程；输出按 UTF-8 写（外层脚本已是纯 ASCII）")
    args = parser.parse_args()

    if args.standalone:
        # 外层 .bat 是纯 ASCII 的，中文提示全由这里输出。
        # Windows 控制台按 OEM 代码页解码，强制 UTF-8 会乱码，故直接改成 UTF-8 输出。
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    if sys.version_info < (3, 8):
        fail("需要 Python 3.8 或更高版本。")

    src_dir = find_src_dir()
    dest_dir = (Path(args.dest).expanduser() if args.dest
                else Path.home() / ".zcode" / PLUGIN_NAME).resolve()
    if args.asar:
        explicit = Path(args.asar).expanduser()
        if not explicit.is_file():
            fail("--asar 指定的文件不存在: " + str(explicit))
    asar_path = find_asar(args.asar, dest_dir)

    if args.uninstall:
        say("Zcode-Status-Daily-Use 卸载器 v" + PLUGIN_VERSION)
        say("  app.asar: " + str(asar_path))
        if is_zcode_running() and not args.force and not args.standalone:
            fail("检测到 ZCode 正在运行。请完全退出 ZCode（包括托盘图标）后重新运行。")
        try:
            _, entry_path = asar_version_and_main(asar_path)
        except Exception as e:
            fail(f"读取 app.asar 失败: {e}")
        do_uninstall(dest_dir, asar_path, entry_path)
        say("")
        say("卸载完成。重新启动 ZCode 后，设置 → 用量 里的「今日用量」区块不再出现。")
        return

    say("Zcode-Status-Daily-Use 安装器 v" + PLUGIN_VERSION)
    say("  插件目录: " + str(dest_dir))
    say("  app.asar: " + str(asar_path))

    # standalone 模式下外层 .bat 已反复确认进程消失；这里不再复查，
    # 否则外层刚退出、本脚本自身又被算进去时会误判。
    if is_zcode_running() and not args.force and not args.standalone:
        fail("检测到 ZCode 正在运行。请完全退出 ZCode（包括托盘图标）后重新运行。\n"
             "      如果只是想测试安装器，可对 app.asar 的副本使用 --asar 和 --force。")

    try:
        zcode_version, entry_path = asar_version_and_main(asar_path)
    except Exception as e:
        fail(f"读取 app.asar 失败: {e}")

    say("  ZCode 版本: " + zcode_version)
    say("  注入入口: " + entry_path)

    # 1. 复制文件
    copy_plugin_files(src_dir, dest_dir)
    say("[1/3] 插件文件已就位")

    # 2. 生成配置（保留已有自定义项）
    cfg_path = dest_dir / "config.json"
    cfg = dict(DEFAULT_CONFIG)
    if cfg_path.exists():
        try:
            old = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
            if isinstance(old, dict):
                cfg.update(old)
        except Exception:
            pass
    cfg["python_path"] = str(Path(sys.executable).resolve())
    cfg["asar_path"] = str(asar_path)
    cfg["plugin_version"] = PLUGIN_VERSION
    write_json_atomic(cfg_path, cfg)
    say("[2/3] 配置已写入: " + str(cfg_path))

    # 3. 备份并注入 app.asar
    backup = asar_path.with_name(asar_path.name + f".zdaily-backup-{zcode_version}")
    if not backup.exists():
        say("      正在备份 app.asar（约 " + str(asar_path.stat().st_size // (1024 * 1024))
            + " MB）...")
        shutil.copy2(asar_path, backup)
    inject_url = (dest_dir / "inject-main.cjs").as_uri()
    try:
        info = patch_asar(asar_path, entry_path, inject_url)
    except PermissionError as e:
        fail(f"没有权限写入 app.asar: {e}\n"
             "      请关闭 ZCode；如果 ZCode 安装在 Program Files，请用管理员终端运行本脚本。")
    except Exception as e:
        fail(f"注入 app.asar 失败（原文件未改动）: {e}")
    say("[3/3] 已注入 app.asar" + ("（替换了旧注入）" if info["had_injection"] else ""))
    say("      备份: " + str(backup))

    say("")
    say("安装完成。请启动 ZCode。")
    say("打开 设置 → 用量，页面下方会出现「今日用量」区块：")
    say("  · 今日概览（合计 token / 请求 / 缓存命中 / 活跃时段）")
    say("  · 24 小时分布（按模型堆叠）")
    say("  · 按模型、按会话、工具调用统计")
    say("")
    say("提示：ZCode 客户端升级会覆盖 app.asar，升级后重新运行本安装器即可恢复。")
    say("卸载：python install.py --uninstall")


def _use_console_encoding() -> None:
    """把 stdout/stderr 对齐到控制台当前编码。

    强制 utf-8 会在中文 Windows 的 cmd（GBK/936）里变成乱码 —— 一键脚本
    双击运行时正是这种环境。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            encoding = (stream.encoding or "").lower()
            if "utf" in encoding:
                stream.reconfigure(encoding="utf-8", errors="replace")
            else:
                stream.reconfigure(encoding=encoding or None, errors="replace")
        except Exception:
            pass


if __name__ == "__main__":
    # standalone 由外层 .bat 调用，那里已设好 UTF-8；这里再改回控制台编码会乱码
    if "--standalone" not in sys.argv:
        _use_console_encoding()
    main()
