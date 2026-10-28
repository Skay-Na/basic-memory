"""Persistent, idempotent session turn counting for memory capture clients."""

import asyncio
import os
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field

from basic_memory.mcp.server import mcp


def _record_turn(
    path: Path, agent: str, project: str, scope: str, session: str, turn: str, interval: int
) -> dict[str, object]:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(descriptor)
    with closing(sqlite3.connect(path, timeout=5)) as db:
        db.execute("PRAGMA busy_timeout=5000")
        db.execute(
            "CREATE TABLE IF NOT EXISTS capture_turns ("
            "seq INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, project TEXT NOT NULL, "
            "scope TEXT NOT NULL, session TEXT NOT NULL, turn TEXT NOT NULL, "
            "UNIQUE(agent, project, scope, session, turn))"
        )
        db.execute(
            "CREATE TABLE IF NOT EXISTS capture_settings (project TEXT PRIMARY KEY, interval INTEGER NOT NULL CHECK(interval BETWEEN 1 AND 100))"
        )
        db.execute("BEGIN IMMEDIATE")
        setting = db.execute(
            "SELECT interval FROM capture_settings WHERE project=?", (project,)
        ).fetchone()
        interval = setting[0] if setting is not None else 5
        db.execute(
            "INSERT OR IGNORE INTO capture_turns(agent,project,scope,session,turn) "
            "VALUES(?,?,?,?,?)",
            (agent, project, scope, session, turn),
        )
        sequence = db.execute(
            "SELECT seq FROM capture_turns WHERE agent=? AND project=? AND scope=? "
            "AND session=? AND turn=?",
            (agent, project, scope, session, turn),
        ).fetchone()[0]
        count = db.execute(
            "SELECT count(*) FROM capture_turns WHERE agent=? AND project=? AND scope=? "
            "AND session=? AND seq<=?",
            (agent, project, scope, session, sequence),
        ).fetchone()[0]
        db.commit()
    return {"turn_count": count, "review_due": count % interval == 0, "interval": interval}


def _setting(path: Path, project: str, interval: int | None = None) -> dict[str, object]:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(descriptor)
    with closing(sqlite3.connect(path, timeout=5)) as db:
        db.execute("PRAGMA busy_timeout=5000")
        db.execute(
            "CREATE TABLE IF NOT EXISTS capture_settings (project TEXT PRIMARY KEY, interval INTEGER NOT NULL CHECK(interval BETWEEN 1 AND 100))"
        )
        if interval is not None:
            if type(interval) is not int or not 1 <= interval <= 100:
                raise ValueError("interval must be between 1 and 100")
            db.execute(
                "INSERT INTO capture_settings(project,interval) VALUES(?,?) ON CONFLICT(project) DO UPDATE SET interval=excluded.interval",
                (project, interval),
            )
            db.commit()
        row = db.execute(
            "SELECT interval FROM capture_settings WHERE project=?", (project,)
        ).fetchone()
        return {"project": project, "interval": row[0] if row else 5}


@mcp.tool(
    name="bm_capture_settings", description="Read or update the project batch capture interval."
)
async def capture_settings(
    project: Annotated[str, Field(min_length=1, max_length=128)],
    command: Literal["get", "set"] = "get",
    interval: Annotated[int | None, Field(ge=1, le=100)] = None,
) -> dict[str, object]:
    if command == "set" and interval is None:
        raise ValueError("set requires interval")
    root = Path(os.environ.get("BASIC_MEMORY_CONFIG_DIR", str(Path.home() / ".basic-memory")))
    return await asyncio.to_thread(
        _setting, root / "capture-state.sqlite3", project, interval if command == "set" else None
    )


@mcp.tool(
    name="bm_capture_turn",
    description="Record an agent session turn idempotently and determine whether a batch review is due. No conversation content is stored.",
)
async def capture_turn(
    agent: Annotated[str, Field(min_length=1, max_length=128)],
    project: Annotated[str, Field(min_length=1, max_length=128)],
    scope: Annotated[str, Field(min_length=1, max_length=256)],
    session: Annotated[str, Field(min_length=1, max_length=256)],
    turn: Annotated[str, Field(min_length=1, max_length=256)],
    interval: Annotated[int, Field(ge=1, le=100)] = 5,
) -> dict[str, object]:
    """Record only opaque identifiers, never conversation text or credentials."""
    root = Path(os.environ.get("BASIC_MEMORY_CONFIG_DIR", str(Path.home() / ".basic-memory")))
    return await asyncio.to_thread(
        _record_turn, root / "capture-state.sqlite3", agent, project, scope, session, turn, interval
    )
