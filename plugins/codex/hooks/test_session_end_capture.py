import json
from pathlib import Path

import session_end_capture
from session_end_capture import last_exchange, merged_config


def write_event(
    path: Path, ordinal: int, role: str, text: str, *, phase: str | None = None
) -> None:
    message = {
        "type": "message",
        "role": role,
        "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}],
    }
    if phase:
        message.update({"phase": phase, "status": "completed"})
    event = {"type": "response_item", "ordinal": ordinal, "payload": message}
    with path.open("a", encoding="utf-8") as transcript:
        transcript.write(json.dumps(event) + "\n")


def test_last_exchange_uses_latest_user_and_complete_final_answer(tmp_path: Path) -> None:
    transcript = tmp_path / "transcript.jsonl"
    write_event(transcript, 1, "user", "earlier request")
    write_event(transcript, 2, "assistant", "earlier answer", phase="final_answer")
    write_event(transcript, 3, "user", "latest request")
    write_event(transcript, 4, "assistant", "intermediate commentary", phase="commentary")
    write_event(transcript, 5, "assistant", "final part one", phase="final_answer")

    assert last_exchange(transcript) == ("latest request", "final part one")


def test_last_exchange_skips_when_latest_request_has_no_final_answer(tmp_path: Path) -> None:
    transcript = tmp_path / "transcript.jsonl"
    write_event(transcript, 1, "user", "request")
    write_event(transcript, 2, "assistant", "unfinished", phase="commentary")

    assert last_exchange(transcript) is None


def test_project_config_overrides_user_config_by_key(tmp_path: Path, monkeypatch) -> None:
    codex_home = tmp_path / "codex-home"
    project = tmp_path / "project"
    codex_home.mkdir(parents=True)
    (project / ".codex").mkdir(parents=True)
    (codex_home / "basic-memory.json").write_text(
        json.dumps({"basicMemory": {"primaryProject": "main", "sessionEndInbox": False}})
    )
    (project / ".codex/basic-memory.json").write_text(
        json.dumps({"basicMemory": {"sessionEndInbox": True}})
    )
    monkeypatch.setenv("CODEX_HOME", str(codex_home))

    assert merged_config(project / "nested") == {"primaryProject": "main", "sessionEndInbox": True}


def test_save_exchange_writes_a_non_overwriting_inbox_note(monkeypatch, tmp_path: Path) -> None:
    calls: list[tuple[str, dict | None]] = []

    class FakeClient:
        def __init__(self, endpoint: str):
            assert endpoint == "http://127.0.0.1:18894/mcp"

        def request(self, method: str, params: dict | None = None) -> dict:
            calls.append((method, params))
            return {"isError": False}

        def notify(self, method: str) -> None:
            calls.append((method, None))

    monkeypatch.setattr(session_end_capture, "StreamableHttpClient", FakeClient)
    session_end_capture.save_exchange(
        {"primaryProject": "main", "remoteMcpUrl": "http://127.0.0.1:18894/mcp"},
        "session-1234567890",
        tmp_path,
        tmp_path / "transcript.jsonl",
        ("question", "complete answer"),
    )

    assert [method for method, _ in calls] == [
        "initialize",
        "notifications/initialized",
        "tools/call",
    ]
    arguments = calls[-1][1]["arguments"]
    assert arguments["project"] == "main"
    assert arguments["directory"] == "codex/inbox"
    assert arguments["overwrite"] is False
    assert "status: pending_review" in arguments["content"]
    assert "## 用户请求\n\nquestion" in arguments["content"]
    assert "## Codex 最终回答\n\ncomplete answer" in arguments["content"]
    assert arguments["title"].endswith("session-1234567890")
