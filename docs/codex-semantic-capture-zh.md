# Codex 每轮语义记忆捕捉

## 适用范围与跨 agent 边界

本方案及目前完成的 Hook 体验优化**只针对 Codex agent**。实现依赖 Codex 的 `UserPromptSubmit` / `Stop` 生命周期、`session_id + turn_id`、Hook 上下文注入、Codex skills、Basic Memory MCP 和本机回执状态库。Stop 只登记遗漏并正常结束；不再返回 `decision: block` 或生成可见续轮提示。这不是可直接移植到其他 agent 的通用 Hook 约定。

当前 Codex 侧已实现的优化包括：整轮语义判断而非关键词或长度阈值筛选；以会话和回合标识关联审查；正常回合最终回复前检查并提交回执，Stop 静默登记遗漏供后续回合复核；显式区分 saved / no_memory / pending / unresolved / expired；失败草稿按目录和项目隔离并退避重试；限制本机状态库权限和草稿保留时间；以及兼容升级前遗留的续轮记录。实现状态以本文件、`plugins/codex/hooks/` 和 `plugins/codex/skills/bm-capture/` 为准。

这些是 Codex 当前实现事实，不表示其他 agent 已具备相同能力。其他 agent 的使用者可以参考 Codex 的部署方式和分层思路，例如区分用户级接入、MCP 桥接、认证凭据存放与生命周期 Hook；这些部署经验可作为新适配的起点，但不构成跨 agent 兼容性证明。未来适配时，每个 agent 都需要单独确认其事件生命周期、完整回合上下文可用性、续轮或后台调用方式、注入内容是否显示给用户、事件唯一标识、skills/tools/MCP 授权、项目路由、失败处理与本地安全存储。新增适配前先做只读接入检查，再用明确授权的临时事实验证写入、检索和清理；不得原样复制 Codex Hook JSON、桥接命令或事件语义并将其称为通用实现。

## 解决的问题

原先独立的关键词 Stop 捕捉会漏掉没有“记住/以后/决定”等标记的长期信息，也会因助手最终回复超过 1200 字符而整轮跳过。长用户提示会先被截断，“就按这个方案”则可能以缺少指代对象的原话入库。

现在由当前 Codex 根据上下文判断长期事实、偏好、约束和已确认决策，使用 `bm-remember` / `bm-decide` 搜索、读取和写入。Hook 只管理处理回执，不把用户原话直接当成知识笔记，也不调用额外模型。当前 Codex 仍可能判断错误；状态机不能保证语义提取零遗漏。

## 事件与回执

插件在原有 SessionStart / PreCompact 之外注册两个同步 Hook，共用依赖仅为 Python 标准库的 `plugins/codex/hooks/memory_review.py`：

- UserPromptSubmit 为 `session_id + turn_id` 创建稳定检查 ID，注入 `bm-capture` 技能和回执命令；不截断或缓存用户提示/助手回复。
- 当前 Codex 应在正常回合的最终回复前完成检查和回执。Stop 缺少回执时只将 collecting（或旧版 requested）原子转为 unresolved，保留恢复路径并返回空结果；重复 Stop 不覆盖已有 saved / no_memory / pending / expired 回执，也不请求可见续轮。
- 升级前已排队的 Hook 续轮沿用原记录，不创建新的用户记忆任务；保留 `stop_hook_active` 兼容保护。真实用户消息到来时，前一轮未完成的检查转为 unresolved，进入后续复核。
- 输入缺失、配置或状态库异常时显示简短错误并放行正常工作，不打印提示正文或凭据。

状态含义：

| 状态 | 含义 |
| --- | --- |
| collecting | 当前回合等待检查 |
| requested | 旧版已请求补记的遗留状态；新版不再创建 |
| saved | 智能体报告所有候选均已保存，或核实已存在；回执必须有笔记标识 |
| no_memory | 已检查，没有值得保存的信息；必须提供理由 |
| pending | 仍有失败或结果未知的候选；必须保存结构化草稿 |
| unresolved | Stop 发现缺少回执，或被新请求打断；等待后续同范围回合复核，不是已处理 |
| expired | 未完成内容超过七天，已清除草稿；不是保存成功 |

回执是智能体对实际 MCP 结果的报告，Hook 不独立核实服务端。不能用“调用过工具”或“已触发 Hook”代替保存成功。部分成功时，把已成功的标识和未完成的 drafts 一起放进 pending；不要把整轮误标为 saved。

## 重试与隔离

pending 保存提炼后的 `kind/project/title/content`，不保存整段对话。凭证是否写入遵循用户对目标记忆库的策略；本用户已明确将个人自托管 Basic Memory 用于记住需要长期复用的凭证，因此符合该范围的凭证也可能进入记忆或 pending 草稿。Hook 不负责加密或过滤凭证；不要把凭证自动分享至团队项目。后续同工作目录、同配置 `primaryProject` 的用户回合最多提示三条待复核记录。失败后至少等待五分钟，重复失败逐步退避，最长间隔一小时。由当前 Codex 再次查重、核对新事实后执行重试，避免上次响应丢失造成重复，或旧草稿覆盖更新的偏好。

这是后续回合驱动的重试队列，不是独立后台投递服务。没有后续回合时，遗漏不会立即补齐；语义误判与服务故障也不能靠 Stop 消除。Codex 关闭时不会重试；项目/目录改变时不会自动向新目标投递旧草稿。项目未固定时需通过 MCP 明确发现写入目标。不能仅凭相似度覆盖现有笔记，不能因捕捉需要而扩大项目写入权限。

