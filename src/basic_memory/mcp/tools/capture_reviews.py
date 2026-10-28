"""Shared capture review receipts and bounded recovery on the MCP host."""

import asyncio
import hashlib
import json
import os
import re
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field

from basic_memory.mcp.server import mcp

TTL = 7 * 86400


def _operate(path: Path, agent: str, project: str, scope: str, action: str, payload: dict) -> dict:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    if len(encoded.encode()) > 100_000:
        raise ValueError("Capture state payload is too large")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(fd)
    now = time.time()
    with closing(sqlite3.connect(path, timeout=5)) as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=5000")
        db.execute(
            "CREATE TABLE IF NOT EXISTS capture_reviews ("
            "id TEXT PRIMARY KEY, agent TEXT NOT NULL, project TEXT NOT NULL, scope TEXT NOT NULL, "
            "session TEXT NOT NULL, turn TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, "
            "refs TEXT NOT NULL DEFAULT '[]', "
            "attempts INTEGER NOT NULL DEFAULT 0, retry_after REAL NOT NULL DEFAULT 0, "
            "created REAL NOT NULL, updated REAL NOT NULL)"
        )
        columns = {row["name"] for row in db.execute("PRAGMA table_info(capture_reviews)")}
        if "refs" not in columns:
            db.execute("ALTER TABLE capture_reviews ADD COLUMN refs TEXT NOT NULL DEFAULT '[]'")
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            "UPDATE capture_reviews SET status='expired',data='{}',refs='[]',updated=? "
            "WHERE status IN ('collecting','pending','unresolved') AND created<?",
            (now, now - TTL),
        )

        def lookup(review_id: str) -> sqlite3.Row:
            row = db.execute(
                "SELECT * FROM capture_reviews WHERE id=? AND agent=? AND project=? AND scope=?",
                (review_id, agent, project, scope),
            ).fetchone()
            if row is None:
                raise ValueError("Review is not available in this scope")
            return row

        def view(row: sqlite3.Row) -> dict:
            return {
                "id": row["id"],
                "status": row["status"],
                "session": row["session"],
                "turn": row["turn"],
                "data": json.loads(row["data"]),
                "attempts": row["attempts"],
                "verified_references": json.loads(row["refs"]),
                "created": row["created"],
                "updated": row["updated"],
            }

        if action == "start":
            session, turn = payload.get("session"), payload.get("turn")
            if not isinstance(session, str) or not session or not isinstance(turn, str) or not turn:
                raise ValueError("start requires a session and turn")
            review_id = hashlib.sha256(
                json.dumps([agent, project, scope, session, turn]).encode()
            ).hexdigest()
            supplied_id = payload.get("review_id")
            if supplied_id is not None:
                if not isinstance(supplied_id, str) or not re.fullmatch(
                    r"[a-f0-9]{32,64}", supplied_id
                ):
                    raise ValueError("review_id must be a lowercase hexadecimal identifier")
                review_id = supplied_id
            initial = payload.get("data", {})
            if not isinstance(initial, dict):
                raise ValueError("start data must be an object")
            inserted = db.execute(
                "INSERT OR IGNORE INTO capture_reviews(id,agent,project,scope,session,turn,status,data,created,updated) "
                "VALUES(?,?,?,?,?,?,'collecting',?,?,?)",
                (
                    review_id,
                    agent,
                    project,
                    scope,
                    session,
                    turn,
                    json.dumps(initial, ensure_ascii=False),
                    now,
                    now,
                ),
            )
            if inserted.rowcount:
                db.execute(
                    "UPDATE capture_reviews SET status='unresolved',retry_after=?,updated=? "
                    "WHERE agent=? AND project=? AND scope=? AND session=? AND turn<>? "
                    "AND status='collecting'",
                    (now + 300, now, agent, project, scope, session, turn),
                )
            stored = lookup(review_id)
            if stored["session"] != session or stored["turn"] != turn:
                raise ValueError("Review identifier conflicts with an existing turn")
            result = view(stored)
        elif action == "idle":
            session = payload.get("session")
            if not isinstance(session, str) or not session:
                raise ValueError("idle requires a session")
            db.execute(
                "UPDATE capture_reviews SET status='unresolved',retry_after=?,updated=? "
                "WHERE agent=? AND project=? AND scope=? AND session=? AND status='collecting'",
                (now + 300, now, agent, project, scope, session),
            )
            result = {"ok": True}
        elif action == "pending":
            rows = db.execute(
                "SELECT * FROM capture_reviews WHERE agent=? AND project=? AND scope=? "
                "AND status IN ('pending','unresolved') AND retry_after<=? "
                "AND COALESCE(json_extract(data, '$.failure_kind'), '') != 'permission' "
                "ORDER BY created LIMIT 3",
                (agent, project, scope, now),
            ).fetchall()
            for row in rows:
                delay = min(3600, 300 * 2 ** min(row["attempts"], 4))
                db.execute(
                    "UPDATE capture_reviews SET attempts=attempts+1,retry_after=?,updated=? WHERE id=?",
                    (now + delay, now, row["id"]),
                )
            result = {"reviews": [view(row) for row in rows]}
        else:
            review_id = payload.get("id")
            if not isinstance(review_id, str) or not review_id:
                raise ValueError("review id required")
            row = lookup(review_id)
            if action == "get":
                result = view(row)
            elif action == "resume":
                data = json.loads(row["data"])
                if row["status"] != "pending":
                    raise ValueError("Review is not pending")
                if data.get("failure_kind") == "permission":
                    data["failure_kind"] = "unknown"
                    db.execute(
                        "UPDATE capture_reviews SET data=?,retry_after=0,updated=? WHERE id=?",
                        (json.dumps(data, ensure_ascii=False), now, review_id),
                    )
                result = view(lookup(review_id))
            elif action == "progress":
                data = payload.get("data")
                if row["status"] != "collecting" or not isinstance(data, dict):
                    raise ValueError("progress requires a collecting review and object data")
                db.execute(
                    "UPDATE capture_reviews SET data=?,updated=? WHERE id=?",
                    (json.dumps(data, ensure_ascii=False), now, review_id),
                )
                result = view(lookup(review_id))
            elif action == "ref":
                reference = payload.get("reference")
                if not isinstance(reference, str) or not reference.strip() or len(reference) > 2048:
                    raise ValueError("ref requires a bounded reference")
                if row["status"] not in {"collecting", "pending", "unresolved"}:
                    if reference not in json.loads(row["refs"]):
                        raise ValueError("Review is already complete")
                    result = view(row)
                    db.commit()
                    return result
                refs = list(dict.fromkeys([*json.loads(row["refs"]), reference]))
                db.execute(
                    "UPDATE capture_reviews SET refs=?,updated=? WHERE id=?",
                    (json.dumps(refs), now, review_id),
                )
                result = view(lookup(review_id))
            elif action in {"unresolved", "complete"}:
                status = "unresolved" if action == "unresolved" else payload.get("status")
                if status not in {"unresolved", "saved", "no_memory", "pending"}:
                    raise ValueError("Invalid review status")
                data = payload.get(
                    "data", json.loads(row["data"]) if action == "unresolved" else {}
                )
                if not isinstance(data, dict):
                    raise ValueError("data must be an object")
                references = data.get("references", [])
                if not isinstance(references, list) or any(
                    not isinstance(ref, str) or not ref.strip() for ref in references
                ):
                    raise ValueError("references must be a list of non-empty strings")
                if status == "saved" and not references:
                    raise ValueError("saved requires references")
                if any(ref not in json.loads(row["refs"]) for ref in references):
                    raise ValueError("References must be verified before receipt")
                if status == "no_memory" and (
                    not isinstance(data.get("reason"), str) or not data["reason"].strip()
                ):
                    raise ValueError("no_memory requires reason")
                if status == "pending":
                    drafts = data.get("drafts")
                    if (
                        not isinstance(drafts, list)
                        or not 1 <= len(drafts) <= 20
                        or any(
                            not isinstance(draft, dict)
                            or not isinstance(draft.get("title"), str)
                            or not draft["title"].strip()
                            or not isinstance(draft.get("content"), str)
                            or not draft["content"].strip()
                            for draft in drafts
                        )
                    ):
                        raise ValueError("pending requires structured drafts")
                if row["status"] in {"saved", "no_memory", "expired"}:
                    if row["status"] != status or json.loads(row["data"]) != data:
                        raise ValueError("Terminal review cannot be replaced")
                elif row["status"] == status and json.loads(row["data"]) == data:
                    # A response can be lost after the transaction committed.
                    # Replaying it must not reset the retry lease or overwrite data.
                    pass
                else:
                    if status == "unresolved" and row["status"] != "collecting":
                        raise ValueError("Only a collecting review can be marked unresolved")
                    db.execute(
                        "UPDATE capture_reviews SET status=?,data=?,retry_after=?,updated=? WHERE id=?",
                        (
                            status,
                            json.dumps(data, ensure_ascii=False),
                            now + 300 if status in {"pending", "unresolved"} else 0,
                            now,
                            review_id,
                        ),
                    )
                result = view(lookup(review_id))
            else:
                raise ValueError("Invalid action")
        db.commit()
        return result


@mcp.tool(
    name="bm_capture_review",
    description="Maintain a scoped capture review receipt and bounded recovery queue.",
)
async def capture_review(
    agent: Annotated[str, Field(min_length=1, max_length=128)],
    project: Annotated[str, Field(min_length=1, max_length=128)],
    scope: Annotated[str, Field(min_length=1, max_length=256)],
    action: Literal[
        "start", "get", "ref", "progress", "pending", "idle", "unresolved", "complete", "resume"
    ],
    payload: dict,
) -> dict:
    root = Path(os.environ.get("BASIC_MEMORY_CONFIG_DIR", str(Path.home() / ".basic-memory")))
    return await asyncio.to_thread(
        _operate, root / "capture-state.sqlite3", agent, project, scope, action, payload
    )
