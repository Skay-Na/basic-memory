# Basic Memory for Antigravity

本目录是 Basic Memory 针对 Google Antigravity Agent 的专属适配套件。

---

## 架构与工作原理

Antigravity 通过 Antigravity Customization System（Plugin + Hooks + MCP）与 Basic Memory 后端交互：

1. **MCP 工具集成 (`mcp_config.json` & Loopback 代理)**：
   - 全局配置 `~/.gemini/config/mcp_config.json` 注册 `basic-memory` stdio 桥接器（调用 `~/.codex/basic-memory/bridge.py`）；
   - 提供 28 个原生 MCP 工具（含语义检索、POSIX 风格文件操作 `ls`/`cat`、远端状态账本 `bm_capture_*` 与维护工具 `bm_memory_maintenance`）；
   - Hook 运行时优先直连本机常驻回环代理 `http://127.0.0.1:18894/mcp`（4s 超时），代理不可达时自动回退至带 `select` 超时保护的 `bridge.py` 子进程。
2. **自动召回 Auto-Recall (`PreInvocation`)**：
   - **单轮幂等去重与重试保护**：`PreInvocation` 仅在 `search_notes` 成功返回后才将 `(session_id, turn_id)` 记入 `local_recall_turns`，保证同一轮多次工具调用不重复触发，且瞬时网络抖动可在下一步自动重试；
   - **寒暄与短指令门控**：自动跳过纯确认/寒暄短语（如“好的”、“继续”、“立即修复”等）及过短输入，避免无效 Embedding 与检索开销；
   - **噪音与过期笔记过滤**：通过 `search_notes(..., output_format="json", min_similarity=0.60)` 检索 `main` 项目，自动剔除未审阅原始会话收件箱（`*/inbox/*`、`status: pending_review`）及已归档/替代笔记（`status: superseded | archived | expired`）；
   - **会话级增量去重**：通过 `session_recalled_notes` 记录当前会话已注入的 `(permalink, updated_at)`，同一会话后续轮次不再重复注入未发生更新的同一篇笔记；
   - 仅在存在新增有效匹配时，以 `ephemeralMessage`（瞬时消息，不污染持久上下文）无缝注入提示词。
3. **同轮周期语义捕捉与自动记忆整理 (`PreInvocation` + `Stop`)**：
   - **同轮静默执行（无二次续轮打断）**：在有效用户回合的 `PreInvocation` 阶段同步会话序号（`bm_capture_turn`），离线时暂存至本地 SQLite 账本（`~/.gemini/antigravity/memory/reviews.sqlite3`）并在后续回合补发；
   - **Lazy MCP 适配与查重规范**：当达到项目设定捕捉间隔（可在 Web UI 动态调整）时，在当前回合通过 `ephemeralMessage` 注入包含 Lazy MCP Schema 路径、`project="main"`、先查重后写入（更新带 `expected_checksum`）的捕捉指引，由 Agent 在最终回复前同轮静默完成；
   - **自动记忆整理联动 (`bm_memory_maintenance`)**：达到捕捉间隔时同步检查 `bm_memory_maintenance(status)`；若项目整理到期（`due=true`），将待整理批次清单与回执契约注入当前回合（明确跳过 `operation="deleted"` 笔记的读取、原位修正不合格标题并提交 `expected_after_position` 与完整 `reviewed_note_ids`）；
   - **安全 `Stop` 兜底**：`Stop` 钩子仅在正常结束（`terminationReason == "NO_TOOL_CALL"` 且存在助手回复）时补刷未同步的本地轮次，绝不在用户取消或异常终止时强制续轮。

---

## 安装与配置方式

为了保证即使源码目录移动或删除，Agent 的记忆能力依然独立稳定运行，推荐将套件**完整复制（非软链接）**至 Antigravity 用户全局插件目录：

### 1. 安装插件到用户全局目录

```bash
mkdir -p ~/.gemini/config/plugins/basic-memory
cp -r integrations/antigravity/* ~/.gemini/config/plugins/basic-memory/
chmod +x ~/.gemini/config/plugins/basic-memory/scripts/hook.py
```

### 2. 验证 MCP 服务注册

检查 `~/.gemini/config/mcp_config.json` 包含如下内容：

```json
{
  "mcpServers": {
    "basic-memory": {
      "command": "/opt/homebrew/bin/python3",
      "args": [
        "/Users/nanjiakai/.codex/basic-memory/bridge.py"
      ]
    }
  }
}
```

### 3. 生效与运行

- Antigravity 会在下一次会话或轮次触发时自动扫描加载 `~/.gemini/config/plugins/basic-memory`；
- 所有对话的轮次与去重状态将持久保存在 `~/.gemini/antigravity/memory/reviews.sqlite3`。
