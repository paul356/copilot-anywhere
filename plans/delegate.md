# Delegate（注意力代理）

## 核心理念

Delegate 是一个**注意力代理**。用户设定一个目标后，Delegate 替用户盯着 Copilot 干活，自动检查和纠正，用户无需手动逐条干预。但**全过程对用户可见**——所有消息（用户发的、Copilot 回的、Delegate 自己发的）都同步到聊天界面。

```
传统模式：
  用户 → 逐条指令 → Copilot → 用户逐条检查 → 用户修正

Delegate 模式：
  用户 → 设定目标 → 可见全过程 →
    Copilot 执行 → Delegate 检查 → 自动修正/继续 →
    循环直到目标完成 → 通知用户
```

用户看到的是一段完整的三方对话流，清楚标记每条消息的来源。

### 典型场景

Delegate 只提**目标性指令**——告诉 Copilot **还差什么没完成**，具体怎么做由 Copilot 自己发挥。

```
你: /max:delegate 帮我把登录从 JWT 换成 session-cookie，不改功能
Copilot: 已进入委托模式，目标已记录

你: 找到 auth 相关文件
Copilot: 找到了 auth.ts、middleware.ts

📋 Delegate: Delegating ...
📋 Delegate: 目标未完成，正在生成继续指令…
📋 Delegate → Copilot: 目标中还剩以下任务未完成：logout 函数改造、中间件 session 适配。请继续。
Copilot: 已修改 logout 函数...

📋 Delegate: Delegating ...
📋 Delegate: 目标未完成，正在生成继续指令…
📋 Delegate → Copilot: 还需检查：session 初始化、中间件适配。请继续。
Copilot: 已检查，中间件中 session 验证逻辑已就绪。

✅ Delegate: 目标已完成！登录已从 JWT 换成 session-cookie，未改其他功能。
```

### 偏离修正示例

Delegate 发现偏离时告诉 Copilot**偏到了哪里**以及**应该聚焦哪些任务**。

```
你: /max:delegate 把登录从 JWT 换成 session-cookie，不改功能

你: 把 login 改成 session-cookie
Copilot: 改了 login 函数，也重构了 logout 函数

📋 Delegate: Δ 在轨（重构 logout 是合理连带改动），继续…

你: 顺便把数据库从 MySQL 切到 PostgreSQL
Copilot: 好的，开始改数据库配置...

❌ Delegate: 偏离目标！当前目标限定为「把登录从 JWT 换成 session-cookie，不改功能」。
📋 Delegate → Copilot: 偏离目标了。请忽略数据库切换请求，继续登录改造的剩余任务：
  - logout 函数验证替换
  - 中间件 session 适配
```

## 关键原则：任务级指令，而非实现步骤

Delegate 告诉 Copilot **还需要完成什么任务**（WHAT），不替 Copilot 决定 **怎么做**（HOW）。

| ❌ 不好的做法（实现步骤） | ✅ 好的做法（任务级） |
|---|---|
| "请找到 auth.ts 第 42 行，把 jwt.verify 替换成 session.get" | "登录改造中 logout 函数还未处理" |
| "用 express-session 替换 jsonwebtoken，先安装依赖再改代码" | "还需要检查 session 初始化代码是否已添加" |
| "把 middleware.ts 的 import 和 verify 调用删掉" | "中间件中的 JWT 验证需要替换为 session 验证" |

Delegate 的 system prompt 明确要求：**指出还差哪些任务没完成、偏到了哪里，但不要给出具体代码、文件路径或实现方法。** Copilot 的能力足以自己决定实现路径，Delegate 给它留出发挥空间。

偏离修正时，Delegate 要同时说清两件事：
1. 当前偏到了哪里
2. 应该聚焦**哪些任务**

```
❌ 偏离：当前目标限定为「登录从 JWT 换成 session-cookie」。
   请忽略数据库相关请求，聚焦登录改造的剩余任务：
   - logout 函数验证替换
   - 中间件 session 适配
```

