---
name: bm-setup
description: 在用户级或项目级为 Codex 配置 Basic Memory 项目映射并初始化所需 schema。
---

# 配置 Codex 的 Basic Memory

为当前仓库配置 Basic Memory，让 Codex 能从中获取上下文并写入工作检查点。访谈应简短，但必须先询问数据写入位置，不得擅自选择。

## 前置条件

修改文件前确认 Basic Memory 可访问：

1. 优先使用 MCP：调用 `bm_project(command="list")`。
2. MCP 不可用时，运行 `basic-memory --version` 或 `bm --version`。
3. 两者都不可用时停止，告知用户安装 Basic Memory 并连接 MCP server。插件附带的 `.mcp.json` 会启动 `uvx --prerelease=allow basic-memory mcp`。
4. 访谈前列出可用项目；如有，注明云端/本地来源、workspace、限定名称和 project id。

## 访谈

请用户选择项目映射。不要根据仓库、默认项目、当前目录或之前的本机状态推断写入目标。

- **配置级别**：用户级 `~/.codex/basic-memory.json` 或项目级 `.codex/basic-memory.json`。明确询问，默认建议用户级。项目设置按键覆盖用户设置。
- **存储模式**：云端、本地或混合。以用户明确选择为准，不跟随 CLI 默认值。
- **focus**：代码/开发、研究、写作、规划或混合。
- **sessionProfile**：`coding` 或 `general`。代码/开发建议 `coding`。混合场景下，询问此仓库是否要捕获 Git 和 PR 上下文。不能只因当前目录是 Git 仓库就推断为 `coding`。
- **primaryProject**：现有 Basic Memory 项目，或需要新建的项目。
- **secondaryProjects**：可选，只读地提供 SessionStart 上下文。
- **teamProjects**：可选，供 `bm-share` 分享。
- **captureFolder**：默认 `codex/<repo-dir>`，由 Git 顶层目录名生成。只有用户希望覆盖默认值时才询问。
- **rememberFolder**：默认 `codex/remember`。
- **placementConventions**：简短说明决策、任务和研究笔记应放在哪里。决策默认放 `codex/decisions`，使 Codex 写入内容集中在同一目录树下。
- **checkpointOnCompact**：压缩后的 SessionStart 是否要求 Codex 运行 `bm-checkpoint`。默认 true；显式 JSON 布尔值 `false` 可关闭。
- **captureEvents**：是否将生命周期事件信封记录到本地 Hook 收件箱。默认 true；显式 JSON 布尔值 `false` 可关闭。
- **MCP 审批**：请用户从以下两种方式中明确选择一种：
  1. 保留 Codex 默认审批方式，不更改 Codex 配置。
  2. 预先批准 Basic Memory MCP server 的合格工具，只为 Basic Memory 设置 `default_tools_approval_mode = "approve"`。

不要提供按单个工具或只放行写入操作的信任方案。说明 server 信任设置会改变 Codex 的审批体验，但不会扩大 Basic Memory 对 workspace、项目或文件的访问权限。对于声明为破坏性操作的工具（包括 Basic Memory 的写入、编辑和删除），Codex 仍会要求审批。

`coding` profile 必须确认当前目录位于 Git 仓库中。通过当前 GitHub 仓库或 origin remote 解析稳定的 `repository` 标识（例如 `owner/name`），向用户展示并征求确认。remote 缺失或不明确时不要猜测。说明 coding 检查点会把结构化仓库、分支、SHA、工作目录及可选 PR 元数据保存到 Basic Memory。

询问前说明捕获的取舍：启用后会产生本地事件轨迹，直到 `bm hook flush` 才在本机归档；它不会创建知识图谱笔记，也不会写入团队项目。默认启用；显式 JSON 布尔值 `false` 可关闭，格式错误的值按关闭处理。

若有重名项目，列出限定名称并询问选择。云端项目优先使用限定名称或 project id。未经确认不得在云端和本地同名项目之间代选。

新建或空项目应建议轻量约定，而不是创建空目录。已存在的项目应先查看 `bm_list(path="/", project="<主项目>")` 和少量笔记，再总结实际约定。

## 应用设置

用户确认方案后，将共用设置写入所选的用户级或项目级文件：

```json
{
  "basicMemory": {
    "primaryProject": "<项目引用>",
    "secondaryProjects": [],
    "projectMode": "cloud",
    "teamProjects": {},
    "focus": "<focus>",
    "sessionProfile": "<general 或 coding>",
    "rememberFolder": "codex/remember",
    "recallTimeframe": "7d",
    "checkpointOnCompact": true,
    "captureEvents": true,
    "placementConventions": "决策放在 codex/decisions/，工作检查点放在 codex/<仓库目录名>/。"
  }
}
```

