# Basic Memory for OpenCode

This OpenCode plugin connects sessions to Basic Memory using the `bm` CLI. It can recall recent OpenCode checkpoints before the first model request, update a checkpoint when a session becomes idle, and expose manual `bm_recall` and `bm_capture` tools.

The package supports both OpenCode plugin APIs from the same package export: V1 through its legacy `server()` entrypoint and V2 through `setup()` from the official `@opencode/plugin` SDK. V1 tool schemas use the patched Zod dependency directly; the legacy SDK package is omitted because its transitive TOML parser introduced three high-severity advisories unrelated to the V1 plugin contract used here. The V1 object entrypoint requires OpenCode 1.18.29 or newer.

## Install

Install Basic Memory so the `bm` command is available, then add the plugin to `opencode.json`. OpenCode V2 uses the `plugins` object form:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@basicmemory/opencode-basic-memory",
      "options": { "project": "my-project" }
    }
  ]
}
```

OpenCode V1 uses its `plugin` tuple form:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@basicmemory/opencode-basic-memory", { "project": "my-project" }]
  ]
}
```

Set either `project` or `projectId` explicitly. The plugin does not use Basic Memory's ambient default project, which prevents accidental cross-project writes. OpenCode installs npm plugins through Bun at startup.

For development from this checkout, use a local plugin file in `.opencode/plugins/` that imports `BasicMemoryOpenCode` from this package's `src/index.ts`, or install the package from the repository after publishing.

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `project` / `projectId` | required | Basic Memory project routing |
| `bmPath` | `bm` | Basic Memory CLI executable |
| `captureFolder` | `opencode/sessions` | Folder for session checkpoints |
| `recallTimeframe` | `7d` | Recent-note search window |
| `autoRecall` | `true` | Add recent checkpoints to the first model request in each session |
| `autoCapture` | `true` | Update a checkpoint when OpenCode emits `session.idle` and before compaction |
| `captureMinChars` | `80` | Minimum extracted transcript length for automatic capture |

Automatic recall is added to model instructions once per session. Retrieved notes are explicitly marked as reference data, not instructions. Automatic capture overwrites the same note for a given OpenCode session ID, keeping one current checkpoint rather than one note per turn. The full transcript remains in OpenCode's session history.

The plugin also registers `bm_recall` and `bm_capture` tools for explicit use. `bm_capture` accepts an optional title.

## Development

From the repository root, `just package-check-opencode` installs dependencies with the lockfile, typechecks both plugin entrypoints, and checks the npm package contents.