## 核心概念

| 角色 | 职责 | 模型要求 |
|------|------|----------|
| **Copilot**（执行者） | 按用户指令做事，改文件、跑命令 | 偏执行，快且便宜 |
| **Delegate**（注意力代理） | 记住目标，检查 Copilot 输出，自动纠正偏差 | 偏 reasoning，比执行模型强 |
| **用户** | 设定目标，接收完成通知 | — |

## 激活：`/max:delegate`

### 命令格式

```
/max:delegate                          → 从聊天历史提取目标，进入委托模式
/max:delegate <自由描述目标>              → 直接使用描述文本，进入委托模式
/max:delegate end                       → 退出委托模式
/max:delegate status                    → 查看当前 workspace 是否处于 delegate 模式及目标
/max:status                              → 输出中附带 delegate 状态行
```

如果 `MAX_DELEGATE_MODEL/API_KEY/BASE_URL` 未设置，上述命令返回：
```
⚠️ Delegate 未配置。请设置 MAX_DELEGATE_MODEL、MAX_DELEGATE_API_KEY、MAX_DELEGATE_BASE_URL。
```

### 可重入

`/max:delegate` 是可重入的。

| 调用 | 行为 |
|------|------|
| `/max:delegate` | 从历史提取目标 → 确认 → 开始监控 |
| `/max:delegate <新目标>` | **直接覆盖**当前目标，不需要用户确认（显式提供=用户已知） |
| `/max:delegate end` | 退出委托模式 |
| `/max:delegate status` | 显示当前 workspace 的委托状态（active / completed / exited）及目标文本 |

### 目标提取

`/max:delegate`（无参数）首次调用时：
- 从 `conversation_log` 读取最近 N 轮
- **只读 role='user' 的消息**，忽略 AI 应答（AI 的应答不包含用户意图，且会引入噪声）
- 用 supervisor 的 LLM 提取用户的核心目标意图
- 注意：这里不是直接将对话历史当成目标，而是**从对话中提取出用户想要达成的**客观目标**描述**

目标提取的 prompt（大致）：
```
从以下用户最近的对话中，提取出用户当前想达成的核心目标。
目标应该是一个客观、可验证的描述，不包括实现细节。
只输出目标文本，不要其他内容。

对话：
{只包含 role=user 的最近 N 条消息}

目标：
```

## 工作流

```
① 用户: /max:delegate [目标]
   → command-router: 解析为 max-command "delegate"
   → 从 conversation_log 读取最近用户消息
   → delegate.extractGoal(userMessages) → goalText
   → 存储到 DelegateStore（按 workspace key）
   → 回调: "✅ 已进入委托模式，目标：{goalText}"

② 用户: "找到 auth 相关文件"
   → message-handler: prompt case 正常执行
   → Copilot 回复完成 (session.idle) → callback(text, done, {source:"copilot"}) → 用户可见
   → callback("Delegating ...", false, {source:"delegate-status"}) → 用户可见（提示当前在委托模式）
   → Delegate 检查:
     - 收集最近对话（含本轮）
     - delegate.check(goal, conversation) → output

   ├── 第一行是 "完成"
   │    目标完成 → callback(text, true, {source:"delegate"}) → 用户可见
   │    退出委托（自动）
   │
   └── 第一行是 "继续"
        callback(output, true, {source:"delegate-prompt"}) → 用户可见
        （取第二行及之后的内容作为 prompt 转发给 Copilot）
        自动调用 handle({ type:"prompt", text: lines.slice(1).join("\n") }) 发回给 Copilot
        → Copilot 回复 → callback(text, done, {source:"copilot"}) → 用户可见
        → 继续检查（进入下一轮）

③ 循环: 步骤②不断重复，直到目标达成或达到最大轮数

④ 用户可随时:
   /max:delegate <新目标>     → 更新目标
   /max:delegate end           → 退出（后续不检查）
   /max:delegate status        → 查看状态
   /max:status                 → 输出包含 delegate 状态行
   随意发消息                  → 正常对话，但 Delegate 仍会检查
```

