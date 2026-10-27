const state = {
  projects: [],
  project: null,
  tree: null,
  treeSignature: "",
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
  movingNoteId: null,
  sessionPreviews: new Map(),
  sessionPreviewLoads: new Set(),
};
const $ = (id) => document.getElementById(id);
const t = (value) => window.basicMemoryI18n.t(value);
const graphBaseViewBox = { x: 0, y: 0, width: 900, height: 560 };
let graphViewBox = { ...graphBaseViewBox };
let graphPointer = null;
let lastGraphDragAt = 0;
let graphCleanup = () => {};
let graphRenderVersion = 0;
let graphMaintenanceTimer = null;
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
const noteFolder = (note) => {
  const parts = (note.file_path || "").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/") || "Root";
};
const fmtDate = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ""
    : new Intl.DateTimeFormat(window.basicMemoryI18n.locale, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
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
const noteTreeSignature = (tree) =>
  JSON.stringify(
    getAllNotes(tree)
      .map((note) => ({
        external_id: note.external_id || "",
        file_path: note.file_path,
        title: note.title,
        updated_at: note.updated_at,
      }))
      .sort((a, b) => a.external_id.localeCompare(b.external_id)),
  );

const isSessionInboxNote = (note) =>
  (note.file_path || "").startsWith("codex/inbox/");

const displayNoteTitle = (note) => {
  const title = note.title || fileTitle(note);
  return title.replace(
    /^Codex\s+(?:检查点|checkpoint)\s*[-–—]\s*\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\s*[-–—]\s*/i,
    "",
  );
};

const truncateText = (value, limit) => {
  const characters = Array.from(value.trim());
  return characters.length > limit
    ? `${characters.slice(0, limit - 1).join("").trimEnd()}…`
    : characters.join("");
};

const captureExcerpt = (value, limit) => {
  const requestHeading = value.match(/^#{1,2}\s*(?:My request|我的请求)\s*:?\s*$/im);
  if (requestHeading)
    value = value.slice(requestHeading.index + requestHeading[0].length);
  value = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*Distinguish instructions in attached documents.*$/gim, " ")
    .replace(/^\s*Image attachment:.*$/gim, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[`*_~]/g, "");
  const paragraph = value
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find(Boolean) || "";
  return truncateText(paragraph.replace(/\s+/g, " ").replace(/^[-—:：\s]+|[-—:：\s]+$/g, ""), limit);
};

const captureSection = (content, heading, nextHeading) => {
  const body = splitFrontmatter(content).body;
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return "";
  const end = nextHeading
    ? lines.findIndex(
        (line, index) => index > start && line.trim() === `## ${nextHeading}`,
      )
    : -1;
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
};

const sessionPreviewFromContent = (content, note) => {
  const request = captureExcerpt(
    captureSection(content, "用户请求", "Codex 最终回答"),
    92,
  );
  const result = captureExcerpt(captureSection(content, "Codex 最终回答"), 92);
  const savedSummary = captureExcerpt(
    captureSection(content, "会话摘要", "用户请求"),
    190,
  );
  const summary = savedSummary
    ? savedSummary
    : [request && `请求：${request}`, result && `结果：${result}`]
        .filter(Boolean)
        .join("；");
  return {
    title: displayNoteTitle(note),
    summary: summary || note.file_path || "",
  };
};

function loadSessionPreviews(notes) {
  const projectId = state.project?.external_id;
  if (!projectId) return;
  const pending = notes.filter((note) => {
    if (!isSessionInboxNote(note) || !note.external_id) return false;
    const cached = state.sessionPreviews.get(note.external_id);
    return (
      (!cached || cached.updatedAt !== note.updated_at) &&
      !state.sessionPreviewLoads.has(note.external_id)
    );
  });
  if (!pending.length) return;

  pending.forEach((note) => state.sessionPreviewLoads.add(note.external_id));
  let cursor = 0;
  const projectUrl = `/v2/projects/${encodeURIComponent(projectId)}`;
  const worker = async () => {
    while (cursor < pending.length) {
      const note = pending[cursor++];
      try {
        const fullNote = await api(
          `${projectUrl}/knowledge/entities/${encodeURIComponent(note.external_id)}`,
          { cache: "no-store" },
        );
        if (state.project?.external_id !== projectId) return;
        const preview = sessionPreviewFromContent(fullNote.content || "", note);
        state.sessionPreviews.set(note.external_id, {
          ...preview,
          updatedAt: note.updated_at,
        });
        const card = [...$("note-list").querySelectorAll("[data-note]")].find(
          (element) => element.dataset.note === note.external_id,
        );
        if (card) {
          card.querySelector(".note-card-title-text").textContent = preview.title;
          card.querySelector(".note-card-preview").textContent = preview.summary;
        }
      } catch {
        state.sessionPreviews.set(note.external_id, {
          title: displayNoteTitle(note),
          summary: t("Summary unavailable"),
          updatedAt: note.updated_at,
        });
        const card = [...$("note-list").querySelectorAll("[data-note]")].find(
          (element) => element.dataset.note === note.external_id,
        );
        if (card) card.querySelector(".note-card-preview").textContent = t("Summary unavailable");
      } finally {
        state.sessionPreviewLoads.delete(note.external_id);
      }
    }
  };
  void Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
}

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
  state.treeSignature = noteTreeSignature(state.tree);
  state.notes = getAllNotes(state.tree).sort(
    (a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0),
  );
  renderTree();
  renderNotes();
}

async function openMaintenanceSettings() {
  try {
    const settings = await api(`${projectPath()}/memory-maintenance/settings`, {
      cache: "no-store",
    });
    $("maintenance-interval-days").value = settings.interval_days;
    $("maintenance-note-threshold").value = settings.note_threshold;
    $("maintenance-modal").classList.remove("hidden");
    $("maintenance-interval-days").focus();
  } catch (error) {
    toast(`${t("Could not load settings: ")}${error.message}`);
  }
}

async function saveMaintenanceSettings(event) {
  event.preventDefault();
  const intervalDays = Number($("maintenance-interval-days").value);
  const noteThreshold = Number($("maintenance-note-threshold").value);
  if (
    !Number.isInteger(intervalDays) ||
    intervalDays < 1 ||
    intervalDays > 365 ||
    !Number.isInteger(noteThreshold) ||
    noteThreshold < 1 ||
    noteThreshold > 1000
  ) {
    toast(t("Please enter valid thresholds."));
    return;
  }

  const save = $("maintenance-save");
  save.disabled = true;
  try {
    await api(`${projectPath()}/memory-maintenance/settings`, {
      method: "PUT",
      body: JSON.stringify({
        interval_days: intervalDays,
        note_threshold: noteThreshold,
      }),
    });
    $("maintenance-modal").classList.add("hidden");
    toast(t("Settings saved"));
  } catch (error) {
    toast(`${t("Could not save settings: ")}${error.message}`);
  } finally {
    save.disabled = false;
  }
}

async function refreshProjectIfChanged() {
  if (!state.project || document.hidden || refreshProjectIfChanged.inFlight)
    return;
  refreshProjectIfChanged.inFlight = true;
  const projectId = state.project.external_id;
  const projectUrl = `/v2/projects/${encodeURIComponent(projectId)}`;
  try {
    const tree = await api(`${projectUrl}/directory/tree`, { cache: "no-store" });
    if (state.project?.external_id !== projectId) return;
    const signature = noteTreeSignature(tree);
    if (signature === state.treeSignature) return;

    state.tree = tree;
    state.treeSignature = signature;
    state.notes = getAllNotes(tree).sort(
      (a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0),
    );
    renderTree();
    renderNotes();
    if (state.view === "activity") renderActivity();
    if (state.view === "graph") renderGraph();

    const selectedId = state.selected?.external_id;
    if (!selectedId || state.dirty) return;
    const selectedStillExists = state.notes.some(
      (note) => note.external_id === selectedId,
    );
    if (!selectedStillExists) {
      state.selected = null;
      $("note-workspace").classList.add("hidden");
      if (state.view !== "graph" && state.view !== "activity")
        $("welcome-state").classList.remove("hidden");
      history.replaceState(null, "", "/");
      return;
    }

    const current = state.selected;
    const latest = await api(
      `${projectUrl}/knowledge/entities/${encodeURIComponent(selectedId)}`,
      { cache: "no-store" },
    );
    if (
      state.project?.external_id !== projectId ||
      state.selected?.external_id !== selectedId ||
      state.selected !== current ||
      state.dirty ||
      (latest.content === current.content &&
        latest.title === current.title &&
        latest.file_path === current.file_path &&
        latest.updated_at === current.updated_at)
    )
      return;

    state.selected = latest;
    $("note-title").value = latest.title || "";
    $("note-source").value = latest.content || "";
    if (state.mode === "rich") hydrateRichEditor();
    $("note-type-badge").textContent = (latest.note_type || "note").toUpperCase();
    $("file-path").textContent = latest.file_path || "";
    $("breadcrumbs").innerHTML =
      `<span>${esc(state.project.name)}</span>  /  ${esc(latest.file_path || "")}`;
    $("save-status").textContent = t("Saved");
    renderRelations();
    renderEditor();
  } catch {
    // External sync can briefly lag behind the file write; the next poll retries.
  } finally {
    refreshProjectIfChanged.inFlight = false;
  }
}

function startLiveUpdates() {
  window.setInterval(refreshProjectIfChanged, 5000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshProjectIfChanged();
  });
}

