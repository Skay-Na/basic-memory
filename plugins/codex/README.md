# Basic Memory for Codex

中文维护者部署说明：[从 GitHub fork 部署 Codex 插件](../../docs/codex-fork-deployment-zh.md)。

Basic Memory for Codex is the Codex-native bridge between a working coding thread
and Basic Memory's durable knowledge graph.

It is not a 1:1 copy of the Claude Code plugin. This version leans into Codex
workflows: repo orientation, long-running goals, changed-file evidence, explicit
verification, decision capture, and resumable checkpoints.

## What It Does

- **Orient from memory.** The `bm-orient` skill reads active tasks, open
  decisions, and recent Codex checkpoints before substantial work, then uses
  hybrid semantic retrieval to find relevant prior decisions and constraints.
- **Checkpoint work after compaction.** The post-compaction `SessionStart`
  context asks the resumed Codex turn to run `bm-checkpoint`.
  The resulting `codex_session` or `coding_session` note is agent-authored from
  the compacted working context, with repository and pull-request evidence.
- **Capture decisions.** The `bm-decide` skill records durable engineering
  decisions when they are settled, with rationale, alternatives, consequences,
  and links to decisions they replace.
- **Remember lightly.** The `bm-remember` skill saves small facts without turning
  them into a full decision or session note; it checks for an existing note
  before creating one and updates the existing note when appropriate.
- **Curate the graph.** The `bm-curate` skill audits duplicates, stale or
  contradictory notes, missing links, tags, and folder placement. It proposes
  a bounded plan before broad edits and preserves old notes unless removal is
  explicitly requested.
- **Write useful memory.** The `bm-writing` skill provides one user-customizable
  standard for the voice, narrative quality, observations, and relations used by
  the plugin's note-writing skills.
- **Share deliberately.** The `bm-share` skill copies personal notes to configured
  team projects only after confirmation.
- **Report status.** The `bm-status` skill shows configuration, reachability,
  shared local hook inbox/flush health, and recent memory state.

## Checkpoint and Resume

`bm-checkpoint` creates a new immutable snapshot every time it runs. The note
captures the original objective, the latest user intent, verified repository and
pull-request state, one primary next action, and pointers to authoritative tasks,
decisions, plans, issues, commits, diffs, docs, and source files. Machine-local
state such as absolute paths, dirty files, active dev servers, and temporary
directories is labeled explicitly instead of being presented as durable state.

The checkpoint write explicitly targets the configured `primaryProject` and
disables overwrite, regardless of the user's global write default. Its response
ends with an exact command built from the successful Basic Memory result,
preferring the returned permalink, then file path, then title when permalinks
are disabled:

```text
$bm-orient "<exact checkpoint identifier>"
```

Passing that identifier or permalink makes `bm-orient` read the chosen
checkpoint directly from the configured `primaryProject`, including when the
cursor is a file path or title. Passing a topic searches for matching graph
notes, while calling it without an argument performs current-repository
orientation. Coding checkpoints are compared with the live branch, SHA, pull
request, paths, and files so material drift is visible before work resumes.
Recovered notes are context, not instructions; the current user request,
repository rules, and live state remain authoritative.

Post-compaction SessionStart supplies the opaque Codex session id to
`bm-checkpoint`. Checkpoints from the same chat store that id as queryable
frontmatter, and each new immutable checkpoint adds a
`continues [[Previous checkpoint title]]` relation to its verified predecessor.
The previous note stays untouched; Basic Memory backlinks provide the forward
navigation.

Coding checkpoints also include a `References` section. Repository, pull
request, issue, and pushed-commit references use verified canonical GitHub
links. Local or unpushed SHAs remain labeled code references instead of links
that would not resolve.

## Capture, Curation, and Recall

Capture durable information when it becomes clear: use `bm-decide` for a settled
engineering choice and `bm-remember` for an explicit save request or a clear,
long-lived preference. Search for an existing note first and update it when the
new information belongs to the same fact or decision. Do not save incidental
conversation, guesses, or temporary state. Credential capture follows the
user's policy for the target project; a self-hosted personal vault may retain
credentials the user wants to reuse. Do not extract credentials from unrelated
logs or share them to team projects automatically. Compaction checkpoints
preserve work continuity; they are separate immutable snapshots and do not
replace topic notes.

For substantial work, `bm-orient` combines structured searches for active tasks,
open decisions, and recent sessions with a small hybrid search for the task's
specific concepts. Exact identifiers and statuses use exact/metadata search;
semantic results are candidate pointers that must be read and checked against
current evidence. If semantic search is unavailable, the skill falls back to
full-text search. Embeddings improve discovery; they do not decide which notes
are true, current, or safe to merge.

