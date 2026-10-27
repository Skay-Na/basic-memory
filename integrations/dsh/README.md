# Basic Memory for DeepSeek Harness

This DSH plugin connects to the self-hosted Basic Memory MCP endpoint. It
automatically searches the `main` project before each user turn and saves each
successfully completed user turn as a `pending_review` note in `dsh/inbox`.

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

## Behavior

- Before the first model step of each user turn, `agent/pre-step` searches
  Basic Memory with the direct user message. Up to six matching notes are added
  to the model context as reference material. Search failures are logged and
  the user's request continues without memory.
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

Automatic capture writes the transcript text for each completed turn, so the
inbox is a review queue rather than a curated knowledge base. Disable either
feature in the plugin row with `autoRecall: false` or `autoCapture: false`.

## Compatibility

Verified against the installed DSH `0.2.1-rc.3` APIs: `agent/pre-step`,
`session/event`, the `turn/end` event, `ctx.tools`, and the MCP client SDK
version used by that DSH release. The bundle uses the public DSH events and
services and imports no app-internal source paths.