function renderTree() {
  if (!state.tree) return;
  const tree = $("folder-tree");
  const row = (node, level = 0) => {
    if (node.type === "file") {
      if (!(node.content_type || "").includes("markdown") || !node.external_id)
        return "";
      return `<button type="button" draggable="true" class="tree-row tree-file-row ${state.selected?.external_id === node.external_id ? "selected" : ""} ${state.movingNoteId === node.external_id ? "moving" : ""}" data-level="${level}" data-note="${esc(node.external_id)}" style="--tree-depth:${Math.min(level, 8)};padding-left:${8 + Math.min(level, 8) * 16}px;opacity:${state.movingNoteId === node.external_id ? 0.55 : 1}" title="${esc(t("Drag to move note"))} · ${esc(node.file_path || node.name)}"><span class="tree-caret"></span><span class="file-icon">▱</span><span class="tree-name">${esc(displayNoteTitle(node))}</span></button>`;
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
    {
      element.addEventListener("click", () => openNote(element.dataset.note));
      element.addEventListener("dragstart", (event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", element.dataset.note);
        element.classList.add("dragging");
        element.style.opacity = "0.55";
      });
      element.addEventListener("dragend", () => {
        element.classList.remove("dragging");
        element.style.opacity = "";
      });
    },
  );
  tree.querySelectorAll("[data-folder]").forEach((element) => {
    element.title = t("Drop a note here to move it");
    element.addEventListener("dragover", (event) => {
      if (!Array.from(event.dataTransfer.types).includes("text/plain")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      element.classList.add("drop-target");
      element.style.backgroundColor = "var(--surface-raised, rgba(70, 130, 90, 0.14))";
      element.style.boxShadow = "inset 3px 0 var(--accent, #4a8c68)";
    });
    element.addEventListener("dragleave", (event) => {
      if (!element.contains(event.relatedTarget)) {
        element.classList.remove("drop-target");
        element.style.backgroundColor = "";
        element.style.boxShadow = "";
      }
    });
    element.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      element.classList.remove("drop-target");
      element.style.backgroundColor = "";
      element.style.boxShadow = "";
      const noteId = event.dataTransfer.getData("text/plain");
      if (noteId) moveNoteToFolder(noteId, element.dataset.folder);
    });
  });
}

