const state = {
  projects: [],
  project: null,
  tree: null,
  notes: [],
  selected: null,
  folder: "/",
  view: "all",
  tab: "all",
  sort: "updated_desc",
  mode: "preview",
  pinned: new Set(JSON.parse(localStorage.getItem("bm-pinned") || "[]")),
  dirty: false,
  searchResults: [],
  searchIndex: 0,
  graph: null,
  saveTimer: null,
};
const $ = (id) => document.getElementById(id);
const t = (value) => window.basicMemoryI18n.t(value);
const graphBaseViewBox = { x: 0, y: 0, width: 900, height: 560 };
let graphViewBox = { ...graphBaseViewBox };
let graphPointer = null;
let lastGraphDragAt = 0;
const markdownParser = window.markdownit({ html: false, linkify: true });
markdownParser.inline.ruler.before(
  "link",
  "basic_memory_wiki_link",
  (parserState, silent) => {
    const start = parserState.pos;
    if (parserState.src.slice(start, start + 2) !== "[[") return false;
    const end = parserState.src.indexOf("]]", start + 2);
    if (end < 0) return false;
    const reference = parserState.src.slice(start + 2, end).trim();
    if (!reference) return false;
    if (!silent) {
      const [target, label] = reference.split("|", 2).map((part) => part.trim());
      const open = parserState.push("link_open", "a", 1);
      open.attrSet("href", "#");
      open.attrSet("data-wiki-link", target);
      const text = parserState.push("text", "", 0);
      text.content = label || target;
      parserState.push("link_close", "a", -1);
    }
    parserState.pos = end + 2;
    return true;
  },
);
markdownParser.core.ruler.after("inline", "basic_memory_task_list", (parserState) => {
  for (let index = 1; index < parserState.tokens.length; index += 1) {
    const inline = parserState.tokens[index];
    if (inline.type !== "inline" || !inline.children) continue;
    let listItem;
    for (let prior = index - 1; prior >= 0; prior -= 1) {
      const candidate = parserState.tokens[prior];
      if (candidate.type === "list_item_close") break;
      if (candidate.type === "list_item_open") {
        listItem = candidate;
        break;
      }
    }
    if (!listItem) continue;
    const firstText = inline.children.find((child) => child.type === "text");
    const task = firstText?.content.match(/^\[([ xX])\]\s+/);
    if (!task) continue;
    firstText.content = firstText.content.slice(task[0].length);
    listItem.attrJoin("class", "task-list-item");
    const checkbox = new parserState.Token("html_inline", "", 0);
    checkbox.content = `<input class="task-list-checkbox" type="checkbox"${task[1].trim() ? " checked" : ""}> `;
    inline.children.unshift(checkbox);
  }
});
const splitFrontmatter = (source) => {
  const match = (source || "").match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  return match
    ? { metadata: match[1], prefix: match[0], body: source.slice(match[0].length) }
    : { metadata: "", prefix: "", body: source || "" };
};
const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      const errorDetail = payload.detail ?? payload.message;
      if (Array.isArray(errorDetail)) {
        detail = errorDetail
          .map((item) => {
            const location = Array.isArray(item.loc) ? item.loc.join(".") : "";
            const message = item.msg || item.message || JSON.stringify(item);
            return location ? `${location}: ${message}` : message;
          })
          .join("; ");
      } else if (errorDetail && typeof errorDetail === "object") {
        detail = errorDetail.message || errorDetail.detail || JSON.stringify(errorDetail);
      } else if (errorDetail) {
        detail = String(errorDetail);
      }
    } catch {}
    throw new Error(detail);
  }
  if (response.status === 204) return null;
  return response.json();
};
const projectPath = () =>
  `/v2/projects/${encodeURIComponent(state.project.external_id)}`;
const esc = (value = "") =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const fileTitle = (note) =>
  note.title ||
  (note.name || "").replace(/\.(md|markdown)$/i, "").replace(/[-_]/g, " ");
const fmtDate = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ""
    : new Intl.DateTimeFormat(window.basicMemoryI18n.locale, {
        month: "short",
        day: "numeric",
      }).format(date);
};
const renderMarkdownBody = (source) => markdownParser.render(source || "");
const markdown = (source) => {
  const { metadata, body } = splitFrontmatter(source);
  const metadataPanel = metadata
    ? `<details class="frontmatter-preview"><summary>${esc(t("Frontmatter"))}</summary><pre>${esc(metadata)}</pre></details>`
    : "";
  return `${metadataPanel}${renderMarkdownBody(body)}`;
};
const markdownToRichHtml = (source) =>
  renderMarkdownBody(splitFrontmatter(source).body);
