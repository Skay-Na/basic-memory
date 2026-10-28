"""Test persistence and isolation of shared capture review receipts."""

import pytest
import sqlite3
from fastmcp import Client

from basic_memory.mcp.server import mcp
from basic_memory.mcp.tools.capture_reviews import _operate


def test_receipts_are_scoped_idempotent_and_persistent(tmp_path):
    path = tmp_path / "state.sqlite3"

    def call(action, payload, scope="a"):
        return _operate(path, "dsh", "main", scope, action, payload)

    row = call("start", {"session": "s", "turn": "1"})
    assert call("start", {"session": "s", "turn": "1"})["id"] == row["id"]
    with pytest.raises(ValueError, match="scope"):
        call("get", {"id": row["id"]}, "other")
    receipt = {"id": row["id"], "status": "saved", "data": {"references": ["main/fact"]}}
    with pytest.raises(ValueError, match="verified"):
        call("complete", receipt)
    call("ref", {"id": row["id"], "reference": "main/fact"})
    assert call("complete", receipt)["status"] == "saved"
    assert call("complete", receipt)["status"] == "saved"
    with pytest.raises(ValueError, match="Terminal"):
        call("complete", {"id": row["id"], "status": "no_memory", "data": {"reason": "none"}})


def test_pending_requires_drafts_and_can_be_completed(tmp_path):
    path = tmp_path / "state.sqlite3"

    def call(action, payload):
        return _operate(path, "codex", "main", "scope", action, payload)

    review_id = call("start", {"session": "s", "turn": "t"})["id"]
    with pytest.raises(ValueError, match="drafts"):
        call("complete", {"id": review_id, "status": "pending", "data": {}})
    assert (
        call(
            "complete",
            {
                "id": review_id,
                "status": "pending",
                "data": {"drafts": [{"title": "a", "content": "b"}]},
            },
        )["status"]
        == "pending"
    )
    with sqlite3.connect(path) as db:
        before = db.execute(
            "SELECT retry_after FROM capture_reviews WHERE id=?", (review_id,)
        ).fetchone()[0]
    call(
        "complete",
        {
            "id": review_id,
            "status": "pending",
            "data": {"drafts": [{"title": "a", "content": "b"}]},
        },
    )
    with sqlite3.connect(path) as db:
        assert (
            db.execute(
                "SELECT retry_after FROM capture_reviews WHERE id=?", (review_id,)
            ).fetchone()[0]
            == before
        )
    assert (
        call("complete", {"id": review_id, "status": "no_memory", "data": {"reason": "reviewed"}})[
            "status"
        ]
        == "no_memory"
    )


def test_new_turn_and_idle_preserve_unfinished_review_data(tmp_path):
    path = tmp_path / "state.sqlite3"

    def call(action, payload):
        return _operate(path, "opencode", "main", "workspace", action, payload)

    first = call("start", {"session": "s", "turn": "1", "data": {"user": "request"}})
    second = call("start", {"session": "s", "turn": "2", "data": {"user": "next"}})
    call("start", {"session": "s", "turn": "1", "data": {"user": "request"}})
    assert call("get", {"id": second["id"]})["status"] == "collecting"
    first = call("get", {"id": first["id"]})
    assert first["status"] == "unresolved"
    assert first["data"] == {"user": "request"}
    call("idle", {"session": "s"})
    second = call("get", {"id": second["id"]})
    assert second["status"] == "unresolved"
    assert second["data"] == {"user": "next"}


def test_client_review_id_is_scoped_and_cannot_be_reused_for_another_turn(tmp_path):
    path = tmp_path / "state.sqlite3"
    review_id = "a" * 32
    start = {"session": "s", "turn": "1", "review_id": review_id}
    assert _operate(path, "dsh", "main", "scope", "start", start)["id"] == review_id
    with pytest.raises(ValueError, match="conflicts"):
        _operate(path, "dsh", "main", "scope", "start", {**start, "turn": "2"})
    with pytest.raises(ValueError, match="scope"):
        _operate(path, "dsh", "main", "other", "start", start)


def test_permission_failure_stays_paused_until_resume(tmp_path):
    path = tmp_path / "state.sqlite3"

    def call(action, payload):
        return _operate(path, "workbuddy", "main", "scope", action, payload)

    review_id = call("start", {"session": "s", "turn": "1"})["id"]
    call(
        "complete",
        {
            "id": review_id,
            "status": "pending",
            "data": {"failure_kind": "permission", "drafts": [{"title": "x", "content": "y"}]},
        },
    )
    with sqlite3.connect(path) as db:
        db.execute("UPDATE capture_reviews SET retry_after=0")
    assert call("pending", {})["reviews"] == []
    call("resume", {"id": review_id})
    assert call("pending", {})["reviews"][0]["id"] == review_id


@pytest.mark.asyncio
async def test_tools_are_registered_and_accessible_via_mcp(tmp_path, monkeypatch):
    monkeypatch.setenv("BASIC_MEMORY_CONFIG_DIR", str(tmp_path))
    args = {"agent": "test", "project": "main", "scope": "workspace"}
    async with Client(mcp) as client:
        count = await client.call_tool("bm_capture_turn", {**args, "session": "s", "turn": "1"})
        assert count.structured_content["turn_count"] == 1
        started = await client.call_tool(
            "bm_capture_review",
            {**args, "action": "start", "payload": {"session": "s", "turn": "1"}},
        )
        assert started.structured_content["status"] == "collecting"