async function moveNoteToFolder(noteId, destinationFolder) {
  if (state.movingNoteId) return;
  const note = state.notes.find((item) => item.external_id === noteId);
  if (!note) return;
  const filename = (note.file_path || "").split("/").pop();
  if (!filename) return;
  const destinationPath = [relativeDir(destinationFolder), filename].filter(Boolean).join("/");
  if (destinationPath === note.file_path) return;

  state.movingNoteId = noteId;
  renderTree();
  let moveAccepted = false;
  try {
    if (state.selected?.external_id === noteId && state.dirty) {
      clearTimeout(state.saveTimer);
      await saveNote();
      if (state.dirty) throw new Error(t("Save the note before moving it"));
    }
    const current = await api(
      `${projectPath()}/knowledge/entities/${encodeURIComponent(noteId)}`,
      { cache: "no-store" },
    );
    const moved = await api(
      `${projectPath()}/knowledge/entities/${encodeURIComponent(noteId)}/move`,
      {
        method: "PUT",
        headers: current.db_checksum
          ? { "x-bm-cloud-note-base-checksum": current.db_checksum }
          : {},
        body: JSON.stringify({ destination_path: destinationPath }),
      },
    );
    moveAccepted = true;
    await reloadProject();
    state.folder = destinationFolder;
    renderTree();
    renderNotes();
    if (state.view === "activity") renderActivity();
    if (state.view === "graph") renderGraph();
    if (state.selected?.external_id === noteId) await openNote(noteId);
    toast(t("Note moved"));
    return moved;
  } catch (error) {
    const message = moveAccepted
      ? `${t("Note moved, but refresh failed: ")}${error.message}`
      : `${t("Could not move note: ")}${error.message}`;
    toast(message);
  } finally {
    state.movingNoteId = null;
    renderTree();
  }
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
      const sessionNote = isSessionInboxNote(note);
      const preview = state.sessionPreviews.get(note.external_id);
      const hasCurrentPreview = preview && preview.updatedAt === note.updated_at;
      const title = hasCurrentPreview ? preview.title : displayNoteTitle(note);
      const excerpt =
        hasCurrentPreview
          ? preview.summary
          : sessionNote
            ? t("Loading overview…")
            : noteFolder(note) || note.note_type || "Markdown note";
      return `${heading}<article class="note-card ${state.selected?.external_id === note.external_id ? "selected" : ""}" data-note="${esc(note.external_id)}"><div class="note-card-title">${state.pinned.has(note.external_id) ? '<span aria-label="Pinned">♢</span>' : ""}<span class="note-card-title-text">${esc(title)}</span></div><div class="note-card-preview">${esc(excerpt)}</div><div class="note-card-meta"><i class="note-type-dot"></i>${esc(note.note_type || "note")}<span>·</span>${esc(fmtDate(note.updated_at))}</div></article>`;
    })
    .join("");
  list
    .querySelectorAll("[data-note]")
    .forEach((card) =>
      card.addEventListener("click", () => openNote(card.dataset.note)),
    );
  loadSessionPreviews(notes);
}

