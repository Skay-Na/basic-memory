#!/usr/bin/env python3
"""Antigravity lifecycle hooks for Basic Memory backend.

Events supported:
- PreInvocation:
  1. Extracts the latest user prompt and turn_id from the transcript;
  2. Filters out trivial acknowledgments and short command pastes;
  3. Queries Basic Memory (via loopback HTTP proxy 127.0.0.1:18894/mcp with stdio fallback)
     for relevant memories, excluding inbox/pending_review/superseded noise and notes
     already injected in this session, and records local_recall_turns AFTER successful query;
  4. Synchronizes the user turn with the remote capture state ledger (bm_capture_turn)
     with local SQLite outbox fallback, and when review_due is true, checks
     bm_memory_maintenance(status) and injects same-turn instructions via ephemeralMessage
     so the agent can silently complete semantic capture and bounded maintenance before
     its final answer (no disruptive post-answer Stop continuation).
- Stop:
  1. Ignores abnormal terminations (USER_CANCELED, ERROR, etc.);
  2. Flushes any pending outbox items when a turn completes normally without forcing a new turn.
"""

from __future__ import annotations

import json
import logging
import os
import re
import select
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

PROJECT = "main"
AGENT = "antigravity"
PLUGIN_CONFIG_FILE = Path(__file__).resolve().parent.parent / "plugin.json"
DEFAULT_TOKEN_FILE = Path.home() / ".codex/secrets/basic-memory-router-access-token"


def get_configured_project() -> str:
    try:
        data = json.loads(PLUGIN_CONFIG_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            bm = data.get("basicMemory")
            if isinstance(bm, dict):
                proj = bm.get("primaryProject")
                if isinstance(proj, str) and proj.strip():
                    return proj.strip()
            proj = data.get("project")
            if isinstance(proj, str) and proj.strip():
                return proj.strip()
    except Exception:
        pass
    return PROJECT
BRIDGE_SCRIPT = Path.home() / ".codex/basic-memory/bridge.py"
LOCAL_PROXY_URL = "http://127.0.0.1:18894/mcp"
DEFAULT_STATE_DIR = Path.home() / ".gemini/antigravity/memory"
STATE_DB_PATH = DEFAULT_STATE_DIR / "reviews.sqlite3"
MCP_SCHEMA_DIR = Path.home() / ".gemini/antigravity/mcp/basic-memory"
REVIEW_TTL_SECONDS = 7 * 24 * 60 * 60
RECALL_MAX_RESULTS = 5
RECALL_MIN_SIMILARITY = 0.60
HTTP_TIMEOUT_SECONDS = 4.0
STDIO_TIMEOUT_SECONDS = 6.0

# Trivial/acknowledgment prompts that should not trigger semantic search
TRIVIAL_PROMPT_RE = re.compile(
    r"^(?:"
    r"ok|okay|yes|no|yep|nope|sure|thanks|thank you|continue|go ahead|proceed|done|good|great|nice"
    r"|好的|好|行|可以|没问题|继续|谢谢|收到|明白|知道了|确认|同意|按这个来|开始吧|立即修复|认可审查结论.*"
    r"|[1234567890a-zA-Z\s,，.。!！?？/+-]{1,12}"
    r")$",
    re.IGNORECASE,
)

logging.basicConfig(level=logging.ERROR, stream=sys.stderr)
logger = logging.getLogger("antigravity-basic-memory")


def ensure_state_db() -> sqlite3.Connection:
    DEFAULT_STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    conn = sqlite3.connect(STATE_DB_PATH, timeout=3)
    with conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS local_turn_ledger (
                session_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                synced INTEGER NOT NULL DEFAULT 0,
                review_prompted INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL,
                PRIMARY KEY(session_id, turn_id)
            )
            """
        )
        cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(local_turn_ledger)").fetchall()
        }
        if "synced" not in cols:
            conn.execute(
                "ALTER TABLE local_turn_ledger ADD COLUMN synced INTEGER NOT NULL DEFAULT 1"
            )
        if "review_prompted" not in cols:
            conn.execute(
                "ALTER TABLE local_turn_ledger ADD COLUMN review_prompted INTEGER NOT NULL DEFAULT 0"
            )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS local_recall_turns (
                session_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                created_at REAL NOT NULL,
                PRIMARY KEY(session_id, turn_id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS session_recalled_notes (
                session_id TEXT NOT NULL,
                permalink TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                PRIMARY KEY(session_id, permalink)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS capture_settings_cache (
                project TEXT PRIMARY KEY,
                interval INTEGER NOT NULL
            )
            """
        )
        # Periodic cleanup of records older than 30 days
        cutoff = time.time() - 30 * 24 * 3600
        conn.execute("DELETE FROM local_turn_ledger WHERE created_at < ?", (cutoff,))
        conn.execute("DELETE FROM local_recall_turns WHERE created_at < ?", (cutoff,))
        conn.execute("DELETE FROM session_recalled_notes WHERE created_at < ?", (cutoff,))
    return conn