const richNodeToMarkdown = (node) => {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node;
  const tag = element.tagName.toLowerCase();
  if (element.dataset.wikiLink) return `[[${element.dataset.wikiLink}]]`;
  if (tag === "br") return "\n";
  if (tag === "input" && element.classList.contains("task-list-checkbox"))
    return `[${element.checked ? "x" : " "}] `;
  if (tag === "img") return `![${element.alt}](${element.getAttribute("src") || ""})`;
  if (tag === "code" && element.parentElement?.tagName.toLowerCase() === "pre")
    return element.textContent || "";
  if (tag === "pre") {
    const code = element.querySelector("code");
    const language = [...(code?.classList || [])].find((item) => item.startsWith("language-"))?.slice(9) || "";
    return `\n\n\`\`\`${language}\n${code?.textContent || element.textContent || ""}\n\`\`\`\n\n`;
  }
  if (tag === "ul" || tag === "ol") {
    const prefix = "  ".repeat(Number(element.dataset.depth || 0));
    const items = [...element.children].filter((child) => child.tagName === "LI");
    return items
      .map((item, index) => {
        const checkbox = item.querySelector(":scope > input.task-list-checkbox");
        const marker = checkbox
          ? `[${checkbox.checked ? "x" : " "}] `
          : tag === "ol"
            ? `${index + 1}. `
            : "";
        const content = [...item.childNodes]
          .filter((child) => !(child instanceof Element && ["UL", "OL"].includes(child.tagName)) && child !== checkbox)
          .map(richNodeToMarkdown)
          .join("")
          .trim();
        const nested = [...item.children]
          .filter((child) => ["UL", "OL"].includes(child.tagName))
          .map((child) => {
            child.dataset.depth = String(Number(element.dataset.depth || 0) + 1);
            return richNodeToMarkdown(child);
          })
          .join("");
        return `${prefix}${marker}${content}${nested ? `\n${nested.trimEnd()}` : ""}`;
      })
      .join("\n") + "\n\n";
  }
  const inner = [...element.childNodes].map(richNodeToMarkdown).join("");
  if (/^h[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${inner.trim()}\n\n`;
  if (tag === "p" || tag === "div") return `${inner.trim()}\n\n`;
  if (tag === "blockquote")
    return `${inner.trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
  if (tag === "strong" || tag === "b") return `**${inner}**`;
  if (tag === "em" || tag === "i") return `*${inner}*`;
  if (tag === "del" || tag === "s") return `~~${inner}~~`;
  if (tag === "code") return `\`${inner}\``;
  if (tag === "a") return `[${inner}](${element.getAttribute("href") || ""})`;
  if (tag === "hr") return "\n\n---\n\n";
  if (tag === "table") {
    const rows = [...element.querySelectorAll("tr")].map((row) =>
      [...row.children].map((cell) => cell.textContent.trim()),
    );
    if (!rows.length) return "";
    const line = (cells) => `| ${cells.join(" | ")} |`;
    return `${line(rows[0])}\n${line(rows[0].map(() => "---"))}\n${rows.slice(1).map(line).join("\n")}\n\n`;
  }
  return inner;
};
const richEditorMarkdown = (element) =>
  [...element.childNodes]
    .map(richNodeToMarkdown)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
const updateSourceFromRichEditor = () => {
  const { prefix } = splitFrontmatter($("note-source").value);
  $("note-source").value = `${prefix}${richEditorMarkdown($("note-rich"))}`;
};
const hydrateRichEditor = () => {
  $("note-rich").innerHTML = markdownToRichHtml($("note-source").value);
};
const toast = (message) => {
  const element = $("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2500);
};
const getAllNotes = (node, output = []) => {
  if (node?.type === "file" && (node.content_type || "").includes("markdown"))
    output.push(node);
  for (const child of node?.children || []) getAllNotes(child, output);
  return output;
};
const relativeDir = (value = "/") => value.replace(/^\/+|\/+$/g, "");

async function boot() {
  try {
    const data = await api("/v2/projects/");
    state.projects = data.projects || [];
    state.project =
      state.projects.find((project) => project.name === data.default_project) ||
      state.projects[0];
    if (!state.project)
      throw new Error(
        t("No Basic Memory project is configured. Add a project with `bm project add`."),
      );
    $("project-name").textContent =
      state.project.display_name || state.project.name;
    $("search-project-label").textContent = state.project.name;
    await reloadProject();
    const params = new URLSearchParams(location.search);
    if (params.has("note")) openNote(params.get("note"));
    else if (matchMedia("(max-width: 820px)").matches)
      $("list-pane").classList.add("mobile-open");
  } catch (error) {
    $("note-list").innerHTML =
      `<div class="empty-state">${esc(t("Could not connect to Basic Memory."))}<br><br>${esc(error.message)}<br><br>${esc(t("Start the web server with `basic-memory web`."))}</div>`;
  }
}

async function reloadProject() {
  $("project-name").textContent =
    state.project.display_name || state.project.name;
  $("search-project-label").textContent = state.project.name;
  state.folder = "/";
  state.tree = await api(`${projectPath()}/directory/tree`);
  state.notes = getAllNotes(state.tree).sort(
    (a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0),
  );
  renderTree();
  renderNotes();
}

function renderTree() {
  if (!state.tree) return;
  const tree = $("folder-tree");
  const row = (node, level = 0) => {
    if (node.type === "file") {
      if (!(node.content_type || "").includes("markdown") || !node.external_id)
        return "";
      return `<button type="button" class="tree-row tree-file-row ${state.selected?.external_id === node.external_id ? "selected" : ""}" data-level="${level}" data-note="${esc(node.external_id)}" style="--tree-depth:${Math.min(level, 8)};padding-left:${8 + Math.min(level, 8) * 16}px" title="${esc(node.file_path || node.name)}"><span class="tree-caret"></span><span class="file-icon">▱</span><span class="tree-name">${esc(fileTitle(node))}</span></button>`;
    }
    const path = node.directory_path || "/";
    const children = node.children || [];
    const folders = children.filter((child) => child.type === "directory");
    const open =
      level < 1 ||
      path === state.folder ||
      state.folder.startsWith(`${path.replace(/\/$/, "")}/`);
    const fileCount = children.filter(
      (child) => child.type === "file" && (child.content_type || "").includes("markdown"),
    ).length;
    return `<div class="tree-node"><div class="tree-row tree-folder-row ${state.folder === path ? "selected" : ""}" data-level="${level}" data-folder="${esc(path)}" style="--tree-depth:${Math.min(level, 8)};padding-left:${8 + Math.min(level, 8) * 16}px"><span class="tree-caret">${folders.length ? (open ? "⌄" : "›") : ""}</span><span class="folder-icon">${path === "/" ? "⌂" : "▱"}</span><span class="tree-name">${esc(node.name === "/" ? t("All notes") : node.name)}</span>${fileCount ? `<span class="tree-count">${fileCount}</span>` : ""}</div>${open ? children.map((child) => row(child, level + 1)).join("") : ""}</div>`;
  };
  tree.innerHTML =
    row(state.tree) || `<div class="tree-loading">${esc(t("No folders yet"))}</div>`;
  tree.querySelectorAll("[data-folder]").forEach((element) =>
    element.addEventListener("click", () => {
      state.folder = element.dataset.folder;
      state.view = "all";
      setActiveNav("all");
      renderTree();
      renderNotes();
      if (matchMedia("(max-width: 820px)").matches) {
        $("sidebar").classList.remove("open");
        $("list-pane").classList.add("mobile-open");
      }
    }),
  );
  tree.querySelectorAll("[data-note]").forEach((element) =>
    element.addEventListener("click", () => openNote(element.dataset.note)),
  );
}

function visibleNotes() {
  let notes = [...state.notes];
  if (state.folder !== "/")
    notes = notes.filter((note) =>
      (note.file_path || "").startsWith(relativeDir(state.folder) + "/"),
    );
  if (state.view === "pinned" || state.tab === "pinned")
    notes = notes.filter((note) => state.pinned.has(note.external_id));
  notes.sort((a, b) =>
    state.sort === "title_asc"
      ? fileTitle(a).localeCompare(fileTitle(b))
      : state.sort === "updated_asc"
        ? new Date(a.updated_at || 0) - new Date(b.updated_at || 0)
        : new Date(b.updated_at || 0) - new Date(a.updated_at || 0),
  );
  return notes;
}

function renderNotes() {
  const list = $("note-list");
  const notes = visibleNotes();
  $("note-count").textContent =
    window.basicMemoryI18n.locale === "zh-CN"
      ? `${notes.length} 篇笔记`
      : `${notes.length} ${notes.length === 1 ? "note" : "notes"}`;
  $("list-title").textContent =
    state.view === "pinned" || state.tab === "pinned"
      ? t("Pinned notes")
      : state.folder === "/"
        ? t("All notes")
        : state.folder.split("/").filter(Boolean).at(-1);
  $("list-eyebrow").textContent =
    state.folder === "/"
      ? t("YOUR KNOWLEDGE")
      : state.folder.toUpperCase().replaceAll("/", " · ");
  if (!notes.length) {
    list.innerHTML = `<div class="empty-state">${esc(t(state.view === "pinned" || state.tab === "pinned" ? "No pinned notes yet. Pin a note to keep it close." : "No notes in this folder yet."))}<br><br><button class="primary-button compact" id="empty-new">＋ ${esc(t("Create a note"))}</button></div>`;
    $("empty-new")?.addEventListener("click", createNote);
    return;
  }
  const groupName = (note) => {
    if (!note.updated_at) return t("NOTES");
    const day = new Date(note.updated_at);
    const now = new Date();
    if (day.toDateString() === now.toDateString()) return t("TODAY");
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    return day.toDateString() === yesterday.toDateString()
      ? t("YESTERDAY")
      : t("RECENTLY UPDATED");
  };
  let lastGroup = "";
  list.innerHTML = notes
    .map((note) => {
      const group = groupName(note);
      const heading =
        group !== lastGroup
          ? `<div class="note-group-label">${group}</div>`
          : "";
      lastGroup = group;
      const excerpt = note.file_path || note.note_type || "Markdown note";
      return `${heading}<article class="note-card ${state.selected?.external_id === note.external_id ? "selected" : ""}" data-note="${esc(note.external_id)}"><div class="note-card-title">${state.pinned.has(note.external_id) ? '<span aria-label="Pinned">♢</span>' : ""}<span>${esc(fileTitle(note))}</span></div><div class="note-card-preview">${esc(excerpt)}</div><div class="note-card-meta"><i class="note-type-dot"></i>${esc(note.note_type || "note")}<span>·</span>${esc(fmtDate(note.updated_at))}</div></article>`;
    })
    .join("");
  list
    .querySelectorAll("[data-note]")
    .forEach((card) =>
      card.addEventListener("click", () => openNote(card.dataset.note)),
    );
}

function setActiveNav(view) {
  document
    .querySelectorAll(".nav-item")
    .forEach((item) =>
      item.classList.toggle("active", item.dataset.view === view),
    );
}
function showView(view) {
  state.view = view;
  state.tab = view === "pinned" ? "pinned" : "all";
  if (view === "all" || view === "pinned") state.folder = "/";
  setActiveNav(view);
  document
    .querySelectorAll("[data-tab]")
    .forEach((tab) =>
      tab.classList.toggle("active", tab.dataset.tab === state.tab),
    );
  $("note-workspace").classList.toggle(
    "hidden",
    view === "graph" || view === "activity" || !state.selected,
  );
  $("welcome-state").classList.toggle(
    "hidden",
    view === "graph" || view === "activity" || !!state.selected,
  );
  $("graph-workspace").classList.toggle("hidden", view !== "graph");
  $("activity-workspace").classList.toggle("hidden", view !== "activity");
  if (view === "graph") renderGraph();
  if (view === "activity") renderActivity();
  if (view === "all" || view === "pinned") renderTree();
  renderNotes();
  if (matchMedia("(max-width: 820px)").matches) {
    $("sidebar").classList.remove("open");
    $("list-pane").classList.toggle(
      "mobile-open",
      view === "all" || view === "pinned",
    );
  }
}

async function openNote(id) {
  try {
    if (state.selected?.external_id !== id && state.dirty) {
      clearTimeout(state.saveTimer);
      await saveNote();
      if (state.dirty) return;
    }
    state.selected = await api(
      `${projectPath()}/knowledge/entities/${encodeURIComponent(id)}`,
    );
    state.dirty = false;
    $("list-pane").classList.remove("mobile-open");
    $("sidebar").classList.remove("open");
    $("welcome-state").classList.add("hidden");
    $("graph-workspace").classList.add("hidden");
    $("activity-workspace").classList.add("hidden");
    $("note-workspace").classList.remove("hidden");
    $("note-title").value = state.selected.title || "";
    $("note-source").value = state.selected.content || "";
    if (state.mode === "rich") hydrateRichEditor();
    $("note-type-badge").textContent = (
      state.selected.note_type || "note"
    ).toUpperCase();
    $("file-path").textContent = state.selected.file_path || "";
    $("breadcrumbs").innerHTML =
      `<span>${esc(state.project.name)}</span>  /  ${esc(state.selected.file_path || "")}`;
    $("pin-note").textContent = state.pinned.has(id) ? "◆" : "♢";
    $("save-status").textContent = t("Saved");
    renderTree();
    renderNotes();
    renderRelations();
    renderEditor();
    history.replaceState(null, "", `/?note=${encodeURIComponent(id)}`);
  } catch (error) {
    toast(`${t("Could not open note: ")}${error.message}`);
  }
}

function renderRelations() {
  const relations = state.selected?.relations || [];
  $("relation-count").textContent = relations.length;
  $("relations-list").innerHTML =
    relations
      .map(
        (relation) =>
          `<button class="relation-chip" data-relation="${esc(relation.to_id || relation.from_id)}">${esc(relation.relation_type || "related to")} · ${esc(relation.to_id || relation.from_id)}</button>`,
      )
      .join("") ||
    `<span class="note-card-meta">${esc(t("Notes you link will appear here."))}</span>`;
  $("relations-list")
    .querySelectorAll("[data-relation]")
    .forEach((button) =>
      button.addEventListener("click", async () => {
        try {
          const result = await api(`${projectPath()}/knowledge/resolve`, {
            method: "POST",
            body: JSON.stringify({ identifier: button.dataset.relation }),
          });
          openNote(result.external_id);
        } catch {
          toast(t("That linked note could not be resolved."));
        }
      }),
    );
}

function renderEditor() {
  document
    .querySelectorAll("[data-mode]")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.mode === state.mode),
    );
  $("note-source").classList.toggle("hidden", state.mode !== "source");
  $("note-rich").classList.toggle("hidden", state.mode !== "rich");
  $("note-preview").classList.toggle("hidden", state.mode !== "preview");
  $("editor-tools").classList.toggle("hidden", state.mode === "preview");
  if (state.mode === "preview")
    $("note-preview").innerHTML = markdown($("note-source").value);
  const source = splitFrontmatter($("note-source").value).body.trim();
  const words =
    window.basicMemoryI18n.locale === "zh-CN"
      ? [...source.replace(/\s/g, "")].length
      : (source.match(/\S+/g) || []).length;
  $("word-count").textContent =
    window.basicMemoryI18n.locale === "zh-CN" ? `${words} ${t("words")}` : `${words} words`;
}

async function followWikiLink(target) {
  try {
    const result = await api(`${projectPath()}/knowledge/resolve`, {
      method: "POST",
      body: JSON.stringify({ identifier: target }),
    });
    if (!result.external_id) throw new Error("not found");
    await openNote(result.external_id);
  } catch {
    toast(t("That linked note could not be resolved."));
  }
}

for (const view of [$("note-preview"), $("note-rich")]) {
  view.addEventListener("click", (event) => {
    const link = event.target.closest("[data-wiki-link]");
    if (link) {
      event.preventDefault();
      followWikiLink(link.dataset.wikiLink);
    }
  });
}
$("note-preview").addEventListener("click", (event) => {
  if (event.target.matches(".task-list-checkbox")) event.preventDefault();
});

function queueSave() {
  if (!state.selected) return;
  state.dirty = true;
  $("save-status").textContent = t("Unsaved changes");
  $("save-status").className = "saved-indicator saving";
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNote, 900);
  if (state.mode === "preview") renderEditor();
}

async function saveNote() {
  if (!state.selected || !state.dirty) return;
  const note = state.selected;
  const file = note.file_path || "";
  const parts = file.split("/");
  const filename = parts.pop() || `${$("note-title").value}.md`;
  const directory = parts.join("/");
  $("save-status").textContent = t("Saving…");
  $("save-status").className = "saved-indicator saving";
  try {
    const saved = await api(
      `${projectPath()}/knowledge/entities/${encodeURIComponent(note.external_id)}`,
      {
        method: "PUT",
        headers: note.db_checksum
          ? { "x-bm-cloud-note-base-checksum": note.db_checksum }
          : {},
        body: JSON.stringify({
          title: $("note-title").value.trim() || "Untitled",
          note_type: note.note_type || "note",
          content: $("note-source").value,
          directory,
          file_name: filename,
          content_type: "text/markdown",
        }),
      },
    );
    state.selected = saved;
    state.dirty = false;
    $("save-status").textContent = t("Saved");
    $("save-status").className = "saved-indicator";
    $("file-path").textContent = saved.file_path || file;
    toast(t("Note saved"));
    await reloadProject();
    renderEditor();
  } catch (error) {
    $("save-status").textContent = error.message.includes("409")
      ? "Conflict"
      : "Save failed";
    $("save-status").className = "saved-indicator error";
    toast(`${t("Save failed")}：${error.message}`);
  }
}

async function createNote() {
  const title = prompt(t("Note title"));
  if (!title?.trim()) return;
  const directory = relativeDir(state.folder);
  try {
    const note = await api(`${projectPath()}/knowledge/entities`, {
      method: "POST",
      body: JSON.stringify({
        title: title.trim(),
        note_type: "note",
        content: `# ${title.trim()}\n\n`,
        directory,
        content_type: "text/markdown",
      }),
    });
    await reloadProject();
    await openNote(note.external_id);
    $("note-source").focus();
    toast(t("Note created"));
  } catch (error) {
    toast(`${t("Could not create note: ")}${error.message}`);
  }
}

async function createInNewFolder() {
  const name = prompt(t("New folder name"));
  if (!name?.trim()) return;
  const parent = relativeDir(state.folder);
  state.folder = `/${[parent, name.trim()].filter(Boolean).join("/")}/`;
  await createNote();
}

async function removeNote() {
  if (
    !state.selected ||
    !confirm(
      `${t("Move “")}${state.selected.title}${t("” to trash? This deletes the Markdown file.")}`,
    )
  )
    return;
  try {
    await api(
      `${projectPath()}/knowledge/entities/${encodeURIComponent(state.selected.external_id)}`,
      { method: "DELETE" },
    );
    state.pinned.delete(state.selected.external_id);
    localStorage.setItem("bm-pinned", JSON.stringify([...state.pinned]));
    state.selected = null;
    $("note-workspace").classList.add("hidden");
    $("welcome-state").classList.remove("hidden");
    history.replaceState(null, "", "/");
    await reloadProject();
    toast(t("Note deleted"));
  } catch (error) {
    toast(`${t("Could not delete note: ")}${error.message}`);
  }
}

function togglePin() {
  if (!state.selected) return;
  const id = state.selected.external_id;
  if (state.pinned.has(id)) state.pinned.delete(id);
  else state.pinned.add(id);
  localStorage.setItem("bm-pinned", JSON.stringify([...state.pinned]));
  $("pin-note").textContent = state.pinned.has(id) ? "◆" : "♢";
  renderNotes();
  toast(state.pinned.has(id) ? t("Note pinned") : t("Pin removed"));
}

async function searchNotes(query) {
  if (!query.trim()) {
    $("search-results").innerHTML =
      `<div class="search-empty">${esc(t("Type to search notes and ideas"))}</div>`;
    return;
  }
  $("search-results").innerHTML = `<div class="search-empty">${esc(t("Searching…"))}</div>`;
  try {
    const response = await api(`${projectPath()}/search/?page_size=20`, {
      method: "QUERY",
      body: JSON.stringify({ text: query, retrieval_mode: "fts" }),
    });
    state.searchResults = response.results || [];
    state.searchIndex = 0;
    if (!state.searchResults.length) {
      $("search-results").innerHTML =
        `<div class="search-empty">${esc(t("No matching notes"))}</div>`;
      return;
    }
    $("search-results").innerHTML = state.searchResults
      .map(
        (result, index) =>
          `<div class="search-result ${index === 0 ? "active" : ""}" data-result="${index}"><strong>${esc(result.title)}</strong><p>${esc(result.content || result.file_path || "")}</p></div>`,
      )
      .join("");
    $("search-results")
      .querySelectorAll("[data-result]")
      .forEach((item) =>
        item.addEventListener("click", () =>
          selectSearchResult(Number(item.dataset.result)),
        ),
      );
  } catch (error) {
    $("search-results").innerHTML =
      `<div class="search-empty">${esc(t("Search unavailable: "))}${esc(error.message)}</div>`;
  }
}

function selectSearchResult(index) {
  const result = state.searchResults[index];
  if (!result?.external_id) return;
  $("modal").classList.add("hidden");
  openNote(result.external_id);
}
function openSearch() {
  $("modal").classList.remove("hidden");
  $("search-input").value = "";
  $("search-results").innerHTML =
    `<div class="search-empty">${esc(t("Type to search notes and ideas"))}</div>`;
  setTimeout(() => $("search-input").focus(), 10);
}

function updateGraphViewport(svg = $("graph-canvas").querySelector("svg")) {
  if (!svg) return;
  const { x, y, width, height } = graphViewBox;
  svg.setAttribute(
    "viewBox",
    `${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}`,
  );
  $("graph-zoom-label").textContent = `${Math.round(
    (graphBaseViewBox.width / width) * 100,
  )}%`;
}

function zoomGraph(factor, anchorX, anchorY) {
  const svg = $("graph-canvas").querySelector("svg");
  if (!svg) return;
  const current = graphViewBox;
  const nextWidth = Math.max(280, Math.min(2700, current.width * factor));
  const nextHeight =
    nextWidth * (graphBaseViewBox.height / graphBaseViewBox.width);
  const centerX = anchorX ?? current.x + current.width / 2;
  const centerY = anchorY ?? current.y + current.height / 2;
  const relativeX = (centerX - current.x) / current.width;
  const relativeY = (centerY - current.y) / current.height;
  graphViewBox = {
    x: centerX - relativeX * nextWidth,
    y: centerY - relativeY * nextHeight,
    width: nextWidth,
    height: nextHeight,
  };
  updateGraphViewport(svg);
}

function resetGraphViewport() {
  graphViewBox = { ...graphBaseViewBox };
  updateGraphViewport();
}

function bindGraphGestures(canvas, svg) {
  canvas.onwheel = (event) => {
    event.preventDefault();
    const bounds = svg.getBoundingClientRect();
    const anchorX =
      graphViewBox.x +
      ((event.clientX - bounds.left) / bounds.width) * graphViewBox.width;
    const anchorY =
      graphViewBox.y +
      ((event.clientY - bounds.top) / bounds.height) * graphViewBox.height;
    zoomGraph(event.deltaY < 0 ? 0.88 : 1.14, anchorX, anchorY);
  };
  canvas.onpointerdown = (event) => {
    if (event.button !== 0) return;
    graphPointer = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      startViewBox: { ...graphViewBox },
      dragging: false,
      longPressReady: event.pointerType !== "touch",
      longPressTimer: null,
    };
    if (event.pointerType === "touch") {
      graphPointer.longPressTimer = setTimeout(() => {
        if (graphPointer?.pointerId === event.pointerId) {
          graphPointer.longPressReady = true;
        }
      }, 320);
    }
  };
  canvas.onpointermove = (event) => {
    if (!graphPointer || event.pointerId !== graphPointer.pointerId) return;
    const dx = event.clientX - graphPointer.startX;
    const dy = event.clientY - graphPointer.startY;
    if (graphPointer.pointerType === "touch" && !graphPointer.longPressReady) {
      if (Math.hypot(dx, dy) > 7) clearTimeout(graphPointer.longPressTimer);
      return;
    }
    if (!graphPointer.dragging && Math.hypot(dx, dy) > 4) {
      graphPointer.dragging = true;
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add("is-panning");
    }
    if (!graphPointer.dragging) return;
    const bounds = svg.getBoundingClientRect();
    graphViewBox = {
      ...graphPointer.startViewBox,
      x:
        graphPointer.startViewBox.x -
        (dx * graphPointer.startViewBox.width) / bounds.width,
      y:
        graphPointer.startViewBox.y -
        (dy * graphPointer.startViewBox.height) / bounds.height,
    };
    updateGraphViewport(svg);
  };
  const finishPointer = (event) => {
    if (!graphPointer || event.pointerId !== graphPointer.pointerId) return;
    clearTimeout(graphPointer.longPressTimer);
    if (graphPointer.dragging) {
      lastGraphDragAt = Date.now();
      canvas.classList.remove("is-panning");
      if (canvas.hasPointerCapture(event.pointerId))
        canvas.releasePointerCapture(event.pointerId);
    }
    graphPointer = null;
  };
  canvas.onpointerup = finishPointer;
  canvas.onpointercancel = finishPointer;
}