### Delegate 的角色限定

1. **不拦截用户消息** — 用户发的消息始终原样发给 Copilot
2. **任务级指令，不写实现步骤** — Delegate 发出**剩余任务清单**（如"还需要处理 logout 函数、session 初始化"），不替 Copilot 决定具体代码、文件路径或实现方法
3. **追加到对话中** — Delegate 的指令作为新一轮 prompt 发给 Copilot，用户全程可见

### 最大循环轮数

防止无限循环：Delegate 每轮自增 `iterationCount`，超过 `MAX_DELEGATE_ITERATIONS`（默认 20） 后强制退出并告知用户。

## 消息可见性：三方消息，清楚区分

即使在 Delegate 模式下，**所有消息都同步发给用户**。用户看到的是完整的三方对话流，且能一眼区分消息来源。

### Tag 方案

扩展 `MessageCallback` 签名，增加 `source` 字段：

```typescript
// 当前
type MessageCallback = (text: string, done: boolean) => void;

// 扩展后
type MessageCallback = (
  text: string,
  done: boolean,
  meta?: { source: "copilot" | "delegate" | "delegate-prompt" | "delegate-status" }
) => void;
```

各 channel（Feishu、Telegram、TUI）根据 source 决定展示方式：

| source | 含义 | 展示方式 |
|--------|------|----------|
| `"copilot"` | Copilot SDK 的回复 | 默认（无前缀或原有 `[ws:xxx]` tag） |
| `"delegate"` | Delegate 的检查结论（如目标完成） | 前缀 `✅ Delegate:` / `❌ Delegate:` |
| `"delegate-prompt"` | Delegate 自动发回给 Copilot 的指令 | 前缀 `📋 Delegate → Copilot:` |
| `"delegate-status"` | Delegate 的过程状态（如"正在检查"） | 前缀 `📋 Delegate:`，或灰色文字 |

### 各 channel 的展示实现

**Feishu**：不同 source 用不同卡片颜色或消息前缀。
**Telegram**：不同 source 用不同前缀 + 斜体/粗体标记。
**TUI**：不同 source 用不同颜色。

如果 channel 不支持富文本，回退到文本前缀 `[Delegate]` / `[Copilot]`。

### 用户看到的完整对话示例

```
┌─────────────────────────────────────────────┐
│ 你: /max:delegate 把登录从 JWT 换成 session-cookie │
├─────────────────────────────────────────────┤
│ Copilot: 已进入委托模式，目标已记录               │
├─────────────────────────────────────────────┤
│ 你: 找到 auth 相关文件                        │
├─────────────────────────────────────────────┤
│ Copilot: 找到了 auth.ts、middleware.ts        │
├─────────────────────────────────────────────┤
│ 📋 Delegate: Delegating ...                  │
├─────────────────────────────────────────────┤
│ 📋 Delegate: 目标未完成，正在生成继续指令...    │
│ 📋 Delegate → Copilot:                      │
│   "请找到 login/logout 函数并改成 session-cookie"│
├─────────────────────────────────────────────┤
│ Copilot: 正在修改 login 函数...               │
├─────────────────────────────────────────────┤
│ 📋 Delegate: 目标未完成，正在生成继续指令...    │
│ 📋 Delegate → Copilot: "继续修改 logout..."   │
├─────────────────────────────────────────────┤
│ Copilot: logout 已完成                       │
├─────────────────────────────────────────────┤
│ ✅ Delegate: 目标已完成！登录已从 JWT 换成      │
│   session-cookie，未改其他功能。              │
│   (委托模式已退出)                            │
└─────────────────────────────────────────────┘
```

## 架构

### Scope：目标与 Workspace 绑定

目标以**composite key** `{channelKey}:{wsName}` 存储。不同 workspace 的目标互不干扰。

```
DelegateStore:
  Map<"${channelKey}:${wsName}", {
    goal: string;
    iterationCount: number;
    status: "active" | "completed" | "exited";
  }>
```