class HttpProxyMcpClient:
    """Fast Streamable HTTP client talking to the local loopback SakuraFrp proxy."""

    def __init__(self, endpoint: str = LOCAL_PROXY_URL, timeout: float = HTTP_TIMEOUT_SECONDS) -> None:
        self.endpoint = endpoint
        self.timeout = timeout
        self.session_id: str | None = None
        self.next_id = 1
        self._initialize()

    def _request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        req_id = self.next_id
        self.next_id += 1
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            payload["params"] = params
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        req = urllib.request.Request(
            self.endpoint, json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers=headers
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            self.session_id = resp.headers.get("Mcp-Session-Id", self.session_id)
            body = resp.read().decode("utf-8", errors="replace").strip()
        if body.startswith("event:"):
            data_lines = [
                line[5:].strip() for line in body.splitlines() if line.startswith("data:")
            ]
            if data_lines:
                body = data_lines[-1]
        res = json.loads(body) if body else {}
        if "error" in res:
            raise RuntimeError(f"MCP error on {method}: {res['error']}")
        return res.get("result", {})

    def _notify(self, method: str) -> None:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        req = urllib.request.Request(
            self.endpoint,
            json.dumps({"jsonrpc": "2.0", "method": method}).encode("utf-8"),
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=self.timeout):
            pass

    def _initialize(self) -> None:
        self._request(
            "initialize",
            {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "antigravity-basic-memory-hook", "version": "1.2"},
            },
        )
        self._notify("notifications/initialized")

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return self._request("tools/call", {"name": name, "arguments": arguments})

    def close(self) -> None:
        pass


class StdioMcpClient:
    """Fallback client invoking tools via the stdio bridge to Basic Memory with read timeout."""

    def __init__(self, timeout: float = STDIO_TIMEOUT_SECONDS) -> None:
        if not BRIDGE_SCRIPT.exists():
            raise RuntimeError(f"Basic Memory bridge script not found at {BRIDGE_SCRIPT}")
        self.timeout = timeout
        self.proc = subprocess.Popen(
            ["/opt/homebrew/bin/python3", str(BRIDGE_SCRIPT)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.next_id = 1
        try:
            self._initialize()
        except Exception:
            self.close()
            raise

    def _send(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.proc.stdin or not self.proc.stdout:
            raise RuntimeError("Bridge subprocess not initialized")
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        ready, _, _ = select.select([self.proc.stdout], [], [], self.timeout)
        if not ready:
            raise TimeoutError(f"Bridge stdio read timed out after {self.timeout}s")
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("Bridge closed stream unexpectedly")
        return json.loads(line)

    def _initialize(self) -> None:
        init_res = self._send(
            {
                "jsonrpc": "2.0",
                "id": self.next_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "antigravity-basic-memory-hook", "version": "1.2"},
                },
            }
        )
        self.next_id += 1
        if "error" in init_res:
            raise RuntimeError(f"MCP init error: {init_res['error']}")
        if self.proc.stdin:
            self.proc.stdin.write(
                json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"
            )
            self.proc.stdin.flush()

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        req_id = self.next_id
        self.next_id += 1
        res = self._send(
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }
        )
        if "error" in res:
            raise RuntimeError(f"Tool {name} error: {res['error']}")
        return res.get("result", {})

    def close(self) -> None:
        try:
            if self.proc.poll() is None:
                self.proc.terminate()
                self.proc.wait(timeout=1)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass


