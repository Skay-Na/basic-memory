const $ = (id) => document.getElementById(id);
const control = "http://127.0.0.1:18895";
const labels = { codex: "Codex", antigravity: "Antigravity", dsh: "DSH", opencode: "OpenCode" };
const state = { projects: [], agents: [], cwd: "", busy: false };
const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

async function loadCaptureSetting() {
  const project = $("capture-project").value;
  if (!project) return;
  try {
    const data = await request(`/api/capture-settings/${encodeURIComponent(project)}`);
    $("capture-interval").value = data.interval;
    $("capture-status").textContent = "已读取";
  } catch (error) { $("capture-status").textContent = `读取失败：${error.message}`; }
}

async function initCaptureSetting() {
  try {
    const data = await request("/v2/projects/");
    const projects = data.projects || [];
    $("capture-project").innerHTML = projects.map((project) => `<option value="${esc(project.name)}">${esc(project.display_name || project.name)}</option>`).join("");
    if (projects.some((project) => project.name === "main")) $("capture-project").value = "main";
    await loadCaptureSetting();
  } catch (error) { $("capture-status").textContent = `项目加载失败：${error.message}`; }
}

$("capture-project").addEventListener("change", () => void loadCaptureSetting());
$("capture-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const project = $("capture-project").value;
  const interval = Number($("capture-interval").value);
  if (!project || !Number.isInteger(interval) || interval < 1 || interval > 100) return;
  try {
    await request(`/api/capture-settings/${encodeURIComponent(project)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ interval }) });
    $("capture-status").textContent = "已保存；Agent 在下次同步后生效";
  } catch (error) { $("capture-status").textContent = `保存失败：${error.message}`; }
});
void initCaptureSetting();

async function request(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || body.detail || `HTTP ${response.status}`);
  return body;
}

function message(text, error = false) {
  $("save-status").textContent = text;
  $("save-status").style.color = error ? "#a65e53" : "";
}

function render() {
  $("agent-count").textContent = state.agents.filter((agent) => agent.state === "configured").length;
  $("registry-project").textContent = state.projects.length;
  $("agents-list").innerHTML = state.agents.map((agent) => {
    if (agent.state !== "configured") return `<article class="agent-card"><div class="agent-card-head"><strong>${esc(labels[agent.agent])}</strong><span>无法读取</span></div><p>${esc(agent.error)}</p></article>`;
    const options = state.projects.map((project) => `<option value="${esc(project.name)}" ${project.name === agent.project ? "selected" : ""}>${esc(project.name)}</option>`).join("");
    const missing = state.projects.some((project) => project.name === agent.project) ? "" : `<option value="" selected disabled>当前项目 ${esc(agent.project)} 不在后端项目列表中</option>`;
    return `<article class="agent-card" data-agent="${esc(agent.agent)}"><div class="agent-card-head"><strong>${esc(labels[agent.agent])}</strong><span>配置文件已读取 · 运行时状态未确认</span></div><div class="agent-fields"><label class="agent-field"><span>实际配置的记忆项目</span><input value="${esc(agent.project)}" readonly /></label><label class="agent-field"><span>选择目标项目</span><select data-project>${missing}${options}</select></label><div class="agent-field agent-field-wide"><span>配置范围</span><strong>${esc(agent.scope)}</strong><span>${esc(agent.source)}</span></div></div><div class="agent-card-actions"><button class="primary-button compact" data-apply="${esc(agent.agent)}" ${state.busy ? "disabled" : ""}>应用到 ${esc(labels[agent.agent])}</button></div></article>`;
  }).join("") + `<article class="agent-card"><div class="agent-card-head"><strong>WorkBuddy</strong><span>尚无可控制的本机接入</span></div><p>该客户端尚未安装到本机，暂未由此服务读取和管理配置。</p></article>`;
}

async function refresh() {
  if (state.busy) return;
  state.busy = true;
  $("refresh-agents").disabled = true;
  message("正在读取本机配置…");
  try {
    const projectData = await request("/v2/projects/");
    state.projects = projectData.projects || [];
    const cwd = $("workspace").value.trim();
    const data = await request(`${control}/status${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`);
    state.agents = data.agents;
    state.cwd = data.cwd;
    $("workspace").value = data.cwd;
    message(`已读取本机配置 · ${new Date().toLocaleString()}`);
    render();
  } catch (error) {
    state.agents = [];
    $("agent-count").textContent = "—";
    $("registry-project").textContent = "—";
    $("agents-list").innerHTML = `<div class="agents-notice">无法读取路由：${esc(error.message)}。请检查记忆后端和当前设备的本机配置服务。</div>`;
    message("路由信息不可用", true);
  } finally {
    state.busy = false;
    $("refresh-agents").disabled = false;
    document.querySelectorAll("[data-apply]").forEach((button) => { button.disabled = false; });
  }
}

async function apply(agentName, card) {
  if (state.busy) return;
  const agent = state.agents.find((item) => item.agent === agentName);
  const project = card.querySelector("[data-project]").value;
  if (!agent || !project) return;
  if ($("workspace").value.trim() !== state.cwd) { message("工作目录已变更，请先重新读取本机配置。", true); return; }
  if (project === agent.project) { message(`${labels[agentName]} 已配置为 ${project}；运行中的客户端状态尚未确认。`); return; }
  state.busy = true;
  $("refresh-agents").disabled = true;
  document.querySelectorAll("[data-apply]").forEach((button) => { button.disabled = true; });
  try {
    const result = await request(`${control}/route`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: agentName, project, revision: agent.revision, cwd: state.cwd }) });
    state.agents = result.status.agents;
    message(`${labels[agentName]} 配置已更新为 ${project}。请重新加载或重启客户端后确认生效。`);
    render();
  } catch (error) { message(`未能应用：${error.message}`, true); }
  finally {
    state.busy = false;
    $("refresh-agents").disabled = false;
    document.querySelectorAll("[data-apply]").forEach((button) => { button.disabled = false; });
  }
}

$("refresh-agents").addEventListener("click", refresh);
$("agents-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-apply]");
  if (button) void apply(button.dataset.apply, button.closest(".agent-card"));
});
void refresh();
