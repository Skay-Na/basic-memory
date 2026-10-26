"""Exercise memory review state without models, a graph service or real user data."""

import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

import pytest

import memory_review as review


@pytest.fixture
def turn(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    home = tmp_path / "codex"
    home.mkdir()
    (home / "basic-memory.json").write_text(json.dumps({"basicMemory": {"primaryProject": "main"}}))
    monkeypatch.setenv("CODEX_HOME", str(home))
    return {
        "session_id": "session",
        "turn_id": "turn",
        "cwd": str(tmp_path),
        "transcript_path": str(tmp_path / "transcript.jsonl"),
    }


def start(turn: dict[str, object]) -> str:
    output = review.handle_hook("prompt", turn)
    context = output["hookSpecificOutput"]["additionalContext"]
    return review.CONTINUATION.match(context).group(1)


def read(review_id: str) -> dict[str, object]:
    with closing(review.connect()) as db:
        return dict(db.execute("SELECT * FROM reviews WHERE id=?", (review_id,)).fetchone())


def pending() -> dict[str, object]:
    return {
        "status": "pending",
        "drafts": [
            {
                "kind": "remember",
                "project": "main",
                "title": "中文用户",
                "content": "本项目面向中文用户，交互使用简体中文。",
            }
        ],
    }


def test_long_messages_without_markers_still_get_review(turn):
    turn.update(
        prompt="本项目面向中文用户。" + "上下文" * 2000, last_assistant_message="回复" * 2000
    )
    key = start(turn)
    output = review.handle_hook("stop", turn)
    assert output == {}
    assert read(key)["status"] == "unresolved"
    assert read(key)["requested"] == 0
    assert read(key)["transcript"] == turn["transcript_path"]
    assert "本项目面向中文用户" not in json.dumps(read(key), ensure_ascii=False)


@pytest.mark.parametrize(
    "receipt",
    [
        {"status": "no_memory", "reason": "本轮只有临时操作，没有长期事实"},
        {"status": "saved", "references": ["codex/remember/chinese-users"]},
    ],
)
def test_receipt_prevents_extra_continuation_and_is_idempotent(turn, receipt):
    key = start(turn)
    review.record_receipt(key, receipt)
    review.record_receipt(key, receipt)
    assert review.handle_hook("stop", turn) == {}
    assert read(key)["transcript"] == ""


def test_concurrent_stop_defers_once_without_continuation(turn):
    key = start(turn)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: review.handle_hook("stop", turn), range(2)))
    assert results == [{}, {}]
    assert read(key)["status"] == "unresolved"
    assert read(key)["requested"] == 0


def test_legacy_continuation_guard_survives_changed_turn_id(turn):
    key = start(turn)
    with closing(review.connect()) as db:
        db.execute("UPDATE reviews SET status='requested',requested=1 WHERE id=?", (key,))
        db.commit()
    continued = dict(turn, turn_id="continued", prompt=f"[basic-memory-review:{key}] legacy")
    assert review.handle_hook("prompt", continued) == {}
    assert review.handle_hook("stop", dict(continued, stop_hook_active=True)) == {}
    assert read(key)["status"] == "unresolved"
    with closing(review.connect()) as db:
        assert db.execute("SELECT count(*) FROM reviews").fetchone()[0] == 1


def test_pending_is_not_success_and_retries_only_same_scope(turn):
    key = start(turn)
    review.record_receipt(key, pending())
    assert review.handle_hook("stop", turn) == {}
    assert read(key)["status"] == "pending"
    output = review.handle_hook("prompt", dict(turn, turn_id="next"))
    assert "同目录同项目有待复核记录" not in str(output)
    with closing(review.connect()) as db:
        db.execute("UPDATE reviews SET retry_after=0 WHERE id=?", (key,))
        db.commit()
    output = review.handle_hook("prompt", dict(turn, turn_id="later"))
    assert key in output["hookSpecificOutput"]["additionalContext"]
    other = Path(turn["cwd"]) / "other"
    other.mkdir()
    output = review.handle_hook("prompt", dict(turn, turn_id="other", cwd=str(other)))
    assert key not in str(output)
    review.record_receipt(key, {"status": "saved", "references": ["existing-note"]})
    assert read(key)["receipt"].find("drafts") == -1


