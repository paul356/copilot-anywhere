# Unified Pass-Through Architecture

## Goal

TUI / Telegram / Feishu all use the same message processing flow. Channels only handle I/O — routing, command execution, and workspace resolution happen in one place.

```
Channel → route() → MessageHandler.handle(routed, channelKey, callback)
                        │
                        ├── max-command → executeMaxCommand() with getActiveWorkspace()
                        ├── cli-command  → CLIProcess.sendCommandAndWait()
                        └── prompt       → CopilotSession SDK stream
```

## Task List

- [x] **1. Unify max-command into MessageHandler.handle()** (`src/message-handler.ts`)
  - `handle()` handles `max-command` type internally, calls `getActiveWorkspace(channelKey)` for workspace
  - Remove standalone `handleMaxCommand()` method
  - Signature: `handle(routed: RoutedMessage, channelKey: string, callback: MessageCallback)`

- [x] **2. Unify TUI flow** (`src/api/server.ts`)
  - `/message`: remove inline `route()` + `executeMaxCommand()`, just call `handler.handle(result, channelKey, callback)`
  - Remove redundant imports (`route`, `executeMaxCommand`)

- [x] **3. Unify Telegram flow** (`src/telegram/bot.ts`)
  - Inject `MessageHandler` instead of `_sendToCopilot` / `_cancelChannel` bridges
  - `createBot(messageHandler)` — same signature as Feishu
  - Text/photo handlers: `route()` → `handler.handle()`
  - `/cancel` command: `handler.cancelChannel()`

- [x] **4. Remove sendToCopilot bridge** (`src/daemon.ts`)
  - Delete `sendToCopilot()` function
  - Wire Telegram via `createBot(handler)` (same as Feishu)

- [x] **5. Unify duplicate workspace commands** (`src/command-router.ts`, `src/commands.ts`)
  - Merged `handleWorkspace` from `commands.ts` into `command-router.ts`
  - English output throughout (consistent with Telegram style)
  - `commands.ts` delegates to `executeMaxCommand("ws", ...)`
  - Added validations: name format, `existsSync`, duplicate check
  - Updated `help` and `status` messages to English

- [x] **6. Build verification**
  - `npx tsc --noEmit` passes ✅
  - No orchestrator references in `daemon.ts`, `message-handler.ts`, `api/server.ts` ✅
  - Stale comment fixed in `tui/index.ts` ✅
