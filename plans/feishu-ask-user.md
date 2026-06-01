# Feishu ask_user Support

## 目标

当 LLM 使用 `ask_user` 工具时，Feishu 用户能够收到格式化问题并通过回复参与交互。

## 设计方案

### 核心流程

```
LLM 调用 ask_user
  → handleUserInput → callback(question JSON, false)
  → Feishu callback 检测 question JSON
  → 发送 Feishu 问题消息（有 choices 用卡片按钮，freeform 用文本）
  → 注册 pendingFeishuQuestions[openId]
  → handleUserInput Promise 等待...

用户点击按钮 / 发送文字回复 / 发送 /skip
  → 检测到 pending question
  → 调用 answerUserInput(channelKey, answer)
  → Promise resolve → LLM 收到答案继续生成
  → 最终回复发送给用户
```

### 区分"答案"与"新 prompt"的策略

| 用户行为 | 处理方式 |
|----------|----------|
| 点击卡片按钮 | card action 回调 → 100% 确定是答案 |
| 发送文本（有 pending） | 视为答案（freeform） |
| 发送 `/skip`（有 pending） | 取消问题，resolve "User skipped" |
| 发送 `/max:` 命令（有 pending） | 取消问题，执行命令 |
| 5 分钟无响应 | message-handler 超时自动 resolve |

### Feishu 消息格式

**有 choices（交互卡片）**:
```json
{
  "elements": [
    {"tag": "div", "text": {"tag": "lark_md", "content": "**你喜欢哪种水果？**"}},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"tag": "plain_text", "content": "苹果"},
       "type": "primary", "value": {"choice": "苹果", "openId": "ou_xxx"}},
      ...
    ]},
    {"tag": "div", "text": {"tag": "plain_text",
     "content": "或直接回复文字（发送 /skip 跳过）"}}
  ]
}
```

**仅 freeform（文本消息）**:
```
💬 <问题>
（直接回复，或发送 /skip 跳过）
```

### LarkChannel vs 现有 WSClient

`CardActionEvent` 通过 `LarkChannel` 的 WebSocket 处理，不需要 HTTP 服务器。  
但当前代码使用的是低级 `WSClient + EventDispatcher`，**不支持 card action 回调**。

**选项 A（推荐）**: 继续用 WSClient，card action 走 HTTP endpoint（Feishu 需要配置卡片回调 URL）  
**选项 B**: 迁移到 `LarkChannel` 高层 API，原生支持 `cardAction` 事件  
**选项 C（最简可行）**: 不用卡片按钮，只用文本消息 + 下一条回复机制

> **当前决策**: 先用选项 C（文本消息）快速实现完整流程，卡片按钮作为后续优化。

---

## TODO List

### Phase 1: 修复现有 Feishu callback（累积 delta bug）

- [ ] **P1-fix-callback** `src/feishu/bot.ts`  
  `processMessage` 的 callback 目前执行 `chunks.push(responseText)` 再 `join("")`，  
  在累积 delta 修复后会重复拼接导致响应内容重复。  
  **修复**: 改为 `latestText = responseText`，`done=true` 时取 `latestText`。

### Phase 2: Feishu pending question 基础设施

- [ ] **P2-pending-map** `src/feishu/bot.ts`  
  新增 `pendingFeishuQuestions: Map<string, { messageId: string; chatId: string }>`。  
  key = openId，存储需要发送最终回复用的 messageId / chatId。

- [ ] **P2-question-detect** `src/feishu/bot.ts`  
  修改 `processMessage` 的 callback，检测 `text.startsWith('{"type":"question"')`：  
  - 解析 JSON 取出 question / choices / allowFreeform  
  - fire-and-forget 调用 `sendQuestionMessage(...)` 发问题  
  - 在 `pendingFeishuQuestions` 注册当前 openId  
  - 不 push 到 chunks（防止重复发送）

- [ ] **P2-send-question** `src/feishu/bot.ts`  
  实现 `sendQuestionMessage(messageId, chatId, openId, question, choices?, allowFreeform?)`:  
  - 有 choices：发带编号列表的 markdown 卡片，底部加提示文字  
  - 无 choices / freeform：发纯文本提示  
  - 格式示例：`💬 **你喜欢哪种水果？**\n1. 苹果\n2. 梨\n...\n（回复数字或文字，/skip 跳过）`

### Phase 3: 消息路由——区分答案与新 prompt

- [ ] **P3-route-answer** `src/feishu/bot.ts`  
  在消息接收处理入口（`im.message.receive_v1`）中，在调用 `processMessage` 之前：  
  ```
  if pendingFeishuQuestions.has(openId):
    if text === "/skip":
      delete pending, answerUserInput(channelKey, "User skipped the question.")
      return  // 不回复
    else if text.startsWith("/max:") or is a command:
      delete pending, answerUserInput(channelKey, "User sent a new command.")
      // 继续处理命令（fall-through）
    else:
      // 解析数字 → choice 文本
      delete pending, answerUserInput(channelKey, resolvedAnswer)
      return  // 不作为新 prompt
  ```

- [ ] **P3-resolve-choices** `src/feishu/bot.ts`  
  实现 `resolveChoiceAnswer(text, choices?)`: 用户输入数字时映射到对应 choice 文本，  
  其他文本原样返回（复用 TUI 的逻辑）。

### Phase 4: 测试与清理

- [ ] **P4-test-flow** 手动测试完整流程：  
  - 发送触发 ask_user 的 prompt  
  - 收到问题消息  
  - 回复数字 → LLM 收到对应选项  
  - 回复文字 → LLM 收到原始文字（freeform）  
  - 发送 `/skip` → LLM 收到 skip 消息并继续  
  - 等待超时（缩短为 10s 测试）→ LLM 收到 timeout 消息

- [ ] **P4-cleanup** 确认无重复回复、无 pending 泄漏（超时后 map 已清理）

### Phase 5（后续优化）: 卡片按钮

- [ ] **P5-card-buttons** 迁移到 `LarkChannel` 或增加 HTTP card action endpoint，  
  使用真正的交互卡片按钮替代文本数字选择，提升体验。

---

## 关键文件

| 文件 | 改动 |
|------|------|
| `src/feishu/bot.ts` | 主要改动：pending map、callback 修复、消息路由 |
| `src/message-handler.ts` | 已有 `answerUserInput()`，无需改动 |
| `src/feishu/formatter.ts` | 可能需要新增 question card 格式函数 |
