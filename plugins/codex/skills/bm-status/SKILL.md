---
name: bm-status
description: 检查 Basic Memory for Codex 的配置、连接、Hook 状态、近期检查点和活跃任务。
---

# Basic Memory for Codex 状态

收集简洁诊断信息，不要过度排查。

## 检查项目

1. **CLI 是否可用**
   - 依次尝试 `basic-memory --version`、`bm --version`、`uvx --prerelease=allow basic-memory --version`。
   - 所有启动方式都不可用时仍继续检查。插件 hook 脚本可能使用 uv 管理的环境；应将 hook 健康状态标为“无法确认”，不要因此断言 hooks 无法运行。

2. **插件配置**
   - 读取 `~/.codex/basic-memory.json`，再读取最近的项目级 `.codex/basic-memory.json`；项目键覆盖用户级键。
   - 报告解析后的 `primaryProject`、`remoteMcpUrl`、`secondaryProjects`、`teamProjects`、`captureFolder`、`rememberFolder`、`recallTimeframe`、`focus`、`sessionProfile`、`repository`、`checkpointOnCompact` 和 `captureEvents`。
   - 对省略的 Codex 默认值按 `rememberFolder=codex/remember`、`checkpointOnCompact=true` 处理。

3. **核心 Hook 健康状态**
   - 使用第一个可用的启动程序运行 `basic-memory hook status --harness codex --project-dir <仓库根目录>`。
   - 报告命令提供的共享收件箱路径、待处理信封、已归档信封、最近 flush、设置状态、解析后的主项目和 SessionStart 读取源、捕获状态、捕获目录、检查点提示状态、Basic Memory 版本和 uv 版本。`remote MCP` 表示配置路由；只有读取到远端上下文后，才可说启动读取已实测成功。
   - 收件箱计数在受支持的 harness 之间共享，不要把所有积压都归因于 Codex。
   - Hook 行为以命令解析出的设置为准；若与手动读取的配置不同，说明差异。

4. **Hook 文件和启动器可见性**
   - 无论 CLI 是否可用，都单独检查当前环境的 `uv --version`；uv 是 hook 的必要前提。
   - 区分“当前 shell 找不到 uv”和“已验证桌面 Hook 运行时”；shell 可运行并不代表桌面 Hook 进程的 PATH 正确。
   - 若桌面/WSL hooks 失败但 TUI 可用，检查实际启动错误和 PATH。出现 `uv: command not found` 时，Python 脚本尚未启动，因而无法输出诊断。
   - 如需 WSL 排障，参照本技能目录上两级的 `README.md` 中“Troubleshooting Desktop hooks on WSL”章节，查看默认路径检查和有条件的符号链接解决方法。
   - 只有观察到启动上下文和压缩后的检查点笔记，才可声称桌面 Hook 执行已验证；否则标为未验证。
   - 若当前在此仓库工作，确认 `plugins/codex/hooks/hooks.json` 文件存在。
   - 提醒用户：Codex 运行插件 hooks 前，需要先在 Codex 中审核并信任它们。

5. **Basic Memory 查询**
   - 查询近期 `type=codex_session`；当 `sessionProfile=coding` 时，再使用 `repository=<已配置仓库>` 查询 `type=coding_session`。合并去重、按时间从新到旧排序，只保留最新五条。仓库未配置时绝不执行无范围的 coding-session 查询。它们是由智能体撰写的检查点；生命周期信封仍是本地运维轨迹。
   - 查询 `type=task`、`status=active` 的活跃任务。
   - 查询 `type=decision`、`status=open` 的未关闭决策。

## 每轮语义捕捉状态

读取插件根目录 `hooks/memory_review.py`，使用 `uv run --quiet --no-project --script <脚本绝对路径> status` 检查本机状态库。报告 `semanticCapture`（默认 true）以及 collecting、requested（旧版遗留）、saved、no_memory、pending、unresolved、expired 的数量；此计数覆盖本机项目，不要全算到当前项目。pending 表示等待后续 Codex 回合查重重试，Stop 仅登记遗漏并正常结束，不触发可见续轮；unresolved 表示等待后续同范围回合复核的未完成检查，expired 表示七天后清除了未完成草稿，均不是保存成功。saved 是智能体提交的回执，不等同于再次读取服务端验证。诊断时不要输出草稿正文或凭据。确认插件注册了同步 UserPromptSubmit/Stop，并排查旧的关键词捕捉 handler 是否仍在并行写入。

## 汇报格式

用以下字段简洁汇报：

```text
Basic Memory for Codex 状态
- CLI：<版本或不可用>
- 项目：<primaryProject 或默认项目>
- 启动上下文读取源：<remote MCP URL 或本地 Basic Memory 项目>
- 读取项目：<secondaryProjects 或无>
- 分享目标：<teamProjects 或无>
- 捕获目录：<captureFolder>
- 快速记忆目录：<rememberFolder>
- 回忆时间范围：<recallTimeframe>
- 会话类型：<general 或 coding>
- 仓库：<owner/name 或无>
- 压缩后创建检查点：<启用或禁用>
- 事件捕获：<启用或禁用>
- 共享 Hook 收件箱：<路径或不可用>
- 共享待处理信封：<数量或不可用>
- 共享已归档信封：<数量或不可用>
- 最近 flush：<时间、从未或不可用>
- 当前环境的 Hook 运行时：basic-memory <版本>；uv <版本或不可用>
- 桌面 Hook 执行：<已由上下文和检查点验证或未验证>
- 近期检查点：<coding_session 与 codex_session 总数>
- 活跃任务：<数量>
- 未关闭决策：<数量>
- Hooks：已安装；需要在 Codex 中审核并信任
```

若有近期检查点，列出类型、标题及可用的 permalink。事件捕获已启用且待处理信封持续增加或最近 flush 为 `never` 时提醒用户，同时说明计数也可能来自其他 harness。捕获已禁用且收件箱为空时，不要发出提醒。
