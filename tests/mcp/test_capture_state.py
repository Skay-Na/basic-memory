"""Tests for durable and idempotent centralized capture turn counting."""

from concurrent.futures import ThreadPoolExecutor

from basic_memory.mcp.tools.capture_state import _record_turn, _setting


def test_retries_and_scope_isolation(tmp_path):
    path = tmp_path / "state.sqlite3"

    def record(turn, session="s"):
        return _record_turn(path, "dsh", "main", "desktop", session, str(turn), 5)

    for i in range(1, 6):
        assert record(i) == {"turn_count": i, "review_due": i == 5, "interval": 5}
    assert record(2) == {"turn_count": 2, "review_due": False, "interval": 5}
    assert record(1, "other") == {"turn_count": 1, "review_due": False, "interval": 5}


def test_concurrent_duplicate_is_idempotent(tmp_path):
    path = tmp_path / "state.sqlite3"
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(
            pool.map(lambda _: _record_turn(path, "dsh", "main", "p", "s", "1", 5), range(16))
        )
    assert all(
        result == {"turn_count": 1, "review_due": False, "interval": 5} for result in results
    )


def test_project_setting_overrides_client_interval(tmp_path):
    path = tmp_path / "state.sqlite3"
    assert _setting(path, "main")["interval"] == 5
    _setting(path, "main", 2)
    assert _record_turn(path, "dsh", "main", "scope", "s", "1", 5)["interval"] == 2
    assert _record_turn(path, "dsh", "main", "scope", "s", "2", 5)["review_due"] is True
    assert _setting(path, "other")["interval"] == 5
