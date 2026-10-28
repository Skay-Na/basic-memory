# Basic Memory for DeepSeek Harness

This DSH plugin connects to the self-hosted Basic Memory MCP endpoint. It
automatically searches the configured project before each user turn, requests a
semantic memory review, and can save completed turns as `pending_review` notes
in `dsh/inbox`.

## Install

Store the Basic Memory bearer token in a private file. The default path is
`~/.config/basic-memory/token`; set `tokenFile` in the plugin row if your token
is stored elsewhere. The plugin checks that the file is not accessible to group
or other users. The token value is never placed in DSH configuration or printed
to logs.

Install the local bundle into a DSH profile:

```sh
dsh plugin --profile desktop add link:/absolute/path/to/basic-memory/integrations/dsh
```

Then include `@basicmemory/dsh-basic-memory` in that profile's
`dsh.profile.bundles` array and remove `dsh-plugin-supermemory` from the same
array. Remove the old Supermemory profile override from `cordis.patch.yml`.
Restart DSH if the profile does not reload automatically. The profile patch in
this bundle routes all operations to Basic Memory project `main`; the endpoint,
token path, project, capture folder, and automation flags can be overridden in
the plugin row.

Set `profileName` in the plugin row if `DSH_PROFILE` is not available in the
plugin host. It must be a stable profile name using letters, digits, `_` or `-`;
without one, local capture and recovery are disabled to prevent profiles from
sharing a queue. The local desktop profile uses `profileName: desktop`.

## Behavior

- Before the first model step of each user turn, `agent/pre-step` searches
  Basic Memory with the direct user message. Empty or failed hybrid searches
  fall back to text search. Up to six matching notes are added to the model
  context as reference material; failure does not block the request.
- When `semanticCapture` is enabled, the current DSH agent is prompted to
  review confirmed durable information before its final response. `bm_recall`,
  `bm_read`, `bm_review_save`, `bm_review_edit`, and `bm_review_complete`
  support search, checksum-guarded updates, and explicit receipts. The plugin
  verifies references against successful reads or writes before accepting a
  `saved` receipt; a model may still miss or misclassify information.
- A private SQLite ledger under `~/.dsh/basic-memory/<profile>/` tracks review
  state and unsuccessful inbox writes. Missing receipts become `unresolved`;
  `pending` and `unresolved` entries are offered for recheck on later turns in
  the same profile, project, and workspace, with backoff. If the session has no
  working directory, recovery is limited to that session. There is no background
  retry. Pending text and unfinished entries expire after seven days when the
  ledger is next accessed.
- After a `turn/end` with reason `completed`, the plugin captures the direct
  user messages and the last assistant text into `dsh/inbox`. Notes are marked
  `pending_review`, with the DSH session ID, turn number, and workspace path.
- Aborted, failed, or blocked turns and subagent sessions are not captured.
  Tool output, reasoning blocks, injected memory context, and images are not
  copied into the note.
- `bm_recall` provides a focused manual search. `bm_capture` saves an explicit
  durable memory under `dsh/remember`.
- The plugin only uses the configured project; it does not fall through to
  Basic Memory's ambient default project.

The raw transcript inbox is separate from semantic memory and contains the
user and assistant text of each completed turn, subject to configured length
limits. Failed inbox writes are queued locally and retried on a later turn.
Disable the independent features with `autoRecall: false`,
`autoCapture: false`, or `semanticCapture: false`. See
[`semantic-capture-design-zh.md`](./semantic-capture-design-zh.md) for the
design and remaining acceptance work.

## Compatibility

Developed against DSH `0.2.1-rc.3` public lifecycle and tool APIs. Isolated
mock-MCP tests cover recall fallback, capture, receipts, scoped recovery, and
inbox retry. A read-only request through the plugin client reached the actual
Basic Memory server. The desktop plugin was reloaded on 2026-10-28 and displayed
Running. The live DSH model's semantic review and UI presentation still require
end-to-end review.

Semantic review defaults to every five distinct user turns per session (`semanticCaptureInterval`, 1–100); it reviews the latest batch. Distinct session turn IDs are mirrored to the remote counter; its ordinal is used when reachable, with local fallback and durable retry when offline. A short final batch is not automatically reviewed. Recall and the optional raw inbox are independent.

`stateBackend: remote` mirrors capture counts and review states through the MCP service with a local SQLite outbox for offline retries. Due remote reviews are restored into the same profile/workspace scope. Undelivered review content older than seven days is cleared and marked expired; turn identifiers carry no transcript content. Restart or reload DSH after changing the profile.
