# Basic Memory for WorkBuddy

This WorkBuddy integration combines an HTTPS Streamable HTTP MCP connector, two Skills, and command lifecycle hooks. MCP performs memory operations; Skills make the semantic decision; hooks inject a batched review marker, keep local receipts, and recover unfinished reviews.

## Install

Import `connector-meta.json`, `mcp.json`, `token-schema.json`, `icon.svg`, and the complete `skills/` directory as a WorkBuddy connector package or zip them for submission through the WorkBuddy Open Platform. Configure lifecycle hooks separately; the WorkBuddy Enterprise settings fragment is not part of the MCP connector package.

The connector token form stores its credential in WorkBuddy. A command hook cannot read that form value, so provide the same Basic Memory-only bearer token to the hook in `~/.workbuddy/secrets/basic-memory-router-access-token` (mode `0600`). Set `BASIC_MEMORY_TOKEN_FILE` to use another private file. The hook endpoint can be changed with `BASIC_MEMORY_MCP_URL`. Do not put credentials in hook settings or command arguments.

After connecting, perform a read-only check: enumerate MCP tools, then search `main` for a known project note. Do not create a test note unless specifically requested.

## MCP write contract

The Basic Memory MCP server already provides the contract this integration needs; this package does not change the shared server or Codex behavior:

- Search with `search_type: "text"` and read before creating or updating a note. Create with `overwrite: false` and `output_format: "json"`. Text search does not guarantee finding every semantic duplicate.
- For an update, read the current checksum and pass it as `expected_checksum`; never use an unconditional overwrite for durable memory.
- Successful JSON results identify `created`/`updated` and return the note path/permalink and checksum. Conflicts and refused writes are MCP tool errors with structured error codes, such as `NOTE_ALREADY_EXISTS` and `NOTE_REVISION_CONFLICT`.
- After a timeout or unknown result, search/read to determine whether the write landed before retrying.
- Default captures use project `main`, `workbuddy/memories` or `workbuddy/decisions`, and source `workbuddy`. The Skill asks the agent to pass `project: "main"` explicitly. This is an agent-level scope rule, not a server-side project ACL.

These existing MCP operations are backward compatible with Codex. WorkBuddy-specific packaging and hook state do not change Codex's tool names or invocation behavior. Notes saved to the shared `main` project remain searchable by any agent with access to that project.

## Skills

- `skills/basic-memory/SKILL.md` explains normal recall and user-directed memory operations.
- `skills/basic-memory-capture/SKILL.md` is invoked by the lifecycle review marker. It filters the current turn, checks for duplicates, writes only durable information, and submits a local receipt.

## Lifecycle hooks

The separate [`hooks/`](hooks/) directory contains the handler and settings fragment for the event contract in Tencent's [WorkBuddy Enterprise Hooks manual](https://cloud.tencent.com/document/product/1831/134517):

- `SessionStart` recalls recent project decisions and prompts recovery of due reviews.
- `UserPromptSubmit` recalls the current topic and every five submissions per session creates a local `collecting` receipt with a `basic-memory-review` marker. Set `BASIC_MEMORY_CAPTURE_INTERVAL` to an integer from 1 to 100 to change the interval. The review covers the latest batch; a shorter final batch is not automatically reviewed. WorkBuddy does not provide a reliable turn ID, so duplicate hook submissions count separately. The Skill completes semantic review before the answer and submits `saved`, `no_memory`, or `pending`.
- `Stop` marks a missing receipt `unresolved` and returns without blocking the response or creating a visible continuation.
- `PreCompact` adds compacting guidance for confirmed decisions and outstanding review ids; it does not upload the transcript.
- `SessionEnd` marks unfinished reviews `unresolved`; it does not upload raw session text.
- Pending drafts are stored in `~/.workbuddy/basic-memory/reviews.sqlite3` with user-only permissions and retried on a later turn in the same working directory and project after backoff. Each selected retry receives a short lease, allowing later records to progress even if the agent cannot recover it. Permission failures suspend automatic retry until credentials are repaired and `python3 /ABSOLUTE/PATH/TO/basic-memory/integrations/workbuddy/hooks/hook.py retry <review-id>` re-enables it.
- The seven-day retention limit is enforced lazily on later review operations, not by a background service. Run `python3 /ABSOLUTE/PATH/TO/basic-memory/integrations/workbuddy/hooks/hook.py cleanup` to clear expired pending/unresolved content on demand; without a later hook or scheduled cleanup, content can remain beyond seven days. `BASIC_MEMORY_WORKBUDDY_STATE_DIR` overrides the local state directory.
- Hook failures are fail-open. If MCP recall fails, the prompt review marker is still emitted when local state is available.

Merge `hooks/settings.hooks.template.json` into `~/.codebuddy/settings.json` without replacing existing hook entries. Replace `/ABSOLUTE/PATH/TO/basic-memory` with this checkout's absolute path. Project-level and user-level settings are described by the manual. Restart WorkBuddy after changing hook settings.

The hook and connector still use separate local token configuration. The connector's token form is not exposed to hook processes. No credentials are included in this repository.

The official hook manual describes CodeBuddy IDE events and inputs/outputs but does not specify a reliable transcript turn identity. For an unresolved review, the hook exposes only the prompt captured at submission and reports `transcript_status: "unverified"`; it does not infer an assistant answer from transcript text. The review stays unresolved if the prompt and other available evidence are insufficient. The integration has not yet been run inside the target WorkBuddy client; confirm `/hooks` loading, Skill invocation, local shell availability for receipt commands, and the target client's transcript format before relying on it.

## References

- [WorkBuddy Connector documentation](https://open.workbuddy.cn/en/docs/connector)
- [WorkBuddy Enterprise Hooks manual](https://cloud.tencent.com/document/product/1831/134517)
- Project service status and access constraints: [`deployment/运行说明.md`](../../../deployment/运行说明.md)
- Agent connection guide: [`deployment/Agent自托管记忆后端接入指南.md`](../../../deployment/Agent自托管记忆后端接入指南.md)

Remote state is enabled by default through the existing MCP connection; `BASIC_MEMORY_STATE_BACKEND=local` opts out. A private local SQLite outbox temporarily retains unsent operations and retries on later hook activity. Due remote pending reviews are restored; permission failures stay paused until explicitly resumed. Unsent review content expires after seven days and is marked as unconfirmed. The host lacks a reliable turn ID, so duplicate prompt hook invocations can still count twice.
