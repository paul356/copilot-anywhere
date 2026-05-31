# Copilot Anywhere (Max)

随时随地使用 GitHub Copilot — 通过飞书、Telegram 或终端，统一接入同一个 Copilot 会话。

## 项目由来

本项目基于 [burkeholland/max](https://github.com/burkeholland/max) 深度改造。原项目是一个运行在 Telegram 和 TUI 上的 AI 编排器，使用 Copilot SDK 管理多个 Worker 会话。我们在原项目基础上：

- **新增飞书渠道** — 支持飞书机器人接入，与 Telegram、TUI 共享统一的消息处理流程
- **重构为 Pass-Through 架构** — 废弃 Worker/Orchestrator 模式，消息直接透传给 Copilot SDK Session，更简洁、更稳定
- **多 Workspace 支持** — 每个渠道可绑定独立的工作目录，通过 `/max:ws` 命令管理
- **修复大量 bug** — 飞书消息去重、权限双路径冲突、TUI workspace 持久化、模型配置被忽略等问题

## 渠道

| 渠道 | 说明 |
|------|------|
| 飞书 | 通过飞书机器人收发消息，支持 P2P 和群聊 |
| Telegram | 通过 Telegram Bot 远程接入 |
| TUI | 本地终端 UI（`max tui`） |

## 快速开始

```bash
# 安装
npm install
npm run build

# 可选：设置模型（默认 claude-sonnet-4.6）
export COPILOT_MODEL=deepseek-v4-pro

# 启动 daemon
max start

# 终端连接
max tui
```

## Workspace 管理

```
/max:ws list                 列出所有 workspace
/max:ws new <name> <path>   创建 workspace
/max:ws switch <name>       切换活跃 workspace
/max:ws delete <name>       删除 workspace
```

## 架构

```
飞书 / Telegram / TUI
         │
     route() — 统一路由
         │
  MessageHandler.handle()
         │
    ┌────┼────┐
    │    │    │
  Max  CLI  Copilot
  命令  命令  Session
               │
          Copilot SDK
```

## 开发

```bash
npm run dev    # watch 模式
npm run build  # 编译 TypeScript
```