function setActiveNav(view) {
  document
    .querySelectorAll(".nav-item")
    .forEach((item) =>
      item.classList.toggle("active", item.dataset.view === view),
    );
}
function showView(view) {
  if (view !== "graph") {
    graphRenderVersion += 1;
    graphCleanup();
    clearInterval(graphMaintenanceTimer);
    graphMaintenanceTimer = null;
  }
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
    graphRenderVersion += 1;
    graphCleanup();
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

function graphNoteOverview(content, title) {
  const body = splitFrontmatter(content).body;
  const summary = body.match(
    /^#{1,6}\s+(?:Summary|Overview|摘要|概述|简介)[ \t]*\r?\n([\s\S]*)/im,
  );
  const preview = document.createElement("div");
  preview.innerHTML = markdownParser.render(summary ? summary[1].split(/^#{1,6}\s/m)[0] : body);
  preview.querySelectorAll("h1,h2,h3,h4,h5,h6,pre,table").forEach((el) => el.remove());
  let text = (preview.textContent || "").replace(/\s+/g, " ").trim();
  if (text.startsWith(title)) text = text.slice(title.length).trim();
  const characters = Array.from(text);
  return characters.slice(0, 220).join("") + (characters.length > 220 ? "…" : "");
}

function maintenanceColor(lastMaintainedAt) {
  const ageDays = Math.max(0, (Date.now() - new Date(lastMaintainedAt).getTime()) / 86400000);
  const stops = [
    { day: 0, fill: [91, 157, 109], stroke: [66, 123, 82] },
    { day: 30, fill: [222, 184, 99], stroke: [174, 132, 56] },
    { day: 60, fill: [201, 196, 181], stroke: [156, 148, 126] },
  ];
  const start = ageDays < 30 ? stops[0] : stops[1];
  const end = ageDays < 30 ? stops[1] : stops[2];
  const ratio = Math.min(1, Math.max(0, (ageDays - start.day) / (end.day - start.day)));
  const blend = (from, to) =>
    `rgb(${from.map((channel, index) => Math.round(channel + (to[index] - channel) * ratio)).join(" ")})`;
  return { fill: blend(start.fill, end.fill), stroke: blend(start.stroke, end.stroke) };
}

function updateGraphMaintenanceColors() {
  document.querySelectorAll(".graph-node[data-maintained-at]").forEach((node) => {
    const colors = maintenanceColor(node.dataset.maintainedAt);
    node.style.setProperty("--maintenance-fill", colors.fill);
    node.style.setProperty("--maintenance-stroke", colors.stroke);
  });
}

function animateGraph(canvas, svg, nodes, points, projectUrl) {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const controller = new AbortController();
  const previews = new Map();
  const tooltip = document.createElement("div");
  tooltip.className = "graph-tooltip";
  tooltip.id = "graph-node-overview";
  tooltip.role = "tooltip";
  tooltip.hidden = true;
  tooltip.innerHTML = '<div class="graph-tooltip-type"></div><div class="graph-tooltip-title"></div><div class="graph-tooltip-maintenance"></div><p class="graph-tooltip-summary"></p>';
  canvas.append(tooltip);
  const nodeElements = [...svg.querySelectorAll("[data-graph-note]")];
  const edgeElements = [...svg.querySelectorAll(".graph-edge")];
  let active = null;
  let hoverTimer;
  let animationFrame;
  let disposed = false;
  const startedAt = performance.now();
  let lastFrameAt = startedAt;

  const positionTooltip = () => {
    if (!active || tooltip.hidden) return;
    const bounds = canvas.getBoundingClientRect();
    const anchor = active.element.querySelector("circle").getBoundingClientRect();
    const left = anchor.left - bounds.left + anchor.width / 2;
    const above = anchor.top - bounds.top - tooltip.offsetHeight - 14;
    tooltip.style.left = `${Math.max(12, Math.min(left - tooltip.offsetWidth / 2, canvas.clientWidth - tooltip.offsetWidth - 12))}px`;
    tooltip.style.top = `${Math.max(12, Math.min(above >= 12 ? above : anchor.bottom - bounds.top + 14, canvas.clientHeight - tooltip.offsetHeight - 12))}px`;
  };
  const hideTooltip = () => {
    clearTimeout(hoverTimer);
    active?.element.removeAttribute("aria-describedby");
    active = null;
    tooltip.hidden = true;
  };
  const showTooltip = (node, element) => {
    hideTooltip();
    active = { node, element };
    element.setAttribute("aria-describedby", tooltip.id);
    const chinese = window.basicMemoryI18n.locale === "zh-CN";
    tooltip.querySelector(".graph-tooltip-type").textContent = node.note_type || (chinese ? "笔记" : "Note");
    tooltip.querySelector(".graph-tooltip-title").textContent = node.title;
    tooltip.querySelector(".graph-tooltip-maintenance").textContent = node.last_maintained_at
      ? `${chinese ? "上次整理" : "Last organized"}: ${fmtDate(node.last_maintained_at)}`
      : "";
    const summary = tooltip.querySelector(".graph-tooltip-summary");
    summary.textContent = chinese ? "正在读取概述…" : "Loading overview…";
    tooltip.hidden = false;
    positionTooltip();
    hoverTimer = setTimeout(async () => {
      try {
        if (!previews.has(node.external_id)) {
          previews.set(node.external_id, api(
            `${projectUrl}/knowledge/entities/${encodeURIComponent(node.external_id)}`,
            { signal: controller.signal },
          ).catch((error) => {
            previews.delete(node.external_id);
            throw error;
          }));
        }
        const note = await previews.get(node.external_id);
        if (disposed || active?.element !== element) return;
        summary.textContent = graphNoteOverview(note.content || "", node.title) ||
          (chinese ? "这篇笔记还没有正文概述。" : "This note has no overview yet.");
      } catch (error) {
        if (disposed || active?.element !== element) return;
        summary.textContent = chinese ? "暂时无法读取概述，点击节点打开笔记。" : "Overview unavailable. Open the note to read more.";
      }
      positionTooltip();
    }, 160);
  };

  nodeElements.forEach((element, index) => {
    const node = nodes[index];
    element.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch" && !graphPointer?.dragging) showTooltip(node, element);
    });
    element.addEventListener("pointerleave", () => {
      if (document.activeElement !== element) hideTooltip();
    });
    element.addEventListener("focus", () => showTooltip(node, element));
    element.addEventListener("blur", hideTooltip);
    element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hideTooltip();
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openNote(node.external_id);
      }
    });
  });
  const animate = (now) => {
    if (disposed || !svg.isConnected || $("graph-workspace").classList.contains("hidden")) return;
    const time = (now - startedAt) / 1000;
    const smoothing = 1 - Math.exp(-Math.min(now - lastFrameAt, 50) / 220);
    lastFrameAt = now;
    nodes.forEach((node, index) => {
      const point = points.get(node.external_id);
      if (active?.node !== node && !graphPointer?.dragging) {
        const phase = index * 2.399;
        const dx = Math.sin(time * (0.42 + (index % 3) * 0.055) + phase) * (8 + index % 5);
        const dy = Math.cos(time * (0.34 + (index % 4) * 0.04) + phase) * (6 + index % 4);
        point.dx += (dx - point.dx) * smoothing;
        point.dy += (dy - point.dy) * smoothing;
      }
      nodeElements[index].setAttribute("transform", `translate(${point.dx} ${point.dy})`);
    });
    edgeElements.forEach((element) => {
      const a = points.get(element.dataset.from), b = points.get(element.dataset.to);
      element.setAttribute("x1", a.x + a.dx);
      element.setAttribute("y1", a.y + a.dy);
      element.setAttribute("x2", b.x + b.dx);
      element.setAttribute("y2", b.y + b.dy);
    });
    positionTooltip();
    animationFrame = requestAnimationFrame(animate);
  };
  const updateMotion = () => {
    cancelAnimationFrame(animationFrame);
    if (!reducedMotion.matches) {
      lastFrameAt = performance.now();
      animationFrame = requestAnimationFrame(animate);
    }
  };
  svg.addEventListener("pointerdown", hideTooltip);
  canvas.addEventListener("wheel", positionTooltip);
  window.addEventListener("resize", positionTooltip);
  reducedMotion.addEventListener("change", updateMotion);
  updateMotion();
  return () => {
    disposed = true;
    hideTooltip();
    cancelAnimationFrame(animationFrame);
    controller.abort();
    canvas.removeEventListener("wheel", positionTooltip);
    window.removeEventListener("resize", positionTooltip);
    reducedMotion.removeEventListener("change", updateMotion);
    tooltip.remove();
  };
}