省略 `captureFolder` 可使用 `codex/<repo-dir>`；只有用户明确覆盖时才持久化该值。若文件已存在，保留无关键。文件只供 Codex 使用；不要写入 `.claude/settings.json`。用户选择云端、本地或混合路由时，填写 `projectMode`。始终将 `checkpointOnCompact` 和 `captureEvents` 保存为 JSON 布尔值。

用户级 coding 设置中，不要在共用用户文件写入 `sessionProfile`；将 coding profile 和确认过的仓库标识留在项目文件，避免影响其他仓库：

```json
{
  "basicMemory": {
    "sessionProfile": "coding",
    "repository": "owner/name"
  }
}
```

项目级 setup 则把 `repository` 加入该项目文件的共用设置。除上述用户级 coding 例外外，必须在所选文件显式保存 `sessionProfile`。只有 coding profile 才保存 `repository`，且须先获得用户确认。coding 缺少仓库标识时无法完成，因为 `coding_session` schema 要求可查询的 Git 身份字段。

### 应用 MCP 审批选择

审批配置属于 `~/.codex/config.toml`，不是 `.codex/basic-memory.json`。

- 用户保留 Codex 默认审批时，不要修改 `~/.codex/config.toml`。
- 用户选择预先批准 Basic Memory 合格工具时，先检查现有 Codex 配置并确认当前实际使用的 server 项。
- Marketplace 插件配置：

  ```toml
  [plugins."codex@basic-memory".mcp_servers.basic-memory]
  default_tools_approval_mode = "approve"
  ```

- 独立 MCP server 配置：

  ```toml
  [mcp_servers.basic-memory]
  default_tools_approval_mode = "approve"
  ```

若两种配置都存在且无法判断活动路由，询问用户应使用哪种；不要默默同时修改。编辑用户级 Codex 配置前，先展示确切改动并获得明确确认。保留其他 TOML 键，不得创建重复表。无法安全编辑时，提供适用的配置片段作为待办步骤。

此 server 级设置只减少合格工具的审批提示，不会降低 Codex 的全局审批策略，也不能跳过 MCP 对破坏性工具的强制审批；Basic Memory 写入、编辑和删除仍可能要求确认。不得设置 `approval_policy = "never"` 或修改 sandbox。配置变更后请用户新建 Codex 对话。组织管理策略可能要求额外审批。

## 初始化 schema

读取 `<plugin-root>/schemas/` 中的 schema 文件。本技能位于 `<plugin-root>/skills/bm-setup/SKILL.md`，因此 schemas 目录在向上两级的位置。

若所选 `primaryProject` 尚无相关 schema，为该会话类型初始化 schema：

- `sessionProfile: coding` 使用 `coding-session.md`。
- `sessionProfile: general` 使用 `codex-session.md`。

两种 profile 都初始化 `decision.md` 和 `task.md`。这些 schema 对应 Codex 直接写入的笔记。生命周期信封不是笔记；`bm hook flush` 会在本地归档该运维轨迹，因此不需要 session 或 tool-ledger 的项目 schema。

使用 `bm_write` 写入，传入 `directory="schemas"`、`note_type="schema"`、schema frontmatter 作为 metadata、Markdown 正文作为 content。不要把 YAML frontmatter 粘贴到正文。

开始初始化前，重述准确目标项目。若目标不同于用户所选的主项目，或路由不明确，应先确认。

## 验证

结束前核实项目映射：

- 在主项目中以 page size 10 搜索 `type=schema`。coding profile 应确认有 `Coding Session` schema。
- 配置了共享项目时，搜索其中一个项目的未关闭决策。
- 运行 `basic-memory hook status --harness codex --project-dir <仓库根目录>`；必要时使用 `bm` 或 `uvx --prerelease=allow basic-memory`。确认找到本仓库设置，并报告所选项目、会话类型、仓库、检查点提示和捕获状态。收件箱计数由多个 harness 共享。
- 若检查报错，修正项目引用或 Hook 启动器后再结束。

最后汇报项目映射、初始化或跳过的 schema、检查点提示、捕获设置、MCP 审批方式、共享收件箱状态和验证结果，并提醒用户在 Codex 中审核并信任插件 hooks 后它们才会运行。
