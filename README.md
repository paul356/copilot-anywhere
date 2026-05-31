# Copilot Anywhere (Max)

Use GitHub Copilot from anywhere — Feishu, Telegram, or your terminal — all connected to the same Copilot session.

## Origin

This project is a fork of [burkeholland/max](https://github.com/burkeholland/max), heavily reworked. The original Max was an AI orchestrator for Telegram and TUI that used the Copilot SDK to manage multiple Worker sessions. We've:

- **Added Feishu support** — Feishu bot integration with the same unified message flow as Telegram and TUI
- **Refactored to Pass-Through architecture** — replaced Worker/Orchestrator model with direct Copilot SDK Session streaming. Simpler, more stable, fewer moving parts.
- **Added multi-workspace support** — each channel binds to its own working directory, managed via `/max:ws` commands
- **Fixed numerous bugs** — duplicate Feishu replies, dual-path permission conflicts, TUI workspace persistence, model config being ignored, and more

## Channels

| Channel  | Description |
|----------|-------------|
| Feishu   | Bot integration, supports P2P and group chats |
| Telegram | Remote access via Telegram Bot |
| TUI      | Local terminal UI (`max tui`) |

## Quick Start

```bash
# Install
npm install
npm run build

# Optional: set model (defaults to claude-sonnet-4.6)
export COPILOT_MODEL=deepseek-v4-pro

# Start the daemon
max start

# Connect via terminal
max tui
```

## Workspace Management

```
/max:ws list                 List all workspaces
/max:ws new <name> <path>   Create a workspace
/max:ws switch <name>       Switch active workspace
/max:ws delete <name>       Delete a workspace
```

## Architecture

```
Feishu / Telegram / TUI
         │
     route() — unified routing
         │
  MessageHandler.handle()
         │
    ┌────┼────┐
    │    │    │
  Max  CLI   Copilot
  cmds cmds  Session
               │
          Copilot SDK
```

## Development

```bash
npm run dev    # watch mode
npm run build  # compile TypeScript
```
