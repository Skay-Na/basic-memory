# Local web app

The local web app is a browser interface for a Basic Memory project. It uses the same local
database, Markdown files, and v2 API as the MCP server.

## Run it

Install this checkout in the environment that runs Basic Memory, then start the web process:

```bash
uv sync
uv run basic-memory web
```

Open <http://127.0.0.1:18888>. The command defaults to loopback because this server exposes the
project API without authentication. To use it from another device, keep the server bound to
loopback and create an SSH tunnel, or put it behind an authenticated reverse proxy on a trusted
network. Binding to `0.0.0.0` is supported but prints a warning.

The browser process is separate from `basic-memory mcp`. It loads the same local project
configuration and database, so do not point two different installs at different configuration
directories when you expect them to show the same notes.

The account gear opens an informational page on the local server. Login credentials are managed
by the authenticated router gateway; the page links to that gateway's account settings.

## Current workspace features

- Chinese-first interface with a persistent Chinese/English switch in the sidebar.
- Per-project memory-maintenance settings in the sidebar: configure a day interval and a distinct changed-note threshold; either threshold can trigger a future agent review.
- Three-pane layout with project switching, a folder tree that opens Markdown files directly, a filtered note list, and note detail.
- Search over the active project with the keyboard shortcut `Ctrl+K` or `Cmd+K`.
- Rich writing, Markdown source, and rendered preview modes. The source view preserves frontmatter; preview supports headings, lists, task lists, tables, links, images, fenced code, and clickable `[[wiki links]]`.
- Markdown edits use the v2 accepted-note API, save automatically, preserve frontmatter in rich mode, and save pending changes before navigating to another note.
- Create and delete notes, pin notes in this browser, and browse recent note updates.
- Knowledge graph view with connected notes, zoom buttons, wheel zoom, press-and-drag panning, and clickable nodes.
- Graph nodes drift gently with their connecting lines. Hover or keyboard focus steadies a node and
  shows its title and a short excerpt from the note (loaded on demand, without editing it).
  The graph respects the system's reduced-motion preference.

Pins are stored in this browser's local storage. Activity is currently a recent-note view based on
the project's indexed update timestamps. Cloud-only account, team, billing, sync, sharing,
snapshot, import, and audit-log settings are not part of the local interface.

The interface vendors the browser build of `markdown-it` 15.0.2. Raw HTML is disabled in Markdown
preview; wiki links are resolved through the local Basic Memory API. This keeps rendering available
without a CDN and follows the upstream note editor's rich/source/preview workflow.

Upstream references: [Web App](https://docs.basicmemory.com/cloud/web-app) and
[Note Editor](https://docs.basicmemory.com/cloud/note-editor).
