# Multi-Workspace Concurrent Processing

## Goal

Allow multiple workspaces to process prompts concurrently within a single channel (Feishu / Telegram / TUI). Currently per-channel serial queues block everything — a workspace waiting for `ask_user` blocks all other workspaces in the same channel.

## Core Rules

```
1. /max:* commands → never blocked, execute immediately
2. prompts          → queued by composite key `${channelKey}:${wsName}`
                      different workspaces don't block each other
                      same workspace serialized
3. active workspace → default message target (existing getActiveWorkspace)
4. max replies      → include workspace name
5. max 5 active     → when activating a new workspace, evict the oldest non-busy one
```

## Message Routing

```
user message
  │
  ├─ /max:* → execute immediately (ws switch / cancel / skip / list / help / status)
  │
  └─ prompt → targetWs = getActiveWorkspace(channelKey)
              │
              ├─ targetWs has pending question? → holdMessage(openId, targetWs, msg)
              │
              └─ no pending → queue key = `${ch}:${targetWs}`
                              only blocked when same key has in-flight
```

## ask_user Interaction

| Scenario | Freeform text | Card click |
|----------|:--:|:--:|
| Question from **active** ws | ✅ Answer | ✅ Answer |
| Question from **non-active** ws | Treated as new prompt (→ active ws) | ✅ Answer (by questionId + wsName) |
| Multiple ws with pending questions | — | Each card independent |

## Channel Separation

Key insight: **a single user never uses Feishu + TUI simultaneously**. 
Channel serialization is natural. The concurrency is **cross-workspace within the same channel**.

## State Variable Changes

| Variable | Current Key | New Key |
|----------|-------------|---------|
| `channelQueues` | `channelKey` | `${channelKey}:${wsName}` |
| `channelProcessing` | `channelKey` | `${channelKey}:${wsName}` |
| `activeCallbacks` | `channelKey` | `${channelKey}:${wsName}` |
| `pendingInput` | `channelKey` | `${channelKey}:${wsName}` |
| `sessionChannels` | `sessionId` → `channelKey` | UNCHANGED |
| `pendingQuestions` | `Map<openId, PendingQuestion>` | `Map<openId, PendingQuestion[]>` (+ wsName) |
| `heldMessages` | `Map<openId, msg[]>` | `Map<openId, Map<wsName, msg[]>>` |
| `workspacePool` | — | `Map<wsName, {lastUsed, busy}>` (NEW) |

## /max:* Command Targets

| Command | Target |
|---------|--------|
| `/max:ws new` | — (global) |
| `/max:ws list` | — (global) |
| `/max:ws switch` | current channel |
| `/max:ws delete <name>` | specified `name` |
| `/max:cancel` | active workspace |
| `/max:skip` | active workspace |
| `/max:status` | — (global; can expand to show all ws) |
| `/max:restart` | — (global daemon) |

## File Change List

| File | Changes | Scale |
|------|---------|-------|
| `src/message-handler.ts` | queue/callback/pendingInput key → composite; `/max:` bypass; busy tracking | 🔴 Heavy |
| `src/feishu/bot.ts` | `pendingQuestions[]` + wsName; `heldMessages` nested; answer routing; output labeling | 🟡 Medium |
| `src/copilot-client.ts` | `workspacePool`: track active ws + busy + lastUsed + eviction | 🟡 Medium |
| `src/telegram/bot.ts` | Same as Feishu pattern adjustment | 🟢 Light |
| `src/command-router.ts` | Cancel → target active workspace | 🟢 Light |
| `src/api/server.ts` | `answerUserInput` signature may adjust | 🟢 Light |
| `src/daemon.ts` | Minimal (workspacePool cleanup on shutdown) | 🟢 Light |

---

## Task List

- [ ] **1. Refactor `message-handler.ts` — composite queue keys**
  - Change `channelQueues`, `channelProcessing`, `channelCancels`, `channelActive` keys to `${channelId}:${wsName}`
  - Extract `targetWs` from `getActiveWorkspace(channelKey)` before queuing
  - `/max:*` commands get resolved immediately (enqueue + dequeue instantly, or bypass queue)
  - `activeCallbacks` and `pendingInput` keys also become composite
  - `workspaceBusy` tracking: mark busy on prompt start, mark idle on complete/cancel

- [ ] **2. Add `workspacePool` to `copilot-client.ts`**
  - `Map<wsName, { lastUsed: number; busy: boolean }>`
  - `MAX_ACTIVE = 5`
  - Eviction: scan pool, exclude `default` + busy, pick oldest `lastUsed`, remove
  - Update `lastUsed` on each request
  - Cleanup method for daemon shutdown

- [ ] **3. Refactor `feishu/bot.ts` — pendingQuestions & heldMessages**
  - `pendingQuestions`: `Map<openId, PendingQuestion[]>`; each entry has `wsName`
  - Text answer: match only active ws + pending
  - Card answer: match by `wsName` + `questionId`
  - `heldMessages`: `Map<openId, Map<wsName, msg[]>>`
  - `holdMessage(openId, wsName, ...)`: only when target ws has pending
  - `drainHeldMessages(openId, wsName)`: drain only the specific ws queue
  - Max reply label: `Max [wsName]: ...`

- [ ] **4. Refactor `feishu/bot.ts` — slash command handling**
  - `/max:cancel` → `cancelChannel(ch+ws)` for active workspace only
  - `/max:skip` → skip pending question for active workspace only

- [ ] **5. Adjust `telegram/bot.ts`** (if applicable)
  - Same pattern as Feishu for heldMessages / pendingQuestions
  - Workspace label on replies

- [ ] **6. Adjust `command-router.ts`**
  - `executeMaxCommand` → cancel/skip target active workspace
  - No other changes needed

- [ ] **7. Adjust `api/server.ts`**
  - `answerUserInput` → use composite key `tui:${connectionId}:${wsName}`

- [ ] **8. Adjust `daemon.ts`**
  - Shutdown: clean up workspacePool

- [ ] **9. Build verification**
  - `npx tsc --noEmit` passes
  - No regressions in existing behavior
