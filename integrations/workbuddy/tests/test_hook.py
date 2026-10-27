"""Focused regression tests for the WorkBuddy local review queue."""

import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


HOOK_PATH = Path(__file__).resolve().parents[1] / "hooks" / "hook.py"
spec = importlib.util.spec_from_file_location("workbuddy_hook", HOOK_PATH)
assert spec and spec.loader
hook = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = hook
spec.loader.exec_module(hook)


class WorkBuddyHookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, {"BASIC_MEMORY_WORKBUDDY_STATE_DIR": self.temp.name})
        env.start()
        self.addCleanup(env.stop)

    def begin(self, prompt="prompt", session="session", transcript=None):
        data = hook.HookInput("UserPromptSubmit", session, transcript, "/work", prompt, "")
        return hook.begin_review(data)

    def write_transcript(self, entries):
        path = Path(self.temp.name) / "transcript.jsonl"
        path.write_text(
            "".join(json.dumps({"role": role, "content": text}) + "\n" for role, text in entries),
            encoding="utf-8",
        )
        return path

    def test_recall_uses_text_search(self):
        with patch.object(hook, "call_memory_tool", return_value={}) as call:
            hook.recall("WorkBuddy")
        self.assertEqual(call.call_args.args[1]["search_type"], "text")

    def test_ambiguous_prompt_does_not_recover_wrong_answer(self):
        transcript = self.write_transcript(
            [
                ("user", "same"),
                ("assistant", "first"),
                ("user", "same"),
                ("assistant", "second"),
            ]
        )
        review = self.begin("same", transcript=transcript)
        hook.mark_session_unresolved("session")
        result = hook.show_review(review)
        self.assertEqual(result["transcript_status"], "unverified")
        self.assertEqual(result["source_prompt"], "same")
        self.assertNotIn("transcript_excerpt", result)

    def test_unique_prompt_does_not_prove_answer_identity(self):
        transcript = self.write_transcript(
            [
                ("user", "first"),
                ("assistant", "correct answer"),
                ("user", "later"),
                ("assistant", "unrelated answer"),
            ]
        )
        review = self.begin("first", transcript=transcript)
        hook.mark_session_unresolved("session")
        result = hook.show_review(review)
        self.assertEqual(result["transcript_status"], "unverified")
        self.assertNotIn("transcript_excerpt", result)

    def test_unanswered_retries_do_not_starve_later_records(self):
        ids = []
        for i in range(4):
            ids.append(self.begin(f"prompt {i}", f"session {i}"))
            hook.mark_session_unresolved(f"session {i}")
        self.assertEqual([r["review_id"] for r in hook.retry_reviews("/work")], ids[:3])
        self.assertEqual([r["review_id"] for r in hook.retry_reviews("/work")], ids[3:])

    def test_permission_failure_requires_explicit_resume(self):
        review = self.begin()
        hook.record_receipt(
            review,
            {
                "status": "pending",
                "failure_kind": "permission",
                "drafts": [
                    {"kind": "remember", "project": "main", "title": "fact", "content": "fact"}
                ],
            },
        )
        self.assertEqual(hook.retry_reviews("/work"), [])
        self.assertEqual(hook.show_review(review)["receipt"]["failure_kind"], "permission")
        hook.resume_review(review)
        self.assertEqual([r["review_id"] for r in hook.retry_reviews("/work")], [review])

    def test_pending_legacy_receipt_and_invalid_failure_kind(self):
        draft = {"kind": "remember", "project": "main", "title": "fact", "content": "fact"}
        review = self.begin()
        hook.record_receipt(review, {"status": "pending", "drafts": [draft]})
        self.assertEqual(hook.show_review(review)["receipt"]["failure_kind"], "unknown")
        with self.assertRaises(ValueError):
            hook.validate_receipt({"status": "pending", "failure_kind": [], "drafts": [draft]})

    def test_hook_emits_review_and_accepts_receipt_when_recall_fails(self):
        env = {**os.environ, "BASIC_MEMORY_TOKEN_FILE": str(Path(self.temp.name) / "missing")}
        event = {
            "hook_event_name": "UserPromptSubmit",
            "session_id": "s",
            "cwd": "/work",
            "prompt": "hello",
        }
        result = subprocess.run(
            [sys.executable, str(HOOK_PATH), "user-prompt-submit"],
            input=json.dumps(event),
            text=True,
            capture_output=True,
            check=True,
            env=env,
        )
        context = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
        review_id = context.split("[basic-memory-review:", 1)[1].split("]", 1)[0]
        receipt = subprocess.run(
            [sys.executable, str(HOOK_PATH), "receipt", review_id],
            input=json.dumps({"status": "no_memory", "reason": "one-time request"}),
            text=True,
            capture_output=True,
            check=True,
            env=env,
        )
        self.assertEqual(json.loads(receipt.stdout)["status"], "no_memory")

    def test_old_review_is_cleared_on_show_and_cleanup(self):
        first = self.begin("old prompt", "s1")
        second = self.begin("old prompt 2", "s2")
        db_path = Path(self.temp.name) / "reviews.sqlite3"
        with sqlite3.connect(db_path) as db:
            db.execute("UPDATE reviews SET created=?", (time.time() - 8 * 86400,))
        self.assertEqual(hook.show_review(first)["status"], "expired")
        with sqlite3.connect(db_path) as db:
            rows = db.execute(
                "SELECT status, prompt_text FROM reviews ORDER BY review_id"
            ).fetchall()
        self.assertEqual(rows, [("expired", ""), ("expired", "")])
        self.assertEqual(hook.cleanup_reviews()["expired"], 0)
        self.assertEqual(hook.show_review(second)["status"], "expired")


if __name__ == "__main__":
    unittest.main()