function updateGraphControlLanguage() {
  const chinese = window.basicMemoryI18n.locale === "zh-CN";
  const labels = {
    "graph-gesture-hint": chinese
      ? "按住拖动平移 · 滚动缩放"
      : "Hold and drag to pan · scroll to zoom",
    "graph-zoom-in": chinese ? "放大" : "Zoom in",
    "graph-zoom-out": chinese ? "缩小" : "Zoom out",
    "graph-zoom-reset": chinese ? "重置视图" : "Reset zoom",
  };
  for (const [id, label] of Object.entries(labels)) {
    const element = $(id);
    if (!element) continue;
    if (id === "graph-gesture-hint") {
      element.textContent = label;
    } else {
      element.title = label;
      element.setAttribute("aria-label", label);
    }
  }
  const controls = document.querySelector(".graph-zoom-controls");
  if (controls)
    controls.setAttribute(
      "aria-label",
      chinese ? "图谱缩放控件" : "Graph zoom controls",
    );
}

async function renderGraph() {
  const canvas = $("graph-canvas");
  updateGraphControlLanguage();
  canvas.innerHTML = `<div class="empty-state">${esc(t("Loading graph…"))}</div>`;
  try {
    const graph = await api(`${projectPath()}/knowledge/graph`);
    state.graph = graph;
    const nodes = graph.nodes || [];
    const edges = graph.edges || [];
    $("graph-summary").textContent =
      `${nodes.length} ${window.basicMemoryI18n.locale === "zh-CN" ? "篇笔记" : nodes.length === 1 ? "note" : "notes"} · ${edges.length} ${t("connections")}`;
    if (!nodes.length) {
      canvas.innerHTML =
        `<div class="empty-state">${esc(t("Your graph will grow as notes connect to each other."))}</div>`;
      return;
    }
    const width = graphBaseViewBox.width,
      height = graphBaseViewBox.height,
      cx = width / 2,
      cy = height / 2;
    const points = new Map(
      nodes.map((node, index) => {
        const angle = (index / nodes.length) * Math.PI * 2;
        const radius = 50 + (index % 4) * 29;
        return [
          node.external_id,
          {
            x: cx + Math.cos(angle) * radius * 2.3,
            y: cy + Math.sin(angle) * radius * 1.65,
          },
        ];
      }),
    );
    const edgeSvg = edges
      .map((edge) => {
        const a = points.get(edge.from_id),
          b = points.get(edge.to_id);
        return a && b
          ? `<line class="graph-edge" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`
          : "";
      })
      .join("");
    const nodeSvg = nodes
      .map((node, index) => {
        const point = points.get(node.external_id);
        const label =
          node.title.length > 21 ? `${node.title.slice(0, 19)}…` : node.title;
        return `<g class="graph-node" data-graph-note="${esc(node.external_id)}"><circle cx="${point.x}" cy="${point.y}" r="${index === 0 ? 24 : 18}"/><text x="${point.x}" y="${point.y + 36}">${esc(label)}</text></g>`;
      })
      .join("");
    canvas.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Knowledge graph">${edgeSvg}${nodeSvg}</svg>`;
    const svg = canvas.querySelector("svg");
    updateGraphViewport(svg);
    bindGraphGestures(canvas, svg);
    canvas
      .querySelectorAll("[data-graph-note]")
      .forEach((node) =>
        node.addEventListener("click", () => {
          if (Date.now() - lastGraphDragAt < 150) return;
          openNote(node.dataset.graphNote);
        }),
      );
  } catch (error) {
    canvas.innerHTML = `<div class="empty-state">${esc(t("Graph could not be loaded: "))}${esc(error.message)}</div>`;
  }
}

