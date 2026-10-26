---
name: bm-remember
description: 在 Codex 中快速将简短事实、提醒或用户偏好保存到 Basic Memory，不扩写成完整决策或工作检查点。
---

# 快速记下

用于轻量记录，例如“记住这点”“保存这个”“记一下”，或希望在当前对话结束后仍保留的简短事实。

## 步骤

1. 先读取 `~/.codex/basic-memory.json`，再读取最近的项目级 `.codex/basic-memory.json`；项目级键覆盖用户级键：
   - `primaryProject`，可省略以使用默认项目。
   - `rememberFolder`，默认 `codex/remember`。

   起草前应用 `bm-writing` 技能，默认使用简体中文；专名、代码和引用原文除外。记录保持简短，不要把小事实扩写成长文。

2. 确认要保存的确切含义。默认用简体中文准确概括；只有用户明确要求保留原文时，才逐字保存外语原文或引用。若用户说“记住这点”但指代不明，只问一个简短问题。

3. 使用 `bm_write` 写入：
   - `title`：首行截取至 80 个字符，或使用简短描述性标题。
   - `directory`：`rememberFolder`。
   - `content`：要记住的内容。
   - `tags`：`["codex", "manual-capture"]`。
   - 若已配置 `primaryProject`，写入该项目。

4. 用一行文字和 permalink 确认结果。

不要用它记录包含备选方案的决策或工作交接；这两类分别使用 `bm-decide` 和 `bm-checkpoint`。
