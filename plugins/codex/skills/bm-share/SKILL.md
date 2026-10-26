---
name: bm-share
description: 在获得明确确认后，将个人 Basic Memory 笔记连同来源信息分享至已配置的团队项目。
---

# 分享笔记

将笔记从已配置的主项目复制到团队项目。这是有意执行的共享写入流程；自动检查点和快速记忆仍保留在个人项目。

## 步骤

1. 先读取 `~/.codex/basic-memory.json`，再读取最近的项目级 `.codex/basic-memory.json`；项目级键覆盖用户级键。确认 `primaryProject` 和 `teamProjects`（项目引用到配置的映射）。

2. 如果没有配置团队项目，停止并请用户运行设置流程或添加目标；不要自行编造分享目标。

3. 根据用户参数或当前对话读取来源笔记。如果不明确，询问要分享哪篇笔记。

4. 选择目标。如果有多个团队项目，询问用户要用哪一个。

5. 写入前征得确认，问题应明确指出笔记和目标：`将“<标题>”分享至 <目标>/<promoteFolder> 吗？`

6. 写入副本：
   - 指定目标项目。
   - `directory` 使用目标项目的 `promoteFolder`，默认 `shared`。
   - 保留原内容及有用的 frontmatter。
   - 条件允许时添加 `shared_from: <来源 permalink>` frontmatter。
   - 添加观察项 `- [context] 分享自 <来源 permalink>`。

7. 用新团队笔记的 permalink 确认结果。

没有用户明确同意时，绝不分享秘密、凭据或私人笔记。