function renderActivity() {
  const items = [...state.notes]
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
    .slice(0, 50);
  $("activity-list").innerHTML = items.length
    ? items
        .map(
          (note) =>
            `<div class="activity-item" data-activity-note="${esc(note.external_id)}"><div class="activity-icon">✳</div><div><div class="activity-title">${esc(fileTitle(note))}</div><div class="activity-path">${esc(note.file_path || "Markdown note")}</div></div><div class="activity-time">${esc(fmtDate(note.updated_at))}</div></div>`,
        )
        .join("")
    : `<div class="empty-state">${esc(t("There is no recent activity yet."))}</div>`;
  $("activity-list")
    .querySelectorAll("[data-activity-note]")
    .forEach((item) =>
      item.addEventListener("click", () => openNote(item.dataset.activityNote)),
    );
}

function wrapSelection(marker) {
  if (state.mode === "rich") {
    $("note-rich").focus();
    document.execCommand(marker === "**" ? "bold" : "italic");
    updateSourceFromRichEditor();
    queueSave();
    return;
  }
  const input = $("note-source");
  const start = input.selectionStart,
    end = input.selectionEnd;
  const selected = input.value.slice(start, end) || "text";
  input.setRangeText(`${marker}${selected}${marker}`, start, end, "select");
  queueSave();
  input.focus();
}
function prefixLine(marker) {
  if (state.mode === "rich") {
    $("note-rich").focus();
    document.execCommand(
      marker.startsWith("#") ? "formatBlock" : "insertUnorderedList",
      false,
      marker.startsWith("#") ? "<h2>" : undefined,
    );
    updateSourceFromRichEditor();
    queueSave();
    return;
  }
  const input = $("note-source");
  const start = input.selectionStart;
  const lineStart = input.value.lastIndexOf("\n", start - 1) + 1;
  input.setRangeText(marker, lineStart, lineStart, "end");
  queueSave();
  input.focus();
}

