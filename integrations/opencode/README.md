# Basic Memory for OpenCode

The adapter connects to an explicitly configured remote Basic Memory MCP project and ships two host implementations that expose the same behavior: a V1 `server()` export for OpenCode 1.x and a V2 `Plugin.define` export for OpenCode 2.x. Both do per-turn recall, per-batch semantic review, receipt mirroring and explicit transcript capture.

The host version decides which export runs: the OpenCode 2.2.0 desktop app loads only the V2 export, while the `opencode` 1.18.30 CLI uses V1. The two paths share the review ledger, the MCP client and the review operations, so `stateBackend`, `semanticCaptureInterval` and the receipt tools behave the same in both.

## Configuration

Load this package as a local plugin (or install it as a package) with an explicit endpoint, private bearer-token file and project:

```json
{
  "plugin": [["file:///absolute/path/to/integrations/opencode", {
    "endpoint": "https://your-host.example/basicmemory/mcp",
    "tokenFile": "~/.config/basic-memory/token",
    "project": "main"
  }]]
}
```

The endpoint must use HTTPS except for loopback HTTP. The token file cannot be readable by group or others. The plugin uses Python 3 and SQLite for the review ledger, and does not use the local `bm` CLI. The project may also register the authenticated MCP bridge separately to expose the full Basic Memory tool set.

The `file://` entry must point at the package directory, not at `src/index.ts`: OpenCode 1.18.30 rejects a file target with `configured plugin path must be a directory` and silently loads no plugin.

## Behavior

- Each user turn searches the configured project for relevant notes using the user message, with hybrid-to-text fallback. Results are bounded and marked as untrusted reference data. `bm_recall` performs focused searches. Search failure does not prevent review or answering.
- Every five user turns in a session get one semantic review ID (configurable with `semanticCaptureInterval`, 1–100). The review covers the latest batch; a shorter final batch is not automatically reviewed. The model is instructed to assess confirmed durable facts, preferences, constraints and decisions, search for duplicates, read candidates with `bm_read`, save with `bm_review_save`, or edit with `bm_review_edit` and a checksum. `bm_review_complete` records `saved`, `no_memory`, or `pending`. Saved references must have been verified by a successful read or write. The model can still omit the review or misclassify information.
- A local private SQLite ledger is stored at `~/.local/share/opencode/basic-memory/reviews.sqlite3`. Incomplete reviews become `unresolved` on session idle or the next user message. Pending and unresolved reviews are offered on a later turn in the same project and workspace, with backoff; there is no background retry. Unfinished content is removed after seven days on the next ledger operation. Unresolved records retain the user message, not the assistant response. A failed or ambiguous write may already have created a note; search before retrying.
- Automatic raw transcript uploads are disabled. `bm_capture` explicitly writes a full extractive transcript as a new `pending_review` note in `opencode/inbox` without overwriting existing notes. It may contain sensitive conversation text. `captureFolder` changes the folder. Setting `autoCapture: true` is rejected.

`autoRecall: false` disables automatic search but leaves semantic review enabled. An active model must support tools and follow the review instructions; a receipt only confirms the recorded status and verified references, not the quality of the model's judgment.

## V2 host mapping

The V2 adapter maps the same workflow onto OpenCode 2.x hooks:

- `ctx.session.hook("context")` replaces `experimental.chat.system.transform`. It reads the last user message from `event.messages`, counts the turn, opens a review when the batch boundary is reached, and appends both the review instruction and the recall block to `event.system`.
- Turn identity is the user message ID, so re-entrant context requests for the same message reuse the prepared turn instead of double counting. Messages without an ID are skipped rather than guessed.
- Review tools (`bm_read`, `bm_review_save`, `bm_review_edit`, `bm_review_complete`) plus `bm_recall` and `bm_capture` are registered through `ctx.tool.transform` with JSON Schema inputs; each call resolves the workspace directory from `ctx.session.get`.
- `ctx.event.subscribe` on `session.idle` closes any review still collecting, mirroring the V1 `event` handler.
- The V1 `semanticCaptureInterval` fallback and the remote ordinal both come from the shared ledger, so a session switch between hosts keeps the same counting semantics.

## Local deployment and verification

The Mac configuration uses the source checkout via a local file URL and the existing token file. It removes the obsolete Supermemory plugin and retains other configured plugins. Restart OpenCode to reload configuration; the checkout and its dependencies must remain present. Configuration backups are under `~/.local/share/memory-backend/opencode-pre-basic-memory-20261028/`.

Run `npm ci`, `npx tsc --noEmit`, and `npx tsx --test tests/integration.test.ts tests/v2.test.ts`. The V2 suite drives the real `Plugin.define` setup with a fake host context and a local MCP server, covering single counting per message, the batch boundary instruction, all four review tools, and the idle receipt. The V1 suite covers authenticated mock MCP fallback, write safeguards, scoped ledger state and receipt validation. OpenCode 1.18.30 with GLM-5.3 Flash Free successfully invoked real recall, explicit test-note creation, and no_memory/saved receipts against the live service; test notes were deleted. OpenCode 2.2.0 desktop loads the V2 export with the six tools and live remote turn recording has been observed from `opencode-cli` 2.2.0 runs. This verifies plumbing and tool execution, not the accuracy of autonomous semantic judgment. In one isolated acceptance run the client-side agent model was a local Qwen and it falsely claimed tool calls without invoking them — the backend itself contains no LLM (embedding-only), so every semantic judgment comes from whichever model the agent host runs. The SCNet Token Plan returned an expired-subscription error.

The `stateBackend: "remote"` option mirrors review receipts to the `bm_capture_review` MCP tool through a local durable outbox, retries unsent operations on later ledger activity, and restores due remote pending reviews. The local outbox expires undelivered content after seven days and retains an explicit expired marker. Existing local records are not automatically migrated; check for unfinished reviews before switching. When online, the remote counter supplies the turn ordinal; offline, the adapter uses its cached interval and the available local session history. Existing sessions begin a new remote counting cycle when first connected. This mode requires the deployed capture-state service with idempotent turn and review operations.