本机状态库位于 `${CODEX_HOME:-~/.codex}/basic-memory/memory-review.sqlite3`。目录权限为 0700、数据库为 0600；未完成记录七天后在下一次访问状态库时清除草稿正文，终态记录三十天后清理。未完成检查可保留宿主会话文件路径供恢复，Hook 不自动读取文件。过期计数通过 status 可见；它不表示历史遗漏已经补齐。

## 配置与诊断

读取用户级 `basic-memory.json`，再按键合并距离 cwd 最近的项目级 `.codex/basic-memory.json`。`basicMemory.semanticCapture` 默认为 true，设为 JSON 布尔值 false 可关闭；格式错误时显示诊断并跳过本次捕捉。该开关独立于 `captureEvents` 和 `checkpointOnCompact`。

`bm-setup` 会说明此设置，`bm-status` 会报告处理队列。也可直接运行：

```bash
uv run --quiet --no-project --script plugins/codex/hooks/memory_review.py status
uv run --quiet --no-project --script plugins/codex/hooks/memory_review.py show <review-id>
```

`show` 会读取指定检查的历史草稿，排障时不要把其中私有内容贴进公开日志。

## 延后的记忆整理

Codex 插件可选启用 `basicMemory.memoryMaintenance: true`。UserPromptSubmit 会提示 agent
先处理当前请求，再检查 MCP 工具 `bm_memory_maintenance`。后端依据已接受笔记变更日志的项目
水位，在 14 天或 20 个不同笔记变更达到任一阈值时报告 `due=true`；每批最多返回 20 个笔记。
当前 agent 在本轮最终回复前自行审阅和写回，不向对话发送整理计划或请求常规确认。整理批次有上限，
因此会增加触发该批次的回合耗时；没有活跃 Codex 回合时不会在后台运行。除内容、来源、范围、关系和标签外，还逐篇核对标题是否具体、准确、可检索，
是否只是 UUID、时间戳、路径或泛化收件箱名称；不合格时依据正文修正 frontmatter 标题和首个 H1，
保留文件路径、permalink 与关系，已有合格标题则不改。完成后以状态响应中的 `after_position` 作为 `expected_after_position`，连同 `through_position` 和覆盖整批、不重复的 `reviewed_note_ids` 提交一次完成请求；若某篇无法安全整理，则本轮不提交，检查点保持不变并留待后续重试。该流程不在 Stop 中阻塞当前回答，
也不启动独立后台模型；由当前 agent 在正常回合内完成。默认关闭。删除、自动覆盖
和多 agent 并发领取不在当前实现范围内。

## SessionEnd 待整理收集

项目可在最近的 `.codex/basic-memory.json` 中设置 `basicMemory.sessionEndInbox: true`。
Codex 的同步 SessionEnd Hook 会从 `transcript_path` 找到最后一条用户请求，以及该请求之后
已完成的 `assistant` `final_answer`，并将两者作为普通笔记写入配置的 `primaryProject` 下
`codex/inbox`。笔记标记 `status: pending_review`，带会话 ID、工作目录和 transcript 文件名；标题从
用户请求提取，若请求只是泛化跟进则改用最终回答开头，并保留完整会话 ID 作为唯一后缀。正文先写
“会话摘要”，包含请求和处理结果，再保留原始对话。Web UI 列表会为已有旧格式收件箱笔记读取摘要，
并显示从用户请求/最终回答提取的标题和概述。原文中的内容只作为待整理数据，
后续 agent 仍需审阅、查重、判断来源和适用范围；Hook 不将对话直接视为已确认记忆。

此功能默认关闭，应只在需要该行为的项目级配置中启用。它会保存完整的最后回答，因此该请求或
回答内的敏感内容也会写入记忆后端。未完成最终回答、缺少用户文本或 transcript 超过大小上限时
跳过。SessionEnd 触发可能因空闲而延后，也不因切换到另一对话立即触发。远端不可达或写入失败时
Hook 输出不含正文的错误类型并放行会话关闭；当前实现不保证网络失败后的自动重试。后端接受的
inbox 笔记进入 accepted-note change journal 后，才能被 memory maintenance 批次发现。生产软路由
尚未部署本地 memory maintenance API 时，SessionEnd 收集仍可保存笔记，但自动维护批次尚不可用。

## 安装与升级

安装当前 fork 的插件后，在新 Codex 对话中确认 `bm-capture` 已可用，并在 `/hooks` 审核和信任新增的同步 UserPromptSubmit / Stop。若已有用户级 `turn_capture.py prompt/stop` 旧 handler，应移除其注册，避免旧关键词捕捉和新语义捕捉重复写入。其他服务的 Hook 不属于本功能配置。

旧 `turn-capture.sqlite3` 与新状态库独立；升级不会清空旧队列。先检查旧 pending 数量并人工处理遗留候选，不能把旧 filtered 状态当作已提取出全部记忆。旧库已清空的提示只能从仍可访问的原始会话重新复核。

本次语义检查脚本随插件源码安装，无需修改核心运行时 SHA。SessionStart / PreCompact 的核心版本仍通过 `set-codex-hook-version` 独立固定，见 [fork 部署说明](codex-fork-deployment-zh.md)。