### 现有的元素

| 已有 | 用途 |
|------|------|
| `CopilotSession`（copilot-client.ts） | Copilot 执行者，照常运行 |
| `conversation_log`（store/db.ts） | 记录了每轮用户和 LLM 的对话 |
| `message-handler.ts` 的 prompt case | 每轮对话的流入点——在这里插入 Delegate 检查 |
| `MessageHandler.handle()` | Delegate 可调用它自动发修正 prompt（带 delegate-prompt source） |
| `LLM_HARD_TIMEOUT_MS` | 现有超时机制 |

### 新增元素

```
src/delegate.ts             — Delegate 核心逻辑
src/delegate-store.ts       — 委托状态管理
```

### 数据流

```
用户 → prompt text
  → message-handler: 正常发送给 Copilot
  → CopilotSession.send() → streaming response → callback(text, done, {source:"copilot"}) → 用户看到回复
  → session.idle 触发
  → (if delegate active for this wsKey)
      → callback("Delegating ...", false, {source:"delegate-status"})  // 提示用户当前在委托模式
      → 收集最近对话（3 轮） + 当前目标
      → delegate.check(goal, conversation) → verdict

      第一行 == "完成":
        → callback(output, true, {source:"delegate"})
        → 从 DelegateStore 移除

      第一行 == "继续":
        → const promptText = lines.slice(1).join("\n").trim()
        → callback(promptText, true, {source:"delegate-prompt"})
        → messageHandler.handle(
            { type:"prompt", text:promptText, _delegateSource:"delegate-prompt" },
            ...
          )
        → iterationCount++
```

注意：Delegate 自动发出的 prompt 走正常 `handle()` 流程——Copilot 会正常回复。用户看到的下一轮 Copilot 回复，其实就是针对 Delegate 指令的应答。`_delegateSource` 标记用于 message-handler 内部识别这条 prompt 来自 Delegate，非必须（也可以不留痕）。

### 输入给 Delegate 的内容

Delegate **不读代码、不读项目文件、不读文件系统**。  
它的判断完全基于文本对话——**系统 prompt + 当前目标 + 最近 Copilot 对话**。

这可能产生局限（例如 Copilot 说"改完了"但实际改错了，Delegate 无法验证），但在大部分场景下足够识别明显的偏差和进度。

监测范围：

- 最近 **3 轮**用户+AI 的对话（含当前轮）
- 当前目标文本
- 系统 prompt（告诉 Delegate 它的角色和输出格式）
- 不读整段历史，不读系统消息，不读其他 channel/workspace 的对话

```
=== 当前目标: 把登录从 JWT 换成 session-cookie，不改功能 ===

=== 最近对话 ===

用户: 找到 auth 相关文件
AI: 找到了 auth.ts、middleware.ts

用户: 把 login 改成 session-cookie
AI: 改了 login 函数，同时也重构了 logout 函数。
```

## 配置

Delegate 参数全部可选——缺失时 Max 正常启动，只是 delegate 功能不可用（`/max:delegate` 会提示 "Delegate 未配置，请设置 MAX_DELEGATE_MODEL/API_KEY/BASE_URL"）。启动时不校验这些参数。

同 Telegram/Feishu 的机制——配置了才能用。

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `MAX_DELEGATE_MODEL` | （未设置） | Delegate 使用的模型。**必须三个一起设**才能启用。建议比执行模型更强的 reasoning 模型。 |
| `MAX_DELEGATE_API_KEY` | （未设置） | Delegate 模型的 API key |
| `MAX_DELEGATE_BASE_URL` | （未设置） | Delegate 模型的 API endpoint |
| `MAX_DELEGATE_PROMPT_LENGTH` | 400 | 软引导参数。在 system prompt 中提示 Delegate "保持简短"，不截断。 |
| `MAX_DELEGATE_MAX_ITERATIONS` | 20 | 最大自动循环轮数 |
| `MAX_DELEGATE_VERBOSE` | `false` | 是否显示 "继续中…" 等过程消息 |

