# 从 GitHub fork 部署 Basic Memory Codex 插件

本文说明仓库中的 Codex 插件、技能和 Hook 运行时如何协同工作，以及如何让 fork 部署使用同一份 Hook 代码。

## 组件与版本边界

- `plugins/codex/skills/`、插件清单和 `hooks/hooks.json` 随 marketplace 安装，内容来自所选 Git 仓库的默认分支。
- `hooks/session_start.py` 和 `hooks/pre_compact.py` 是轻量启动器。它们通过 PEP 723 声明，使用 `uv` 安装并运行对应 Git 引用的 Basic Memory Python 包。
- Hook 的上下文生成、压缩检查点提示和生命周期事件处理实现在 `src/basic_memory/cli/commands/hook.py`。因此，插件来自 fork 并不自动意味着运行时也来自 fork；必须检查两个启动器中的依赖引用。
- 两个启动器都需要锁定到同一个 Basic Memory 提交。使用完整提交 SHA 可以固定运行时内容，避免分支后续变化改变部署行为。
- 项目映射、服务地址、凭据、Codex Hook 信任与审批属于部署者自己的机器或账户配置，不应写入仓库。

## 发布 fork 中的 Hook 改动

Hook 核心代码必须先推送，之后才能把启动器锁到该提交。以下命令假定 fork 为 `https://github.com/<owner>/basic-memory`：

1. 将 Hook 核心实现、中文技能和插件元数据提交并推送到 fork。
2. 在该提交所在的 checkout 中，把两个启动器都锁到已推送的完整 SHA：

   ```bash
   just set-codex-hook-version "$(git rev-parse HEAD)" \
     "https://github.com/<owner>/basic-memory"
   ```

   `repository` 参数可省略；省略时使用官方仓库 `https://github.com/basicmachines-co/basic-memory`，适用于上游发布。fork 部署必须显式提供 fork 地址。

3. 检查并提交启动器中的依赖引用，然后推送：

   ```bash
   git diff -- plugins/codex/hooks/session_start.py plugins/codex/hooks/pre_compact.py
   git add plugins/codex/hooks/session_start.py plugins/codex/hooks/pre_compact.py
   git commit -s -m "chore(plugins): pin Codex hooks to fork runtime"
   git push
   ```

运行时 SHA 指向第一步中已推送的代码提交；第二步产生的提交则让后续安装者使用这个固定运行时。

## 安装 fork

确保 Basic Memory 和 Codex CLI 已安装，并且 `uv` 可从 Codex Desktop Hook 进程的 `PATH` 中找到。然后将 `<owner>` 替换成 fork 所有者：

```bash
bm install codex --source <owner>/basic-memory
```

也可以直接使用本地 checkout：

```bash
bm install codex --source /path/to/basic-memory
```

Codex marketplace 和插件通常按用户级安装。安装后启动新的 Codex 对话，在 Codex 的 `/hooks` 页面检查并信任 Basic Memory Hook。运行 `bm-setup` 配置记忆项目；服务地址、访问凭据等由每位部署者自行设置，不随 GitHub 仓库分发。

## 如何判断安装是否一致

检查 fork 默认分支上的以下内容：

1. `plugins/codex/skills/` 和插件清单包含期望版本的技能与中文界面文案。
2. 两个 Hook 启动器引用相同的 fork 仓库和完整提交 SHA。
3. 该 SHA 在 fork 上可访问，并包含对应的 `src/basic_memory/cli/commands/hook.py` 实现。
4. 部署者已在自己的机器上配置 Basic Memory 项目，并在 Codex 中启用且信任 Hook。

前三项确保代码版本可复现；第四项是个人部署配置，仓库无法替代它。Hook 会保留用户输入原文，中文提示和 `bm-writing` 技能指导新生成的结构与说明使用简体中文；代码、路径、专有名词及明确要求的原文引用仍可保留原语言。