def test_project_change_does_not_replay_old_project_drafts(turn):
    key = start(turn)
    review.record_receipt(key, pending())
    with closing(review.connect()) as db:
        db.execute("UPDATE reviews SET retry_after=0 WHERE id=?", (key,))
        db.commit()
    (review.codex_home() / "basic-memory.json").write_text(
        json.dumps({"basicMemory": {"primaryProject": "another"}})
    )
    assert key not in str(review.handle_hook("prompt", dict(turn, turn_id="next")))


def test_receipts_validate_success_drafts_and_project_scope(turn):
    key = start(turn)
    for invalid in (
        {"status": "saved"},
        {"status": "no_memory"},
        {"status": "pending", "drafts": []},
    ):
        with pytest.raises(ValueError):
            review.record_receipt(key, invalid)
    value = pending()
    value["drafts"][0]["project"] = "another"
    with pytest.raises(ValueError, match="scope"):
        review.record_receipt(key, value)
    assert read(key)["status"] == "collecting"


def test_expiry_clears_drafts_without_claiming_saved(turn):
    key = start(turn)
    review.record_receipt(key, pending())
    with closing(review.connect()) as db:
        db.execute(
            "UPDATE reviews SET created=? WHERE id=?",
            (review.time.time() - review.RETENTION_SECONDS - 1, key),
        )
        db.commit()
    row = read(key)
    assert row["status"] == "expired"
    assert row["receipt"] == "{}"
    assert row["transcript"] == ""


def test_project_opt_out_overrides_user_setting(turn):
    config = Path(turn["cwd"]) / ".codex"
    config.mkdir()
    (config / "basic-memory.json").write_text(
        json.dumps({"basicMemory": {"semanticCapture": False}})
    )
    assert review.handle_hook("prompt", turn) == {}
    assert review.handle_hook("stop", turn) == {}
    assert not (review.codex_home() / "basic-memory").exists()


def test_invalid_configuration_is_visible_and_fails_open(turn):
    (review.codex_home() / "basic-memory.json").write_text(
        json.dumps({"basicMemory": {"semanticCapture": "true"}})
    )
    result = subprocess.run(
        [sys.executable, review.__file__, "prompt"],
        input=json.dumps(turn),
        text=True,
        capture_output=True,
        check=True,
    )
    assert "systemMessage" in json.loads(result.stdout)


def test_same_turn_across_sessions_has_independent_receipts(turn):
    first = start(turn)
    second = start(dict(turn, session_id="another-session"))
    assert first != second


@pytest.mark.skipif(os.name == "nt", reason="POSIX permissions")
def test_local_database_is_private(turn):
    start(turn)
    directory = review.codex_home() / "basic-memory"
    assert directory.stat().st_mode & 0o777 == 0o700
    assert (directory / "memory-review.sqlite3").stat().st_mode & 0o777 == 0o600


def test_new_real_user_prompt_recovers_unfinished_review(turn):
    key = start(turn)
    review.handle_hook("stop", turn)
    output = review.handle_hook("prompt", dict(turn, turn_id="new-real-request"))
    assert read(key)["status"] == "unresolved"
    assert key in output["hookSpecificOutput"]["additionalContext"]


def test_receipt_failure_is_nonzero_and_never_claims_success(turn):
    key = start(turn)
    result = subprocess.run(
        [sys.executable, review.__file__, "receipt", key],
        input='{"status":"saved"}',
        text=True,
        capture_output=True,
    )
    assert result.returncode != 0
    assert read(key)["status"] == "collecting"


@pytest.mark.parametrize("legacy_requested", [False, True])
def test_stop_defers_missing_receipt_for_next_session_in_same_scope(turn, legacy_requested):
    key = start(turn)
    if legacy_requested:
        with closing(review.connect()) as db:
            db.execute("UPDATE reviews SET status='requested',requested=1 WHERE id=?", (key,))
            db.commit()
    assert review.handle_hook("stop", turn) == {}
    assert review.handle_hook("stop", turn) == {}
    assert read(key)["status"] == "unresolved"
    output = review.handle_hook("prompt", dict(turn, session_id="next-session", turn_id="next"))
    assert key in output["hookSpecificOutput"]["additionalContext"]
    review.record_receipt(key, {"status": "no_memory", "reason": "复核后没有长期事实"})
    assert review.handle_hook("stop", turn) == {}
    assert read(key)["status"] == "no_memory"