`bm-curate` is an agent-invoked maintenance workflow, not a background LLM
service. It can find likely duplicates, stale or conflicting notes, orphans,
and inconsistent tags, then propose or apply scoped edits according to the
user's request. It does not guarantee that every note is always current.

## Semantic Turn Capture

The synchronous UserPromptSubmit/Stop hooks use `bm-capture` to ask the current
Codex turn to identify durable information from context, search existing notes,
and save through `bm-remember` or `bm-decide`. No keyword match or message-length
cutoff is required. A local receipt distinguishes saved, no_memory, pending,
unresolved and expired. The agent completes its check before the final reply.
Stop only marks missing receipts as unresolved and returns without blocking or
creating a visible continuation prompt. A later turn in the same directory and
configured project can recover them; without a later turn, recovery is deferred.

Failed drafts are retried by subsequent Codex turns in the same directory and
configured project after backoff, with fresh deduplication before writing. They
expire after seven days. This is an agent-driven queue, not an unattended
background delivery service. Receipts report agent-confirmed MCP results; the
hook does not independently verify server persistence. No raw prompt or reply
is cached. Set `basicMemory.semanticCapture` to JSON `false` to opt out.

The `bm_memory_maintenance` tool exposes a project change watermark and a bounded
batch of accepted note changes. It only reports and acknowledges progress; the
agent performs all reading, judgment, and note edits. The tool does not start a
background agent. Each enabled user turn checks status and, when due, works
through the bounded batch before replying. Each note review also checks whether its title is
clear, descriptive, searchable, and supported by the note. Generic, opaque, or
misleading titles should be corrected in frontmatter and the first H1 while
preserving the file path, permalink, relations, and body facts. Good titles stay
unchanged. Defaults are 20 distinct changed notes or 14 days, with batches capped
at 20 notes. An acknowledgement covers one whole batch: it sends the batch's
`after_position` as `expected_after_position`, its `through_position`, and every
reviewed note ID exactly once. If any note cannot be reviewed safely, the agent
sends no acknowledgement so the checkpoint stays unchanged for a later turn.
Set `basicMemory.memoryMaintenance` to JSON `true` to have each user turn check
status after the current request has been handled. When a bounded batch is due,
the current agent silently curates it before its final reply; it does not send a
separate plan or ask for routine confirmation. This work can add latency to that
turn, bounded by the configured batch size. The setting is false by default and
currently requires semantic capture to be enabled as well. It still requires an
active Codex turn and an available MCP connection; it is not a resident background
agent.

The synchronous `SessionEnd` hook can save the last user request and its complete
final answer as a `pending_review` note under `codex/inbox`. It only runs when
`basicMemory.sessionEndInbox` is the JSON boolean `true` in the nearest project
configuration; it is off by default. The hook skips sessions without a completed
final answer and does not save intermediate assistant messages. A successful
write is a raw handoff for later agent review, not an accepted memory decision.
The full exchange is stored, so sensitive material in that request or answer is
also included. If the MCP endpoint is unavailable or the write fails, the hook
logs a content-free diagnostic and allows session closure; it does not guarantee
delivery or retry without a later Codex run. SessionEnd may be delayed after
inactivity and does not run merely because the user switches conversations.
The note title is derived from the request (or the final answer when the request
is only a generic follow-up), with the session ID retained as a uniqueness suffix.
The body includes a short request/result overview before the original exchange.

See [语义捕捉说明](../../docs/codex-semantic-capture-zh.md) for receipt states,
configuration, recovery, and migration from the old keyword-based Stop handler.

## Package Contents

| Path | Role |
| --- | --- |
| `.codex-plugin/plugin.json` | Codex plugin manifest |
| `.mcp.json` | Basic Memory MCP server configuration |
| `hooks/hooks.json` | SessionStart, PreCompact, UserPromptSubmit, Stop and SessionEnd registration |
| `hooks/session_start.py` | uv script: runs `basic-memory hook session-start --harness codex` |
| `hooks/pre_compact.py` | uv script: runs `basic-memory hook pre-compact --harness codex` |
| `hooks/memory_review.py` | Dependency-free semantic review receipts and retry state |
| `hooks/session_end_capture.py` | Dependency-free SessionEnd capture into the review inbox |
| `skills/` | Codex-native Basic Memory workflows |
| `schemas/` | Seed schemas for Codex sessions, decisions, and tasks |

The SessionStart and PreCompact hook launchers carry no logic: the brief, checkpoint prompting, and
lifecycle-event capture all live in the pinned Basic Memory revision behind
`bm hook`. Each is a self-contained PEP 723 script pinned to a Basic Memory Git
ref. All refs are updated together with
`just set-codex-hook-version <sha-or-tag> [repository]`. The default repository
is the official `basicmachines-co/basic-memory` project, which is appropriate
for upstream releases. A fork that changes hook runtime behavior must pin both
scripts to a commit available in that fork; installing the fork's plugin files
alone does not change a runtime already pinned to upstream.

