---
name: bm-checkpoint
description: 在 Basic Memory 中创建不可变的 Codex 工作交接记录，并返回准确的 bm-orient 恢复命令。
---

# 保存 Codex 工作检查点

当用户要求保存检查点、总结交接、记住工作状态，或压缩后的 SessionStart 上下文要求创建交接记录时使用。

若未固定项目，先调用 `bm_project(command="list")` 发现项目，并在笔记和搜索调用中传入所选项目的 external ID。存在多个可访问项目时，即使配置了默认项目，也必须明确指定范围。

## 收集信息

读取 `~/.codex/basic-memory.json`，再读取最近的项目级 `.codex/basic-memory.json`；项目级键优先：

- `primaryProject`：可省略。
- `captureFolder`：默认 `codex/<Git 仓库顶层目录名>`。
- `placementConventions`：可选。
- `sessionProfile`：默认 `general`。
- `repository`：当 `sessionProfile` 为 `coding` 时必填。

起草前应用 `bm-writing` 技能，默认以简体中文撰写笔记；代码、路径、专有名词和用户原文引用按需保留。

收集可直接验证的仓库证据和工作上下文：

- 开始本线程的原始目标及其意义；最近的用户意图，包括取代原目标的更正或范围变化。
- 采用的方法及其解决问题的原因；当前系统状态和实际影响。
- 权衡、边界情况、有用的简化、明确暂缓的工作。
- `git status --short`、当前分支、仓库根目录、工作目录、当前 Git SHA。
- 若当前分支有 PR：编号、标题、URL、状态、base 和 head。
- 本线程修改的文件；实际运行的测试/检查及结果；失败或跳过的检查。
- 本线程作出的决策、未解决的阻塞项、下一步行动。
- 当前用户名、主机名、时间戳。
- 检查点请求提供的 `session_id`、`agent`、`codex_turn_id`、`trigger`、`model`（若有）。

仓库和 PR 状态只用只读证据确认。没有实际运行测试或用户提供结果时，不得声称测试通过。宿主提供的会话元数据是不透明的身份数据：逐字保留非空值，不得推测或改写。旧请求若只提供 `codex_session_id`，将该精确值作为 `session_id`，并设置 `agent: codex`；新检查点不要输出旧字段。

## 写入不可变检查点

检查点是供以后恢复工作的交接记录，不是状态流水账，也不是逐次提交清单。面向未来的人或智能体讲清工作经过。将它作为快照和权威资料索引，不取代任务、决策、计划、议题、PR、提交、差异、已提交文档或源文件。

每次调用都创建新检查点。即使主题相同，也不得编辑、替换或追加到旧检查点。

标题格式：`Codex 检查点 - <UTC YYYY-MM-DDTHH-MM-SSZ> - <简短主题>`。UTC 时间戳是不可变身份的一部分，且避免文件名不安全的冒号。若 `bm_write` 返回标题冲突，以最小可用数字后缀重试（例如 ` - 2`），不得通过修改旧笔记解决冲突。

每次调用 `bm_write` 时传入 `project=<已配置 primaryProject>`、`overwrite=False`、`output_format="json"`。若未配置 `primaryProject`，发现项目并显式传入选定项目的 external ID。frontmatter 的 `project` 字段只是描述性元数据，不能替代工具的 `project` 参数。即使用户的 `write_note_overwrite_default` 为 true，也必须显式禁止覆盖。只接受 `action: created` 的成功结果；`ALREADY_EXISTS` 按标题冲突处理，其他错误或操作结果都应停止。

## 保留与整理

每次压缩的 checkpoint 都是不可变的恢复快照，数量会随压缩次数增长。不要设置固定数量上限，也不要自动移动、改写或删除旧 checkpoint。任务结束或用户要求整理时，先把仍有效的项目事实和决定更新到权威主题文档，再判断旧 checkpoint 是否仍有恢复价值。归档必须人工评估，并先验证原 permalink、关系、搜索和 Web UI 行为及备份可恢复性；Basic Memory 的移动结果受 `update_permalinks_on_move` 配置影响。当前设置或解析行为未经验证时，不得批量移动真实笔记。完整流程见 `docs/CODEX_CHECKPOINT_RETENTION.md`。

### 通用配置

- `title`：上述带时间戳的标题。
- `directory`：配置的 `captureFolder`。
- `tags`：`["codex", "checkpoint"]`。
- frontmatter：`type: codex_session`、`status: open`、已知时的 `project`，以及 `cwd`、`started`、`username`、`hostname`、`capture: deliberate`、`agent: codex`。请求提供时加入精确的 `session_id`、`codex_turn_id`、`trigger` 和 `model`。

### Coding 配置

`sessionProfile` 为 `coding` 时使用 `type: coding_session`，并加入相同通用 frontmatter 和以下 schema 必填字段：

