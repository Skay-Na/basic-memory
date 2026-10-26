(() => {
  const translations = {
    "Switch to English": "切换到英文",
    "Switch to Chinese": "切换到中文",
    "Personal workspace": "个人空间",
    "Search anything": "搜索记忆",
    "All notes": "全部笔记",
    Pinned: "已固定",
    "Knowledge graph": "知识图谱",
    Activity: "动态",
    "YOUR PROJECT": "当前项目",
    "Create a note in a new folder": "在新文件夹中新建笔记",
    "Loading folders…": "正在加载文件夹…",
    "No folders yet": "暂无文件夹",
    "Drop a note here to move it": "将记忆文档拖到此文件夹以移动",
    "Drag to move note": "拖动到文件夹以移动",
    "Save the note before moving it": "请先保存记忆文档再移动",
    "Note moved": "记忆文档已移动",
    "Could not move note: ": "无法移动记忆文档：",
    "Note moved, but refresh failed: ": "记忆文档已移动，但刷新失败：",
    "Local knowledge base": "本地知识库",
    "Account settings": "账户设置",
    "Memory maintenance settings": "记忆整理设置",
    "PROJECT SETTINGS": "项目设置",
    "Set when the agent should review memories. Either condition can trigger a review. Codex memory maintenance must be enabled.": "设置 agent 何时整理记忆。任一条件达到时都会触发整理；还需在 Codex 中启用记忆整理。",
    "Review after": "间隔",
    days: "天",
    "Or after": "或达到",
    "different notes": "篇不同笔记",
    "Either threshold triggers a review.": "任一阈值达到后都会触发整理。",
    "Close settings": "关闭设置",
    Cancel: "取消",
    "Save settings": "保存设置",
    "Settings saved": "设置已保存",
    "Could not load settings: ": "无法加载设置：",
    "Could not save settings: ": "无法保存设置：",
    "Please enter valid thresholds.": "请输入有效的阈值。",
    Refresh: "刷新",
    "YOUR KNOWLEDGE": "知识库",
    "New note": "新建笔记",
    "Pinned notes": "固定笔记",
    "Recently updated": "最近更新",
    "Title A–Z": "标题 A–Z",
    "Least recent": "最早更新",
    "Loading your notes…": "正在加载笔记…",
    "Markdown, always yours": "你的 Markdown，由你掌控",
    "A SPACE FOR WHAT MATTERS": "收纳重要想法的空间",
    "Your thoughts, connected.": "让想法彼此连接。",
    "Choose a note to read, or start with a blank page. Your knowledge stays in plain Markdown files.": "选择一篇笔记开始阅读，或创建空白笔记。你的知识始终保存在普通 Markdown 文件中。",
    "Create your first note": "创建第一篇笔记",
    "Close sidebar": "关闭导航",
    "Open navigation": "打开导航",
    "Browse notes": "浏览笔记",
    Saved: "已保存",
    "Pin note": "固定笔记",
    "More actions": "更多操作",
    Write: "撰写",
    Source: "源码",
    Preview: "预览",
    Bold: "粗体",
    Italic: "斜体",
    Heading: "标题",
    List: "列表",
    Link: "链接",
    MARKDOWN: "MARKDOWN",
    "Note title": "笔记标题",
    "Markdown source": "Markdown 源码",
    "Write note": "撰写笔记",
    "CONNECTED TO": "关联内容",
    "SEE THE BIG PICTURE": "纵览全局",
    "Refresh graph": "刷新图谱",
    "Notes connected by ideas": "由想法连接的笔记",
    "Hold and drag to pan · scroll to zoom": "按住拖动平移 · 滚动缩放",
    "Zoom in": "放大",
    "Zoom out": "缩小",
    "Reset zoom": "重置视图",
    "Find a note…": "查找笔记…",
    Note: "笔记",
    Concept: "概念",
    "Lines show relationships": "连线表示关系",
    "YOUR WORKSPACE": "你的工作区",
    "Recent activity": "最近动态",
    "Refresh activity": "刷新动态",
    "Recent notes and changes in your knowledge base.": "知识库中最近的笔记和变更。",
    "Search notes": "搜索笔记",
    "Search your notes…": "搜索你的笔记…",
    "SEARCHING IN": "搜索范围",
    "Type to search notes and ideas": "输入内容以搜索笔记和想法",
    "↑↓ Navigate": "↑↓ 移动",
    "↵ Open note": "↵ 打开笔记",
    "ESC Close": "ESC 关闭",
    "Rename note": "重命名笔记",
    "Delete note": "删除笔记",
    "No pinned notes yet. Pin a note to keep it close.": "还没有固定的笔记。固定笔记后可在这里快速访问。",
    "No notes in this folder yet.": "此文件夹中还没有笔记。",
    "Create a note": "新建笔记",
    TODAY: "今天",
    YESTERDAY: "昨天",
    "RECENTLY UPDATED": "最近更新",
    NOTES: "笔记",
    words: "字",
    connections: "条关系",
    "Notes you link will appear here.": "关联笔记会显示在这里。",
    "Searching…": "正在搜索…",
    "Markdown note": "Markdown 笔记",
    "New folder name": "新文件夹名称",
    "Link URL": "链接地址",
    "link text": "链接文字",
    "Move “": "将“",
    "” to trash? This deletes the Markdown file.": "”移到废纸篓？这会删除对应的 Markdown 文件。",
    "Could not open note: ": "无法打开笔记：",
    "Could not create note: ": "无法创建笔记：",
    "Could not delete note: ": "无法删除笔记：",
    "Search unavailable: ": "搜索不可用：",
    "Graph could not be loaded: ": "无法加载图谱：",
    "No Basic Memory project is configured. Add a project with `bm project add`.": "尚未配置 Basic Memory 项目。请使用 `bm project add` 添加项目。",
    "Could not connect to Basic Memory.": "无法连接到 Basic Memory。",
    "Start the web server with `basic-memory web`.": "请先启动 Web 服务：`basic-memory web`。",
    "Note saved": "笔记已保存",
    "Note deleted": "笔记已删除",
    "Note created": "笔记已创建",
    "Note pinned": "笔记已固定",
    "Pin removed": "已取消固定",
    "Only one project is configured": "目前只配置了一个项目",
    "Switch project (enter number):\n": "切换项目（输入序号）：\n",
    "No matching notes": "没有找到匹配的笔记",
    "That linked note could not be resolved.": "无法找到这条关联笔记。",
    "Your graph will grow as notes connect to each other.": "笔记之间建立关联后，图谱会在这里逐渐展开。",
    "There is no recent activity yet.": "还没有最近动态。",
    Conflict: "发生冲突",
    "Saving…": "正在保存…",
    "Unsaved changes": "有未保存的更改",
    "Save failed": "保存失败",
    "Frontmatter": "元数据",
    "Click a note to open it": "点击笔记即可打开",
  };

  let locale = localStorage.getItem("bm-language") || "zh-CN";
  const translate = (value) =>
    locale === "zh-CN" ? (translations[value] ?? value) : value;

  function apply() {
    document.documentElement.lang = locale;
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      element.textContent = translate(element.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-html]").forEach((element) => {
      element.innerHTML = translate(element.dataset.i18nHtml);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
      element.placeholder = translate(element.dataset.i18nPlaceholder);
    });
    document.querySelectorAll("[data-i18n-title]").forEach((element) => {
      element.title = translate(element.dataset.i18nTitle);
    });
    document.querySelectorAll("[data-i18n-aria]").forEach((element) => {
      element.setAttribute("aria-label", translate(element.dataset.i18nAria));
    });
    const toggle = document.getElementById("language-toggle");
    if (toggle) {
      toggle.textContent = locale === "zh-CN" ? "EN" : "中文";
      toggle.title = translate(
        locale === "zh-CN" ? "Switch to English" : "Switch to Chinese",
      );
      toggle.setAttribute("aria-label", toggle.title);
    }
  }

  window.basicMemoryI18n = { t: translate, get locale() { return locale; } };
  document.addEventListener("DOMContentLoaded", apply, { once: true });
  document.addEventListener("click", (event) => {
    if (event.target.closest("#language-toggle")) {
      locale = locale === "zh-CN" ? "en" : "zh-CN";
      localStorage.setItem("bm-language", locale);
      apply();
      document.dispatchEvent(new Event("bm-language-change"));
    }
  });
  apply();
})();