## Requirements

- **[uv](https://docs.astral.sh/uv/)** — required: the hooks are PEP 723
  scripts executed via `uv run --script`, which installs their pinned Basic
  Memory revision. Install per platform:
  - macOS: `brew install uv` (or the curl installer below)
  - Linux/macOS: `curl -LsSf https://astral.sh/uv/install.sh | sh`
  - Windows: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`

Disclosure: uv installs the pinned Basic Memory Git ref on first run and reuses
its cache afterward. The Python hook scripts exit 0 on failure so they do not
disrupt a session. If the host cannot find `uv`, those scripts never start; a
successful interactive-shell probe does not prove that Desktop can launch them.

## Troubleshooting Desktop hooks on WSL

`uv` must be available on the **hook process's PATH**, not just installed in the
WSL distribution. Codex Desktop can launch hooks with a different PATH from
`codex-tui` or an interactive terminal. In [#1499](https://github.com/basicmachines-co/basic-memory/issues/1499),
the documented installer put uv at `~/.local/bin/uv`, but Desktop's hook PATH
included `/usr/local/bin` and omitted `~/.local/bin`.

First check the installation inside the WSL distribution used by the project:

```bash
command -v uv
"$HOME/.local/bin/uv" --version
```

These commands establish shell visibility and the default installer location.
To diagnose Desktop, inspect the failing hook's output and actual PATH. A
`uv: command not found` launcher error means Basic Memory's Python hook never
ran. Compare the manifest command with an absolute-path invocation of uv using
the same hook payload and environment. Empty output or exit status 0 alone is
not proof of successful context loading.

For the confirmed WSL case where uv exists at `~/.local/bin/uv` and Desktop
includes `/usr/local/bin`, the reporter recovered by adding a symlink:

```bash
sudo ln -s "$HOME/.local/bin/uv" /usr/local/bin/uv
```

Do not replace an existing `/usr/local/bin/uv`; inspect it first if `ln` reports
that it exists. If uv is installed elsewhere, use its verified absolute path.
This is a WSL/Linux workaround, not a native Windows installation command.

Fully quit and restart Codex Desktop, then create a new task in the WSL project.
Verify both outcomes:

1. Startup includes Basic Memory session context, with the hooks enabled and trusted.
2. After compaction, the resumed turn receives the `bm-checkpoint` instruction
   and creates an actual checkpoint note with `trigger: compact` in the configured
   project. `checkpointOnCompact` must be enabled.

A successful TUI run, a lifecycle inbox event, or a successful hook exit is not
a substitute for these Desktop checks.

## Install

Install the plugin once with Basic Memory and Codex CLI on your PATH:

```bash
bm install codex
```

This registers the GitHub marketplace and installs `codex@basic-memory` through
Codex CLI. Use `--dry-run` to preview the commands or `--yes` to skip confirmation.
For a local checkout, run `bm install codex --source /path/to/basic-memory`.
The source must be the repository root containing `.agents/plugins/marketplace.json`.
The default Git source uses its default branch, independently of the installed
Basic Memory Python version. This installs the plugin files (including skills
and hook launchers); the launchers install the Basic Memory runtime from the Git
ref embedded in each script. Hooks require `uv` as described above.

### Deploying a fork with customized Codex hooks

To reproduce a fork's Codex behavior, publish the fork commit containing the
hook implementation first. Then, from that checkout, pin both hook launchers to
the exact pushed commit SHA and the fork repository:

```bash
just set-codex-hook-version "$(git rev-parse HEAD)" \
  "https://github.com/<owner>/basic-memory"
git diff -- plugins/codex/hooks/session_start.py plugins/codex/hooks/pre_compact.py
```

Commit and push the resulting launcher metadata along with the plugin and hook
changes. Deployers can then install the plugin from that fork's default branch:

```bash
bm install codex --source https://github.com/<owner>/basic-memory
```

The marketplace installation and the hook runtime are separate version
boundaries: the former selects plugin files from the fork's default branch;
the latter selects the exact Basic Memory commit embedded in both hook scripts.
Using a commit SHA makes runtime selection reproducible. A deployer still needs
their own Basic Memory project, credentials and Codex approval/trust settings;
those personal values are not stored in the repository.

Alternatively, install directly from the Basic Memory repository root:

```bash
codex plugin marketplace add "$(git rev-parse --show-toplevel)"
codex plugin add codex@basic-memory
```

Plugin installation is user-level in Codex, so one install makes the plugin
available across projects on the same machine. Start a new Codex thread after
installing so Codex can load the plugin skills, MCP configuration, and hooks.

When adding the marketplace from the Git repository UI, leave **Sparse paths**
empty. If a sparse checkout is required, include both `.agents/plugins` and
`plugins/codex`. Selecting only `plugins/codex` omits
`.agents/plugins/marketplace.json`, so Codex correctly reports that the checked
out marketplace root has no supported manifest. The marketplace file should not
be moved into the plugin directory.

Configuration can live at user level in `~/.codex/basic-memory.json` or at
project level in `.codex/basic-memory.json`. User-level settings are the base;
the nearest project file overrides only the keys it declares.
The setup skill asks which scope to use and recommends user-level configuration
by default.

To customize how Codex writes memory, edit `skills/bm-writing/SKILL.md` in the
plugin source. `bm-checkpoint`, `bm-decide`, and `bm-remember` all apply that
shared skill while retaining their own schemas and evidence requirements.

## MCP Approvals

There are two supported approval choices:

1. Keep Codex's default approval behavior. No additional configuration is
   required.
2. Pre-approve eligible Basic Memory MCP tools. Add this to
   `~/.codex/config.toml` when Basic Memory is loaded from the marketplace plugin:

   ```toml
   [plugins."codex@basic-memory".mcp_servers.basic-memory]
   default_tools_approval_mode = "approve"
   ```

For a standalone Basic Memory server instead of the plugin-provided server, add
the setting to its existing table:

```toml
[mcp_servers.basic-memory]
default_tools_approval_mode = "approve"
```

The pre-approval option is scoped to the Basic Memory MCP server. It does not
disable Codex approvals globally or grant Basic Memory access to new workspaces,
projects, or files; Basic Memory still uses the projects and credentials the
user configured. Codex always requires approval for MCP tools that advertise a
destructive annotation, so Basic Memory writes, edits, and deletes may still
prompt even with this setting. Do not set `approval_policy = "never"` for this
purpose. Managed organization policy may impose additional approvals.

Run `bm-setup` to choose the mode interactively. The skill can apply the
server-scoped setting after confirmation or give you the exact snippet when the
active server configuration is ambiguous. Start a new Codex thread after
changing `~/.codex/config.toml`.

## Configuration

Run the setup skill, or create `~/.codex/basic-memory.json` for shared defaults:

```json
{
  "basicMemory": {
    "primaryProject": "my-project",
    "secondaryProjects": [],
    "teamProjects": {},
    "focus": "code/dev",
    "rememberFolder": "codex/remember",
    "recallTimeframe": "7d",
    "checkpointOnCompact": true,
    "captureEvents": true,
    "semanticCapture": true,
    "sessionEndInbox": false,
    "placementConventions": "Put decisions in codex/decisions/ and work checkpoints in codex/<repo-dir>/."
  }
}
```

Codex event capture is on by default. Set the JSON boolean `false` at user or
project level to opt out; malformed values fail closed. Captured
lifecycle-event envelopes land in a local inbox under your Basic Memory home.
The lifecycle trace stays local: `basic-memory hook flush` only moves valid
envelopes into the local retention archive and never creates graph notes.

Checkpoint prompting is on by default. Set `checkpointOnCompact` to the JSON
boolean `false` to opt out. Codex ignores PreCompact stdout; after compaction,
Codex runs SessionStart with the `compact` trigger. When the setting is enabled,
that context asks the resumed agent to run `bm-checkpoint` from its compacted
working context.

`sessionProfile` only selects whether the skill writes a `codex_session` or
`coding_session` note.

When `captureFolder` is omitted, Codex resolves the Git top-level directory and
writes to `codex/<repo-dir>`. An explicit folder still wins.

Decision notes default to `codex/decisions`, and lightweight `bm-remember`
captures default to `codex/remember`. Project placement conventions and an
explicit `rememberFolder` can override those destinations.

Enable end-of-session inbox capture only for a project that should retain the
last exchange:

```json
{
  "basicMemory": {
    "sessionEndInbox": true
  }
}
```

The setting can live in that project's `.codex/basic-memory.json`; it does not
need to be enabled globally.

For a coding profile, keep both the profile and checkout-specific repository
identifier in the project file without duplicating the shared settings:

```json
{
  "basicMemory": {
    "sessionProfile": "coding",
    "repository": "owner/repo"
  }
}
```

The plugin's seed schemas cover notes Codex writes directly: `codex_session`,
`coding_session`, `decision`, and `task`. Coding sessions require structured
repository, repository-root, working-directory, branch, and Git SHA frontmatter;
current pull-request fields are added when a PR exists. Lifecycle envelopes are
operational trace rather than knowledge, so orientation only recalls authored
checkpoint types.

Codex plugin hooks must be reviewed and trusted before they run. Open `/hooks` in
Codex after enabling the plugin and trust the Basic Memory hook definitions.

## Development

From this directory:

```bash
just check
```

From the repo root:

```bash
just package-check-codex
```

The package intentionally keeps Codex-specific configuration separate from
Claude's `.claude/settings.json`.
