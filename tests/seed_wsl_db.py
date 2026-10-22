"""在 WSL 里造一份 schema 与真实一致的 model_usage/turn_usage/tool_usage/session 库，
灌入已知数据，用来验证「远端取数 + 多源合并」的口径正确。

不是伪造数字给 UI 看 —— 是用与客户端同构的表结构和字段，
让远端 zdu.py 走与生产完全相同的 SQL 路径，然后断言合并结果。

可以直接跑（会覆盖 WSL 里的库）：
    python tests/seed_wsl_db.py

也可以被 remote_test.py 导入调用 seed_wsl()。
"""
import json
import subprocess
import sys
import time

SEED = r'''
import os, sqlite3, time, json, sys

DB = os.path.expanduser("~/.zcode/cli/db/db.sqlite")
os.makedirs(os.path.dirname(DB), exist_ok=True)
if os.path.exists(DB):
    os.remove(DB)
for ext in ("-wal", "-shm"):
    if os.path.exists(DB + ext):
        os.remove(DB + ext)

con = sqlite3.connect(DB)
con.executescript("""
create table model_usage (
  id text primary key, logical_request_id text, attempt_index integer,
  session_id text, turn_id text, trace_id text, span_id text,
  assistant_message_id text, parent_user_message_id text, query_source text,
  provider_id text, model_id text, variant text, agent text, mode text,
  task_type text, status text, started_at integer, first_token_at integer,
  completed_at integer, duration_ms integer, time_to_first_token_ms integer,
  finish_reason text, tool_call_count integer, input_tokens integer,
  output_tokens integer, reasoning_tokens integer,
  cache_creation_input_tokens integer, cache_read_input_tokens integer,
  provider_total_tokens integer, computed_total_tokens integer,
  retry_count integer, retryable integer, cancelled_by_user integer,
  context_exceeded integer, error_type text, error_code text,
  error_message text, raw_usage_json text, provider_metadata_json text
);
create table turn_usage (
  session_id text, turn_id text, trace_id text, user_message_id text,
  status text, started_at integer, first_model_start_at integer,
  first_token_at integer, completed_at integer, duration_ms integer,
  time_to_first_token_ms integer, model_request_count integer,
  model_retry_count integer, tool_call_count integer, tool_error_count integer,
  input_tokens integer, output_tokens integer, reasoning_tokens integer,
  cache_creation_input_tokens integer, cache_read_input_tokens integer,
  computed_total_tokens integer, retryable integer, cancelled_by_user integer,
  context_exceeded integer, error_type text, error_code text
);
create table tool_usage (
  id text primary key, session_id text, turn_id text, trace_id text,
  tool_call_id text, tool_name text, side_effect_scope text, read_only integer,
  destructive integer, approval_status text, status text, started_at integer,
  first_output_at integer, completed_at integer, duration_ms integer,
  time_to_first_output_ms integer, exit_code integer, output_bytes integer,
  stdout_bytes integer, stderr_bytes integer, truncated integer,
  retry_count integer, retryable integer, cancelled_by_user integer,
  error_type text, error_code text, error_message text
);
create table session (
  id text primary key, project_id text, workspace_id text, parent_id text,
  slug text, directory text, path text, title text, version integer,
  share_url text, summary_additions integer, summary_deletions integer,
  summary_files integer, summary_diffs integer, revert text, permission text,
  time_created integer, time_updated integer, time_compacting integer,
  time_archived integer, task_type text, title_source text,
  title_message_id text, time_title_updated integer, trace_id text,
  time_deleted integer, last_outcome text
);
""")

now = int(time.time() * 1000)
DAY = 86400000
day_start = now - 6 * 3600000   # 6 小时前，落在今天内

# model_usage 的 40 个字段按序：
# id logical_request_id attempt_index session_id turn_id trace_id span_id
# assistant_message_id parent_user_message_id query_source provider_id model_id
# variant agent mode task_type status started_at first_token_at completed_at
# duration_ms time_to_first_token_ms finish_reason tool_call_count input_tokens
# output_tokens reasoning_tokens cache_creation_input_tokens
# cache_read_input_tokens provider_total_tokens computed_total_tokens retry_count
# retryable cancelled_by_user context_exceeded error_type error_code
# error_message raw_usage_json provider_metadata_json
COLS = ("id logical_request_id attempt_index session_id turn_id trace_id span_id "
        "assistant_message_id parent_user_message_id query_source provider_id model_id "
        "variant agent mode task_type status started_at first_token_at completed_at "
        "duration_ms time_to_first_token_ms finish_reason tool_call_count input_tokens "
        "output_tokens reasoning_tokens cache_creation_input_tokens "
        "cache_read_input_tokens provider_total_tokens computed_total_tokens retry_count "
        "retryable cancelled_by_user context_exceeded error_type error_code "
        "error_message raw_usage_json provider_metadata_json").split()

rows = []
# 3 条 main_turn，2 条 subagent，1 条 session_title
specs = [
    ("main_turn", "model-a", 100000, 50000, 50000, 2),
    ("main_turn", "model-a", 200000, 100000, 100000, 3),
    ("main_turn", "model-b", 300000, 150000, 150000, 1),
    ("subagent", "model-b", 400000, 200000, 200000, 4),
    ("subagent", "model-c", 500000, 250000, 250000, 5),
    ("session_title", "model-c", 600000, 300000, 300000, 6),
]
for i, (src, mid, ct, it, ot, off_h) in enumerate(specs):
    t = day_start + off_h * 3600000
    vals = {
        "id": f"usage_model_{src}_{i}", "logical_request_id": f"lr_{i}",
        "attempt_index": 0, "session_id": "sess_remote_1",
        "turn_id": f"turn_{i}", "trace_id": f"tr_{i}", "span_id": f"sp_{i}",
        "assistant_message_id": f"am_{i}", "parent_user_message_id": None,
        "query_source": src, "provider_id": "zai", "model_id": mid,
        "variant": None, "agent": "zcode-agent", "mode": "yolo",
        "task_type": "interactive", "status": "completed",
        "started_at": t, "first_token_at": t + 100, "completed_at": t + 2000,
        "duration_ms": 1900, "time_to_first_token_ms": 900, "finish_reason": "stop",
        "tool_call_count": 0, "input_tokens": it, "output_tokens": ot,
        "reasoning_tokens": 0, "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": it, "provider_total_tokens": ct,
        "computed_total_tokens": ct, "retry_count": 0, "retryable": 0,
        "cancelled_by_user": 0, "context_exceeded": 0, "error_type": None,
        "error_code": None, "error_message": None, "raw_usage_json": None,
        "provider_metadata_json": None,
    }
    rows.append(tuple(vals[c] for c in COLS))
con.executemany(
    "insert into model_usage values (" + ",".join(["?"] * len(COLS)) + ")", rows)

con.execute(
    "insert into turn_usage values (" + ",".join(["?"] * 26) + ")",
    ("sess_remote_1", "turn_0", "tr_0", "um_0", "completed", day_start,
     day_start, day_start + 100, day_start + 2000, 2000, 900, 1, 0, 0, 0,
     100000, 50000, 0, 0, 50000, 100000, 0, 0, 0, None, None))
con.execute(
    "insert into tool_usage values (" + ",".join(["?"] * 27) + ")",
    ("t1", "sess_remote_1", "turn_0", "tr_0", "tc1", "Read", "local", 1, 0,
     "allowed", "completed", day_start, day_start + 50, day_start + 100, 100,
     50, 0, 100, 90, 10, 0, 0, 0, 0, None, None, None))
con.execute(
    "insert into session values (" + ",".join(["?"] * 27) + ")",
    ("sess_remote_1", "proj_r", "ws_remote", None, "slug", "/home/kybll/proj",
     "/home/kybll/proj", "远端测试会话", 1, None, 0, 0, 0, 0, None, None,
     day_start, day_start, None, None, "interactive", "custom", None, None,
     None, None, None))
con.commit()
con.close()
print(json.dumps({"seeded": True, "rows": len(rows), "db": DB}))
'''


def seed_wsl(distro: str = "Ubuntu-24.04", user: str = "kybll") -> dict:
    """在 WSL 里种下测试数据，返回解析后的结果。"""
    script = "python3 - <<'PYEOF'\n" + SEED + "PYEOF\n"
    p = subprocess.run(
        ["wsl.exe", "-d", distro, "-u", user, "--", "sh", "-s"],
        input=script.encode("utf-8"), capture_output=True, timeout=60,
    )
    out = p.stdout.decode("utf-8", "replace").strip()
    err = p.stderr.decode("utf-8", "replace").strip()
    if p.returncode != 0:
        raise RuntimeError(f"seed failed rc={p.returncode}: {err[:500]}")
    for ln in out.splitlines():
        ln = ln.strip()
        if ln.startswith("{"):
            return json.loads(ln)
    raise RuntimeError(f"seed produced no JSON: {out[:300]!r} {err[:300]!r}")


def main() -> None:
    print("=== 在 WSL 里种数据 ===")
    try:
        r = seed_wsl()
    except Exception as e:
        print("  失败:", e)
        raise SystemExit(1)
    print("  ", json.dumps(r, ensure_ascii=False))


if __name__ == "__main__":
    main()
