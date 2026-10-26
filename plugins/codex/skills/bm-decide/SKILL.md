---
name: bm-decide
description: 在 Basic Memory 中记录长期有效的工程决策、理由、备选方案、影响和关联工作。
---

# 记录一项决策

当用户作出或要求记录一项长期有效的选择时使用。决策应包含理由和后果，而不只是一般偏好。

## 步骤

1. 先读取 `~/.codex/basic-memory.json`，再读取最近的项目级 `.codex/basic-memory.json`；项目级键覆盖用户级键：
   - 若设置了 `primaryProject`，写入该项目。
   - 若 `placementConventions` 明确规定目录，按其规定放置。
   - 否则使用 `codex/decisions`。

   起草前应用 `bm-writing` 技能，默认使用简体中文；专名、代码和引用原文除外。

2. 只有决策本身有歧义时才追问。对话已包含理由时，不要逐项询问字段。

3. 写入 `type: decision` 笔记：
   - 除非用户说明已接受、被取代或被否决，否则设为 `status: open`。
   - 已知决策时间时填写 `decided: <ISO 时间戳>`。
   - 已知项目时填写 `project: <primaryProject>`。

4. 记录决策内容、背景、理由、考虑过的备选方案、后果，以及受影响的文件、规范、议题、PR 或笔记。

5. 用 permalink 确认写入结果。如果此决策取代旧决策，更新旧笔记，或添加 `supersedes` 关系。
