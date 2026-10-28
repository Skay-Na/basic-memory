import importlib.util
import json
import subprocess
from pathlib import Path


def _load_hook_module():
    script_path = Path(__file__).parent.parent / "scripts" / "hook.py"
    spec = importlib.util.spec_from_file_location("antigravity_hook", script_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_hook_pre_invocation_no_crash(tmp_path: Path):
    script_path = Path(__file__).parent.parent / "scripts" / "hook.py"
    payload = {
        "conversationId": "test-session",
        "workspacePaths": [str(tmp_path)],
        "transcriptPath": "",
    }
    p = subprocess.Popen(
        ["/opt/homebrew/bin/python3", str(script_path), "pre-invocation"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdout, stderr = p.communicate(input=json.dumps(payload))
    assert p.returncode == 0
    res = json.loads(stdout)
    assert "injectSteps" in res


def test_hook_stop_no_crash(tmp_path: Path):
    script_path = Path(__file__).parent.parent / "scripts" / "hook.py"
    payload = {
        "conversationId": "test-session",
        "workspacePaths": [str(tmp_path)],
        "transcriptPath": "",
    }
    p = subprocess.Popen(
        ["/opt/homebrew/bin/python3", str(script_path), "stop"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdout, stderr = p.communicate(input=json.dumps(payload))
    assert p.returncode == 0
    res = json.loads(stdout)
    assert isinstance(res, dict)


def test_is_meaningful_query():
    hook = _load_hook_module()
    assert not hook.is_meaningful_query("好的")
    assert not hook.is_meaningful_query("继续")
    assert not hook.is_meaningful_query("认可审查结论 ，立即修复")
    assert not hook.is_meaningful_query("ok")
    assert hook.is_meaningful_query("请检查软路由 Basic Memory 的部署状态与配置")


def test_is_recall_eligible_note():
    hook = _load_hook_module()
    assert not hook.is_recall_eligible_note(
        {"permalink": "dsh/inbox/2026-10-28-turn", "title": "raw turn"}
    )
    assert not hook.is_recall_eligible_note(
        {
            "permalink": "codex/notes/item",
            "metadata": {"status": "pending_review"},
        }
    )
    assert not hook.is_recall_eligible_note(
        {
            "permalink": "codex/checkpoint/old",
            "matched_chunk": "---\nstatus: superseded\n---\nold content",
        }
    )
    assert hook.is_recall_eligible_note(
        {
            "permalink": "antigravity/remember/deployment-guide",
            "title": "Deployment Guide",
            "metadata": {"status": "active"},
            "matched_chunk": "Antigravity plugin is installed in ~/.gemini/config/plugins/basic-memory",
        }
    )


def test_pre_invocation_dedup_capture_and_maintenance(tmp_path: Path, monkeypatch):
    hook = _load_hook_module()
    monkeypatch.setattr(hook, "DEFAULT_STATE_DIR", tmp_path)
    monkeypatch.setattr(hook, "STATE_DB_PATH", tmp_path / "reviews.sqlite3")

    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text(
        json.dumps(
            {
                "step_index": 1,
                "type": "USER_INPUT",
                "content": "<USER_REQUEST>查询家庭软路由 Basic Memory 部署配置详情</USER_REQUEST>",
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    calls = []

    class FakeClient:
        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            if name == "search_notes":
                return {
                    "structuredContent": {
                        "result": {
                            "results": [
                                {
                                    "title": "Unreviewed Inbox",
                                    "permalink": "dsh/inbox/turn-1",
                                    "updated_at": "2026-10-28T10:00:00Z",
                                    "matched_chunk": "raw user question",
                                },
                                {
                                    "title": "Router Note",
                                    "permalink": "antigravity/remember/router-config",
                                    "updated_at": "2026-10-28T10:00:00Z",
                                    "matched_chunk": "软路由 192.168.31.2 运行 Basic Memory",
                                },
                            ]
                        }
                    }
                }
            if name == "bm_capture_turn":
                return {
                    "structuredContent": {
                        "turn_count": 3,
                        "interval": 3,
                        "review_due": True,
                    }
                }
            if name == "bm_memory_maintenance":
                return {
                    "structuredContent": {
                        "project_id": "proj-1",
                        "project_name": "main",
                        "due": True,
                        "reason": "count",
                        "changed_note_count": 2,
                        "after_position": 205,
                        "through_position": 223,
                        "changed_notes": [
                            {
                                "external_id": "ext-del-1",
                                "permalink": "main/dsh/remember/temp",
                                "title": "Temp Deleted",
                                "operation": "deleted",
                                "partition_position": 214,
                            },
                            {
                                "external_id": "ext-new-2",
                                "permalink": "main/codex/inbox/note-2",
                                "title": "会话 · 原始请求",
                                "operation": "created",
                                "partition_position": 223,
                            },
                        ],
                    }
                }
            return {}

        def close(self):
            pass

    monkeypatch.setattr(hook, "create_mcp_client", FakeClient)

    payload = {
        "conversationId": "session-1",
        "workspacePaths": [str(tmp_path)],
        "transcriptPath": str(transcript),
    }

    # First invocation on turn-1: recalls Router Note AND injects capture + maintenance prompts
    res1 = hook.handle_pre_invocation(payload)
    assert len(res1["injectSteps"]) == 2
    recall_msg = res1["injectSteps"][0]["ephemeralMessage"]
    maint_msg = res1["injectSteps"][1]["ephemeralMessage"]
    assert "Router Note" in recall_msg
    assert "Unreviewed Inbox" not in recall_msg
    assert "Basic Memory 周期语义捕捉" in maint_msg
    assert "Basic Memory 自动记忆整理到期" in maint_msg
    assert "ext-del-1" in maint_msg
    assert "ext-new-2" in maint_msg
    assert "operation` 为 `deleted`" in maint_msg

    # Second invocation on the SAME turn-1 (e.g. after tool execution): skipped completely
    prev_call_count = len(calls)
    res2 = hook.handle_pre_invocation(payload)
    assert len(calls) == prev_call_count
    assert res2["injectSteps"] == []


def test_pre_invocation_retries_recall_after_transient_error(tmp_path: Path, monkeypatch):
    hook = _load_hook_module()
    monkeypatch.setattr(hook, "DEFAULT_STATE_DIR", tmp_path)
    monkeypatch.setattr(hook, "STATE_DB_PATH", tmp_path / "reviews.sqlite3")

    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text(
        json.dumps(
            {
                "step_index": 2,
                "type": "USER_INPUT",
                "content": "<USER_REQUEST>检查记忆后端服务与容器健康状态</USER_REQUEST>",
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    should_fail = True

    class FlakyClient:
        def call_tool(self, name, arguments):
            if should_fail:
                raise RuntimeError("transient network timeout")
            if name == "search_notes":
                return {
                    "structuredContent": {
                        "result": {
                            "results": [
                                {
                                    "title": "Health Check Note",
                                    "permalink": "antigravity/remember/health",
                                    "updated_at": "2026-10-28T10:00:00Z",
                                    "matched_chunk": "Both ports 18889 and 18892 are checked",
                                }
                            ]
                        }
                    }
                }
            if name == "bm_capture_turn":
                return {"structuredContent": {"turn_count": 1, "interval": 5, "review_due": False}}
            return {}

        def close(self):
            pass

    monkeypatch.setattr(hook, "create_mcp_client", FlakyClient)
    payload = {
        "conversationId": "session-flaky",
        "workspacePaths": [str(tmp_path)],
        "transcriptPath": str(transcript),
    }

    # First call fails: turn must NOT be marked recalled in DB
    res_fail = hook.handle_pre_invocation(payload)
    assert res_fail["injectSteps"] == []

    # Second call succeeds on retry
    should_fail = False
    res_ok = hook.handle_pre_invocation(payload)
    assert len(res_ok["injectSteps"]) == 1
    assert "Health Check Note" in res_ok["injectSteps"][0]["ephemeralMessage"]


def test_stop_ignores_canceled_turns_and_never_forces_continuation(tmp_path: Path, monkeypatch):
    hook = _load_hook_module()
    monkeypatch.setattr(hook, "DEFAULT_STATE_DIR", tmp_path)
    monkeypatch.setattr(hook, "STATE_DB_PATH", tmp_path / "reviews.sqlite3")

    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text(
        json.dumps(
            {
                "step_index": 1,
                "type": "USER_INPUT",
                "content": "<USER_REQUEST>测试取消或报错时的 Stop 行为</USER_REQUEST>",
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    payload = {
        "conversationId": "session-cancel",
        "workspacePaths": [str(tmp_path)],
        "transcriptPath": str(transcript),
        "terminationReason": "USER_CANCELED",
    }
    res = hook.handle_stop(payload)
    assert res == {}
    assert "decision" not in res