async function renderGraph() {
  const version = ++graphRenderVersion;
  graphCleanup();
  clearInterval(graphMaintenanceTimer);
  graphMaintenanceTimer = null;
  const canvas = $("graph-canvas");
  const projectUrl = projectPath();
  updateGraphControlLanguage();
  canvas.innerHTML = `<div class="empty-state">${esc(t("Loading graph…"))}</div>`;
  try {
    const graph = await api(`${projectUrl}/knowledge/graph`);
    if (version !== graphRenderVersion) return;
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
            dx: 0,
            dy: 0,
          },
        ];
      }),
    );
    const edgeSvg = edges
      .map((edge) => {
        const a = points.get(edge.from_id),
          b = points.get(edge.to_id);
        return a && b
          ? `<line class="graph-edge" data-from="${esc(edge.from_id)}" data-to="${esc(edge.to_id)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`
          : "";
      })
      .join("");
    const nodeSvg = nodes
      .map((node, index) => {
        const point = points.get(node.external_id);
        const label =
          node.title.length > 21 ? `${node.title.slice(0, 19)}…` : node.title;
        const maintainedAt = node.last_maintained_at || "";
        const maintenanceLabel = maintainedAt
          ? `${t("Last organized")}: ${fmtDate(maintainedAt)}`
          : "";
        return `<g class="graph-node${maintainedAt ? " is-maintained" : ""}" tabindex="0" role="button" aria-label="${esc([node.title, maintenanceLabel].filter(Boolean).join(" · "))}" data-graph-note="${esc(node.external_id)}"${maintainedAt ? ` data-maintained-at="${esc(maintainedAt)}"` : ""}><circle cx="${point.x}" cy="${point.y}" r="${index === 0 ? 24 : 18}"/><text x="${point.x}" y="${point.y + 36}">${esc(label)}</text></g>`;
      })
      .join("");
    canvas.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="group" aria-label="Knowledge graph">${edgeSvg}${nodeSvg}</svg>`;
    const svg = canvas.querySelector("svg");
    updateGraphMaintenanceColors();
    graphMaintenanceTimer = setInterval(() => {
      if (state.view === "graph") updateGraphMaintenanceColors();
    }, 60 * 60 * 1000);
    updateGraphViewport(svg);
    bindGraphGestures(canvas, svg);
    graphCleanup = animateGraph(canvas, svg, nodes, points, projectUrl);
    canvas
      .querySelectorAll("[data-graph-note]")
      .forEach((node) =>
        node.addEventListener("click", () => {
          if (Date.now() - lastGraphDragAt < 150) return;
          openNote(node.dataset.graphNote);
        }),
      );
  } catch (error) {
    if (version !== graphRenderVersion) return;
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
            `<div class="activity-item" data-activity-note="${esc(note.external_id)}"><div class="activity-icon">✳</div><div><div class="activity-title">${esc(displayNoteTitle(note))}</div><div class="activity-path">${esc(noteFolder(note) || "Markdown note")}</div></div><div class="activity-time">${esc(fmtDate(note.updated_at))}</div></div>`,
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
$("maintenance-settings").addEventListener("click", openMaintenanceSettings);
$("maintenance-form").addEventListener("submit", saveMaintenanceSettings);
$("maintenance-cancel").addEventListener("click", () =>
  $("maintenance-modal").classList.add("hidden"),
);
$("maintenance-close").addEventListener("click", () =>
  $("maintenance-modal").classList.add("hidden"),
);
$("maintenance-modal").addEventListener("click", (event) => {
  if (event.target === $("maintenance-modal"))
    $("maintenance-modal").classList.add("hidden");
});
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
    $("maintenance-modal").classList.add("hidden");
    $("note-menu").classList.add("hidden");
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveNote();
  }
});
boot().finally(startLiveUpdates);

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