Delegate 使用**独立于 Copilot SDK** 的 LLM 调用（直接 HTTP API），因为：
- 需要更强/不同的模型
- 需要完全控制推理参数
- 不消耗 Copilot SDK 的配额/session

## 关键问题

1. **延迟**：每轮 Copilot 回复后多一次 LLM 调用
   - 用户看到 Copilot 原始回复后才触发 Delegate 检查，不阻塞
   - Delegate 追加 prompt 走正常 queue，用户看到第 2 条回复时知道在修正
2. **成本**：每轮多消耗一次 API 调用 + 可能的自动续发
   - 默认不启用，用户手动 `/max:delegate` 进入
3. **误报**：Delegate 可能把合理连带改动作偏离
   - 数据上已做保护：修正 prompt 走正常 handle 流程，用户能看到执行过程
   - 用户随时 `/max:delegate end` 退出即可
4. **无限循环**：Delegate 自动续发可能导致死循环
   - `MAX_DELEGATE_MAX_ITERATIONS` 硬限制
   - 连续 3 次 `check()` 输出 "继续" 且对话无实质进展 → 强制退出并通知用户

## 任务列表

### Phase 1：基础设施

- [ ] **P1-delegate-store** `src/delegate-store.ts` — 委托状态管理
  - `Map<wsKey, { goal, iterationCount, status }>`
  - `enter(wsKey, goal)` — 进入委托模式
  - `exit(wsKey)` — 退出
  - `isActive(wsKey): boolean`
  - `getGoal(wsKey): string | null`
  - `getStatus(wsKey): { status: string; goal: string } | null` — 供 `/max:delegate status` 和 `/max:status` 调用
  - `incrementIteration(wsKey): number`
- [ ] **P1-delegate** `src/delegate.ts` — Delegate 核心
  - `extractGoal(userMessages: string[]): string` — 从用户消息提取目标
  - `check(goal: string, conversation: string): Promise<string>` — 输出格式：
    ```
    完成
    目标已完成，登录已从 JWT 换成 session-cookie。
    ```
    或
    ```
    继续
    logout 函数还需改造、中间件 session 适配。请继续。
    ```
    - 第一行决定分支：`完成` = 退出循环；`继续` = 取第二行之后作为 prompt 发给 Copilot
    - system prompt: "你是一个 Delegate（注意力代理）。用户设定了以下目标：{goal}。以下是最近一段对话。你无法读取代码或项目文件，只能基于对话文本判断。第一行输出「完成」或「继续」。如果目标已达成，第一行输出「完成」，第二行起告知用户结果。否则第一行输出「继续」，第二行起给出 Copilot 下一步需要完成的任务。保持简短。"
  - 30s 超时，失败返回 `"请继续之前的目标"`（稳当退）
- [ ] **P1-delegate-cmd** `src/command-router.ts` — `/max:delegate [text]`、`/max:delegate end`、`/max:delegate status`
  - `/max:status` 命令中也附带 delegate 状态行（从 `DelegateStore.getStatus()` 查询）
- [ ] **P1-hook** `src/message-handler.ts` — prompt case 的 `session.idle` 回调中插入 delegate 检查

### Phase 2：完善

- [ ] **P2-verbose** — 开启 verbose 时输出自动发起的指令摘要
- [ ] **P2-stall-detection** — 连续 3 次 `check()` 输出 "继续" 且对话无实质进展 → 退出并告知用户
- [ ] **P2-persist** — 目标持久化到 SQLite

## 关键文件

| 文件 | 改动 |
|------|------|
| `src/delegate.ts` | **新增** — delegate 核心 |
| `src/delegate-store.ts` | **新增** — 委托状态管理 |
| `src/command-router.ts` | 新增 `/max:delegate` 命令 |
| `src/message-handler.ts` | prompt case 的 session.idle 中插入 delegate 检查循环 |
| `plans/cli-reviewer.md` | 本文档 |