document
  .querySelectorAll("[data-view]")
  .forEach((button) =>
    button.addEventListener("click", () => showView(button.dataset.view)),
  );
$("sort-notes").addEventListener("click", () => {
  state.sort =
    state.sort === "updated_desc"
      ? "title_asc"
      : state.sort === "title_asc"
        ? "updated_asc"
        : "updated_desc";
  $("sort-notes").innerHTML =
    `<span>${esc(t(state.sort === "title_asc" ? "Title A–Z" : state.sort === "updated_asc" ? "Least recent" : "Recently updated"))}</span> <span>⌄</span>`;
  renderNotes();
});
document.querySelectorAll("[data-tab]").forEach((button) =>
  button.addEventListener("click", () => {
    state.tab = button.dataset.tab;
    if (state.tab === "pinned") state.view = "pinned";
    else if (state.view === "pinned") state.view = "all";
    setActiveNav(state.view);
    document
      .querySelectorAll("[data-tab]")
      .forEach((tab) => tab.classList.toggle("active", tab === button));
    renderNotes();
  }),
);
document.querySelectorAll("[data-mode]").forEach((button) =>
  button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    if (state.mode === "rich") hydrateRichEditor();
    renderEditor();
  }),
);
$("new-note").addEventListener("click", createNote);
$("welcome-new-note").addEventListener("click", createNote);
$("new-folder").addEventListener("click", createInNewFolder);
$("refresh").addEventListener("click", () =>
  reloadProject().catch((error) => toast(error.message)),
);
$("open-sidebar").addEventListener("click", () =>
  $("sidebar").classList.add("open"),
);
$("close-sidebar").addEventListener("click", () =>
  $("sidebar").classList.remove("open"),
);
$("open-list").addEventListener("click", () =>
  $("list-pane").classList.add("mobile-open"),
);
$("list-open-sidebar").addEventListener("click", () =>
  $("sidebar").classList.add("open"),
);
$("project-switcher").addEventListener("click", async () => {
  if (state.projects.length < 2) {
    toast(t("Only one project is configured"));
    return;
  }
  const choices = state.projects
    .map((project, index) => `${index + 1}. ${project.name}`)
    .join("\n");
  const answer = prompt(`${t("Switch project (enter number):\n")}${choices}`, "1");
  const chosen = state.projects[Number(answer) - 1];
  if (chosen) {
    state.project = chosen;
    state.selected = null;
    await reloadProject();
    showView("all");
  }
});
$("open-search").addEventListener("click", openSearch);
$("search-input").addEventListener("input", () => {
  clearTimeout(searchNotes.timer);
  searchNotes.timer = setTimeout(
    () => searchNotes($("search-input").value),
    220,
  );
});
$("search-input").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    state.searchIndex = Math.max(
      0,
      Math.min(
        state.searchResults.length - 1,
        state.searchIndex + (event.key === "ArrowDown" ? 1 : -1),
      ),
    );
    document
      .querySelectorAll(".search-result")
      .forEach((item, index) =>
        item.classList.toggle("active", index === state.searchIndex),
      );
  }
  if (event.key === "Enter") selectSearchResult(state.searchIndex);
});
$("modal").addEventListener("click", (event) => {
  if (event.target === $("modal")) $("modal").classList.add("hidden");
});
$("pin-note").addEventListener("click", togglePin);
$("more-note").addEventListener("click", () => {
  const rect = $("more-note").getBoundingClientRect();
  $("note-menu").style.top = `${rect.bottom + 4}px`;
  $("note-menu").style.right = `${Math.max(8, innerWidth - rect.right)}px`;
  $("note-menu").classList.toggle("hidden");
});
$("delete-note").addEventListener("click", () => {
  $("note-menu").classList.add("hidden");
  removeNote();
});
$("rename-note").addEventListener("click", () => {
  $("note-menu").classList.add("hidden");
  $("note-title").focus();
  $("note-title").select();
});
$("note-source").addEventListener("input", queueSave);
$("note-title").addEventListener("input", queueSave);
$("note-rich").addEventListener("input", () => {
  updateSourceFromRichEditor();
  queueSave();
});
document
  .querySelectorAll("[data-wrap]")
  .forEach((button) =>
    button.addEventListener("click", () => wrapSelection(button.dataset.wrap)),
  );