def create_mcp_client() -> Any:
    """Prefer fast loopback HTTP proxy; fall back to stdio bridge if proxy is unreachable."""
    try:
        return HttpProxyMcpClient()
    except Exception:
        return StdioMcpClient()


def extract_user_request(raw: str) -> str:
    if "<USER_REQUEST>" in raw and "</USER_REQUEST>" in raw:
        raw = raw.split("<USER_REQUEST>", 1)[1].split("</USER_REQUEST>", 1)[0]
    return raw.strip()


def get_latest_turn(transcript_path: str) -> tuple[str, str, str]:
    """Returns (user_text, assistant_text, turn_id)."""
    if not transcript_path or not os.path.exists(transcript_path):
        return "", "", ""
    last_user = ""
    last_assistant = ""
    step_idx = -1
    try:
        with open(transcript_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    step_type = entry.get("type")
                    if step_type == "USER_INPUT" and entry.get("content"):
                        last_user = entry["content"]
                        last_assistant = ""
                        step_idx = entry.get("step_index", step_idx)
                    elif step_type == "PLANNER_RESPONSE" and entry.get("content"):
                        last_assistant = entry["content"]
                except Exception:
                    pass
    except Exception as e:
        logger.error("Read transcript error: %s", e)

    last_user = extract_user_request(last_user)
    turn_id = f"turn-{step_idx}" if step_idx >= 0 else ""
    return last_user, last_assistant.strip(), turn_id


def is_meaningful_query(query: str) -> bool:
    """Filter out short/trivial acknowledgments and pure shell/command pastes."""
    cleaned = query.strip()
    if len(cleaned) < 8:
        return False
    if TRIVIAL_PROMPT_RE.match(cleaned):
        return False
    return True


def is_recall_eligible_note(item: dict[str, Any]) -> bool:
    """Exclude raw unreviewed inbox transcripts and superseded notes from auto-recall."""
    if not isinstance(item, dict):
        return False
    permalink = str(item.get("permalink") or "")
    file_path = str(item.get("file_path") or "")
    if "/inbox/" in f"/{permalink}/" or "/inbox/" in f"/{file_path}/":
        return False
    metadata = item.get("metadata")
    if isinstance(metadata, dict):
        status = str(metadata.get("status") or "").lower()
        if status in {"pending_review", "superseded", "archived", "expired"}:
            return False
    content = str(item.get("matched_chunk") or item.get("content") or "")
    if "status: pending_review" in content or "status: superseded" in content:
        return False
    return True


def parse_json_tool_result(result: dict[str, Any]) -> dict[str, Any]:
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        inner = structured.get("result", structured)
        if isinstance(inner, dict):
            return inner
        if isinstance(inner, str):
            try:
                return json.loads(inner)
            except Exception:
                pass
    for block in result.get("content", []):
        if isinstance(block, dict) and block.get("type") == "text":
            try:
                return json.loads(block.get("text", "{}"))
            except Exception:
                pass
    return {}


def build_capture_and_maintenance_prompt(
    interval: int,
    capture_due: bool,
    maintenance_status: dict[str, Any] | None,
    project: str | None = None,
) -> str:
    sections: list[str] = []
    schema_dir = str(MCP_SCHEMA_DIR)
    active_project = project or get_configured_project()

    if capture_due:
        sections.append(
            f"### 📝 Basic Memory 周期语义捕捉（每 {interval} 轮触发）\n"
            "请先正常处理并回答用户的当前请求；在输出最终回复前，静默检查最近几轮对话中用户确认的**长期事实、架构偏好、环境约束与重要技术决策**：\n"
            f"- **Lazy MCP 调用方式**：若尚未读取对应工具 schema，先用 `read_file` 读取 `{schema_dir}/search_notes.json`、`write_note.json` 或 `edit_note.json`，再通过 `call_mcp_tool(ServerName=\"basic-memory\", ToolName=..., Arguments=...)` 调用；所有调用必须显式传入 `\"project\": \"{active_project}\"`。\n"
            "- **先查重再写入**：写入前必须先调用 `search_notes` 或 `read_note` 核对已有笔记；若已有同类笔记，优先用 `edit_note`（附带读取到的 `expected_checksum`）原位更新，避免重复创建。\n"
            "- **目录规范**：新偏好/环境事实保存至 `directory=\"antigravity/remember\"`，技术/架构决策保存至 `directory=\"antigravity/decisions\"`（设置 `overwrite=False`）。\n"
            "- **静默原则**：若本阶段没有需要持久保存的新信息，无需写入任何笔记，也无需在回复中专门提及本次常规检查。"
        )

    if isinstance(maintenance_status, dict) and maintenance_status.get("due") is True:
        after_pos = maintenance_status.get("after_position", 0)
        through_pos = maintenance_status.get("through_position", 0)
        reason = maintenance_status.get("reason") or "threshold"
        changed_notes = maintenance_status.get("changed_notes") or []
        note_lines: list[str] = []
        all_ids: list[str] = []
        for item in changed_notes:
            if not isinstance(item, dict):
                continue
            ext_id = str(item.get("external_id") or "")
            permalink = str(item.get("permalink") or "")
            title = str(item.get("title") or "")
            op = str(item.get("operation") or "")
            if ext_id:
                all_ids.append(ext_id)
            note_lines.append(
                f"  - `external_id`: `{ext_id}` | `operation`: `{op}` | `permalink`: `{permalink}` | `title`: {title}"
            )

        notes_block = "\n".join(note_lines) if note_lines else "  - （无变更笔记，仅时间阈值到期）"
        ids_json = json.dumps(all_ids, ensure_ascii=False)

        sections.append(
            f"### 🧹 Basic Memory 自动记忆整理到期（触发原因：`{reason}`，水位 `{after_pos} -> {through_pos}`）\n"
            "项目记忆维护已到期。请在本轮完成用户请求后、输出最终回复前，**静默整理以下有界批次笔记**（不要向用户发送整理计划或请求常规确认）：\n"
            f"{notes_block}\n\n"
            "**整理规则与完成回执**：\n"
            "1. **已删除笔记处理**：对于 `operation` 为 `deleted` 的记录，笔记已被删除，**切勿调用 `read_note` 读取**，直接将其 `external_id` 纳入完成列表即可。\n"
            "2. **标题与元数据核对**：对于非删除笔记，用 `read_note` 读取正文（尤其注意 `*/inbox/*` 待审笔记），检查标题是否能脱离对话上下文准确概括核心主题（≤80字符，禁止直接复制/截断用户原话或保留泛化前缀）。若标题不合格，使用 `edit_note`（传入 `find_replace` 替换首个 H1、同步 `metadata: {\"title\": \"新标题\", \"status\": \"active\"}` 并附带 `expected_checksum`）原位修正，**保留原文件路径与 permalink，不要移动或删除笔记**。已有合格标题保持不动。\n"
            f"3. **提交 Complete 回执**：全部审阅完成后，读取 `{schema_dir}/bm_memory_maintenance.json` 并调用 `call_mcp_tool(ServerName=\"basic-memory\", ToolName=\"bm_memory_maintenance\", Arguments={{\"command\": \"complete\", \"project\": \"{active_project}\", \"expected_after_position\": {after_pos}, \"through_position\": {through_pos}, \"reviewed_note_ids\": {ids_json}}})`。\n"
            "4. **安全中止**：若某篇非删除笔记无法安全读取或整理，保留原文且**本轮不要调用 `complete`**，留待后续回合重试。"
        )

    return "\n\n".join(sections)


def sync_turn_and_check_due(
    conn: sqlite3.Connection,
    client: Any,
    session_id: str,
    turn_id: str,
    scope: str,
    project: str | None = None,
) -> tuple[int, bool, dict[str, Any] | None]:
    """Synchronizes turn count idempotently and checks if capture or maintenance is due."""
    active_project = project or get_configured_project()
    with conn:
        row = conn.execute(
            "SELECT synced, review_prompted FROM local_turn_ledger WHERE session_id = ? AND turn_id = ?",
            (session_id, turn_id),
        ).fetchone()
        if row is not None and row[1] == 1:
            return 5, False, None
        if row is None:
            conn.execute(
                "INSERT INTO local_turn_ledger (session_id, turn_id, synced, review_prompted, created_at) VALUES (?, ?, 0, 0, ?)",
                (session_id, turn_id, time.time()),
            )
        cached_row = conn.execute(
            "SELECT interval FROM capture_settings_cache WHERE project = ?", (active_project,)
        ).fetchone()
        interval = int(cached_row[0]) if cached_row else 5

    review_due = False
    maintenance_status: dict[str, Any] | None = None

    try:
        # Flush up to 3 unsynced turns for this session in order
        unsynced = conn.execute(
            "SELECT turn_id FROM local_turn_ledger WHERE session_id = ? AND synced = 0 ORDER BY created_at ASC LIMIT 3",
            (session_id,),
        ).fetchall()
        for (pending_turn_id,) in unsynced:
            turn_res = client.call_tool(
                "bm_capture_turn",
                {
                    "agent": AGENT,
                    "project": active_project,
                    "scope": scope,
                    "session": session_id,
                    "turn": pending_turn_id,
                    "interval": interval,
                },
            )
            parsed_turn = parse_json_tool_result(turn_res)
            if isinstance(parsed_turn.get("interval"), int) and 1 <= parsed_turn["interval"] <= 100:
                interval = parsed_turn["interval"]
                with conn:
                    conn.execute(
                        "INSERT INTO capture_settings_cache (project, interval) VALUES (?, ?) ON CONFLICT(project) DO UPDATE SET interval = excluded.interval",
                        (active_project, interval),
                    )
            with conn:
                conn.execute(
                    "UPDATE local_turn_ledger SET synced = 1 WHERE session_id = ? AND turn_id = ?",
                    (session_id, pending_turn_id),
                )
            if pending_turn_id == turn_id:
                review_due = bool(parsed_turn.get("review_due", False))
    except Exception as e:
        logger.error("Remote turn sync error (falling back to local count): %s", e)
        local_count = conn.execute(
            "SELECT count(*) FROM local_turn_ledger WHERE session_id = ?", (session_id,)
        ).fetchone()[0]
        review_due = (local_count > 0) and (local_count % interval == 0)

    if review_due:
        try:
            maint_res = client.call_tool(
                "bm_memory_maintenance",
                {"command": "status", "project": active_project, "batch_size": 20},
            )
            parsed_maint = parse_json_tool_result(maint_res)
            if isinstance(parsed_maint, dict) and parsed_maint.get("due") is True:
                maintenance_status = parsed_maint
        except Exception as e:
            logger.error("Maintenance status check failed: %s", e)

        with conn:
            conn.execute(
                "UPDATE local_turn_ledger SET review_prompted = 1 WHERE session_id = ? AND turn_id = ?",
                (session_id, turn_id),
            )

    return interval, review_due, maintenance_status


def handle_pre_invocation(payload: dict[str, Any]) -> dict[str, Any]:
    session_id = payload.get("conversationId", "")
    workspace_paths = payload.get("workspacePaths", [])
    scope = workspace_paths[0] if workspace_paths else "default"
    transcript_path = payload.get("transcriptPath", "")
    user_prompt, _, turn_id = get_latest_turn(transcript_path)

    if not session_id or not turn_id or not user_prompt:
        return {"injectSteps": []}

    active_project = get_configured_project()
    conn = None
    client = None
    inject_steps: list[dict[str, Any]] = []

    try:
        conn = ensure_state_db()
        already_recalled = (
            conn.execute(
                "SELECT 1 FROM local_recall_turns WHERE session_id = ? AND turn_id = ?",
                (session_id, turn_id),
            ).fetchone()
            is not None
        )
        already_prompted_row = conn.execute(
            "SELECT review_prompted FROM local_turn_ledger WHERE session_id = ? AND turn_id = ?",
            (session_id, turn_id),
        ).fetchone()
        already_checked_turn = already_prompted_row is not None

        # Fast exit if this turn was already processed in a previous PreInvocation step of the same turn
        if already_recalled and already_checked_turn:
            return {"injectSteps": []}

        # 1. Auto-Recall (only on first PreInvocation of a meaningful query)
        if not already_recalled:
            if not is_meaningful_query(user_prompt):
                with conn:
                    conn.execute(
                        "INSERT OR REPLACE INTO local_recall_turns (session_id, turn_id, created_at) VALUES (?, ?, ?)",
                        (session_id, turn_id, time.time()),
                    )
            else:
                seen_rows = conn.execute(
                    "SELECT permalink, updated_at FROM session_recalled_notes WHERE session_id = ?",
                    (session_id,),
                ).fetchall()
                seen_notes = {r[0]: r[1] for r in seen_rows}

                client = create_mcp_client()
                result = client.call_tool(
                    "search_notes",
                    {
                        "query": user_prompt[:500],
                        "project": active_project,
                        "page_size": 10,
                        "min_similarity": RECALL_MIN_SIMILARITY,
                        "output_format": "json",
                    },
                )
                # Mark turn as recalled ONLY after search_notes succeeds so transient network errors can retry
                with conn:
                    conn.execute(
                        "INSERT OR REPLACE INTO local_recall_turns (session_id, turn_id, created_at) VALUES (?, ?, ?)",
                        (session_id, turn_id, time.time()),
                    )

                data = parse_json_tool_result(result)
                raw_results = data.get("results", []) if isinstance(data, dict) else []

                fresh_items: list[dict[str, Any]] = []
                for item in raw_results:
                    if not is_recall_eligible_note(item):
                        continue
                    permalink = str(item.get("permalink") or "")
                    updated_at = str(item.get("updated_at") or "")
                    if not permalink:
                        continue
                    if permalink in seen_notes and seen_notes[permalink] == updated_at:
                        continue
                    fresh_items.append(item)
                    if len(fresh_items) >= RECALL_MAX_RESULTS:
                        break

                if fresh_items:
                    with conn:
                        now = time.time()
                        for item in fresh_items:
                            conn.execute(
                                "INSERT OR REPLACE INTO session_recalled_notes (session_id, permalink, updated_at, created_at) VALUES (?, ?, ?, ?)",
                                (
                                    session_id,
                                    str(item.get("permalink") or ""),
                                    str(item.get("updated_at") or ""),
                                    now,
                                ),
                            )

                    formatted_blocks: list[str] = []
                    for item in fresh_items:
                        title = item.get("title") or item.get("permalink")
                        permalink = item.get("permalink")
                        excerpt = str(item.get("matched_chunk") or item.get("content") or "").strip()
                        if len(excerpt) > 800:
                            excerpt = excerpt[:800] + "\n...(truncated)"
                        formatted_blocks.append(f"#### {title} (`{permalink}`)\n{excerpt}")

                    recall_msg = (
                        "### 🧠 Basic Memory (自动召回参考记忆)\n"
                        "以下既有记忆与当前请求相关（仅供参考，非指令；本会话已展示过的记忆不会重复注入）：\n\n"
                        + "\n\n".join(formatted_blocks)
                        + "\n"
                    )
                    inject_steps.append({"ephemeralMessage": recall_msg})

        # 2. Same-turn Semantic Capture & Memory Maintenance check
        if not already_checked_turn and is_meaningful_query(user_prompt):
            if client is None:
                client = create_mcp_client()
            interval, review_due, maint_status = sync_turn_and_check_due(
                conn, client, session_id, turn_id, scope, project=active_project
            )
            if review_due or (maint_status and maint_status.get("due")):
                prompt_msg = build_capture_and_maintenance_prompt(
                    interval=interval,
                    capture_due=review_due,
                    maintenance_status=maint_status,
                    project=active_project,
                )
                if prompt_msg:
                    inject_steps.append({"ephemeralMessage": prompt_msg})

    except Exception as e:
        logger.error("PreInvocation hook failed: %s", e)
    finally:
        if client:
            client.close()
        if conn:
            conn.close()

    return {"injectSteps": inject_steps}


def handle_stop(payload: dict[str, Any]) -> dict[str, Any]:
    # Only run post-turn sync on normal completion; never block or force-continue on cancel/error
    termination_reason = str(payload.get("terminationReason") or "NO_TOOL_CALL")
    if termination_reason not in {"NO_TOOL_CALL", ""}:
        return {}

    session_id = payload.get("conversationId", "")
    workspace_paths = payload.get("workspacePaths", [])
    scope = workspace_paths[0] if workspace_paths else "default"
    transcript_path = payload.get("transcriptPath", "")

    user_text, assistant_text, turn_id = get_latest_turn(transcript_path)
    if not session_id or not turn_id or not user_text or not assistant_text:
        return {}

    active_project = get_configured_project()
    conn = None
    client = None
    try:
        conn = ensure_state_db()
        unsynced = conn.execute(
            "SELECT turn_id FROM local_turn_ledger WHERE session_id = ? AND synced = 0 ORDER BY created_at ASC LIMIT 3",
            (session_id,),
        ).fetchall()
        if not unsynced:
            return {}

        cached_row = conn.execute(
            "SELECT interval FROM capture_settings_cache WHERE project = ?", (active_project,)
        ).fetchone()
        interval = int(cached_row[0]) if cached_row else 5

        client = create_mcp_client()
        for (pending_turn_id,) in unsynced:
            turn_res = client.call_tool(
                "bm_capture_turn",
                {
                    "agent": AGENT,
                    "project": active_project,
                    "scope": scope,
                    "session": session_id,
                    "turn": pending_turn_id,
                    "interval": interval,
                },
            )
            parsed_turn = parse_json_tool_result(turn_res)
            if isinstance(parsed_turn.get("interval"), int) and 1 <= parsed_turn["interval"] <= 100:
                interval = parsed_turn["interval"]
                with conn:
                    conn.execute(
                        "INSERT INTO capture_settings_cache (project, interval) VALUES (?, ?) ON CONFLICT(project) DO UPDATE SET interval = excluded.interval",
                        (active_project, interval),
                    )
            with conn:
                conn.execute(
                    "UPDATE local_turn_ledger SET synced = 1 WHERE session_id = ? AND turn_id = ?",
                    (session_id, pending_turn_id),
                )
    except Exception as e:
        logger.error("Stop turn sync failed: %s", e)
    finally:
        if client:
            client.close()
        if conn:
            conn.close()

    return {}


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}

    result: dict[str, Any] = {}
    if mode == "pre-invocation":
        result = handle_pre_invocation(payload)
    elif mode == "stop":
        result = handle_stop(payload)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        logger.error("Fatal hook exception: %s", exc)
        print(json.dumps({}))
        sys.exit(0)