- `repository: <已确认的稳定仓库标识>`
- `repo_root: <git rev-parse --show-toplevel>`
- `cwd: <当前工作目录>`
- `branch: <git rev-parse --abbrev-ref HEAD>`
- `git_sha: <git rev-parse HEAD>`

若当前分支有 PR，再加入 `pull_request_number`、`pull_request_title`、`pull_request_url`、`pull_request_state`、`pull_request_base`、`pull_request_head`。用只读 GitHub 查询解析；没有 PR 时省略这些字段。编号必须写成字符串，例如 `pull_request_number: "123"`，以保证不同存储后端的元数据查询一致。不得仅根据对话推断或复制仓库/PR 身份。无法证实必填 coding 字段时停止。

## 链接同一对话的检查点

若有 `session_id`，使用 `agent: codex` 作为同一聊天的身份组合：

1. 写入前，在配置的 `primaryProject` 搜索 `codex_session` 和 `coding_session`，过滤条件为 `filters={"agent": "codex", "session_id": "<宿主提供的精确 id>"}`；再搜索旧字段 `filters={"codex_session_id": "<宿主提供的精确 id>"}`。
2. 翻完所有页并去重，按有效的 `started` 时间选出最新的更早检查点。直接从 `primaryProject` 读取该笔记，核实精确的 `agent`/`session_id` 组合；若无共享身份字段，则核实精确的旧 `codex_session_id`。字段冲突时拒绝匹配。单独的 session ID 不能证明跨 agent 的身份。
3. 在 `## Relations` 下加入 `- continues [[上一个检查点的准确标题]]`。

不要改动旧的不可变检查点添加反向关系；Basic Memory 反向链接可双向导航。找不到已验证的前序笔记时省略关系。不得仅凭仓库、分支、主题、时间戳或生命周期信封推测同一对话。

## 正文结构

正文以 `# <准确笔记标题>` 开始，按需使用以下章节；没有价值的可选章节省略：

- `## Summary`：一句具体概述，不要只重复标题。
- `## Story`：原始目标 → 最近用户意图 → 方法 → 当前状态和影响，用有实质内容的叙述写清。
- `## Working State`：区分长期有效状态与本机/易失状态。
- `## Changed Files`：恢复工作时有用的路径。
- `## Verification`：实际运行的检查及结果。
- `## References`：已核实的仓库、提交、PR、议题、规范或文档链接。
- `## Observations`、`## Relations`：存在相应内容时使用。

正文优先使用仓库相对路径；frontmatter 必需的绝对 `repo_root` 和 `cwd` 仍保留本机证据。必要时将未提交/未跟踪文件、忽略文件、活动进程、开发服务器、临时目录和本地工具缓存标记为本机或易失状态，不要当作项目长期状态。

检查点应优先提供线索：点名权威资料并包含稳定标识或链接，只总结理解线索所需的上下文，不复制大型计划、差异、日志或源文件。

涉及 GitHub 仓库时，用只读 GitHub 查询解析规范仓库 URL。在 `## References` 及相关叙述中，将当前仓库、当前已推送提交和相关 PR、议题或提交写成 Markdown 链接。PR/议题使用 GitHub 返回的规范 URL。提交只有在 GitHub 能在已确认的仓库中解析该 SHA 后才能链接。本地或未推送的 SHA 应标记为本地/未推送代码，不得拼接可能不存在的 GitHub 链接。没有证实仓库归属时，不得把模糊的议题编号或 SHA 变成链接。

用观察项提炼供结构化检索的长期事实，而不是重复每句叙述：

- `[result]`：具体结果。
- `[decision]`：本线程作出或确认的每项决策。
- `[blocker]`：每个尚未解决的阻塞项。
- `[next_step]`：唯一的主要后续行动，且必须恰好一项。
- 只有当 `[verification]` 或 `[changed_file]` 本身构成重要项目记忆、而非佐证细节时才使用。

不要另外创建普通项目符号的“决策”“阻塞项”或“下一步”章节。没有内容的类别直接省略，不写“无”等占位文字。

关系不是观察项。将关系放到 `## Relations`，例如 `- relates_to [[准确的现有笔记标题]]`。不要写 `[relates_to]` 或把裸 `memory://` URL 当观察项。仅当目标是现有检查点、任务、决策、规范、议题或 PR 笔记时才建立关系。同一聊天已验证的 `continues` 边就是检查点链路；不要再对同一目标添加泛化关系。

## 确认结果

回复应包含：

1. 一句话说明该检查点保存了什么。
2. 从成功 JSON 结果中选出的准确恢复标识。
3. 唯一的主要下一步行动。
4. 最后一个区块必须恰好是一条 fenced 恢复命令：

```text
$bm-orient "<成功结果返回的准确标识>"
```

按 `permalink`、`file_path`、`title` 的顺序选取首个非空值，并逐字使用返回内容；绝不自行构造或猜测 permalink 或文件路径。