document
  .querySelectorAll("[data-prefix]")
  .forEach((button) =>
    button.addEventListener("click", () => prefixLine(button.dataset.prefix)),
  );
$("insert-link").addEventListener("click", () => {
  if (state.mode === "rich") {
    const url = prompt(t("Link URL"), "https://");
    if (!url) return;
    $("note-rich").focus();
    document.execCommand("createLink", false, url);
    updateSourceFromRichEditor();
    queueSave();
    return;
  }
  const input = $("note-source");
  const start = input.selectionStart,
    end = input.selectionEnd;
  const label = input.value.slice(start, end) || t("link text");
  input.setRangeText(`[${label}](https://)`, start, end, "select");
  queueSave();
  input.focus();
});
$("graph-refresh").addEventListener("click", renderGraph);
$("graph-zoom-in").addEventListener("click", () => zoomGraph(0.8));
$("graph-zoom-out").addEventListener("click", () => zoomGraph(1.25));
$("graph-zoom-reset").addEventListener("click", resetGraphViewport);
$("activity-refresh").addEventListener("click", renderActivity);
$("graph-filter").addEventListener("input", (event) => {
  const query = event.target.value.toLowerCase();
  document.querySelectorAll(".graph-node").forEach((node) => {
    const label = node.querySelector("text")?.textContent.toLowerCase() || "";
    node.style.opacity = !query || label.includes(query) ? "1" : ".15";
  });
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openSearch();
  }
  if (event.key === "Escape") {
    $("modal").classList.add("hidden");
    $("note-menu").classList.add("hidden");
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveNote();
  }
});
boot();

document.addEventListener("bm-language-change", () => {
  renderTree();
  renderNotes();
  if (state.selected) {
    $("save-status").textContent = state.dirty ? t("Unsaved changes") : t("Saved");
    renderRelations();
    renderEditor();
  }
  if (state.view === "graph") renderGraph();
  if (state.view === "activity") renderActivity();
});
