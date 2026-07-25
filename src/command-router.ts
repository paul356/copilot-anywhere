/**
 * Command Router
 *
 * Routes incoming messages into three categories:
 *   1. /max:<cmd>    → Max's own workspace management commands
 *   2. /<slash-cmd>  → Copilot CLI slash commands (forwarded to PTY)
 *   3. plain text    → Copilot SDK session prompt
 *
 * Commands are case-insensitive. The prefix "/max:" is reserved
 * and never forwarded to the CLI.
 */

import { createWorkspace, deleteWorkspace, listWorkspaces, getWorkspace, setActiveWorkspace, getActiveWorkspace } from "./store/db.js";
import { destroyAndInvalidateSession } from "./copilot-client.js";
import { join } from "path";
import { existsSync } from "fs";
import { config } from "./config.js";
import * as delegateStore from "./delegate-store.js";
import { extractGoal } from "./delegate.js";

// ── Types ──────────────────────────────────────────────────────────

/** Attachment that can be sent alongside a prompt to the model. */
export type Attachment =
  | { type: "file"; path: string; displayName?: string }
  | { type: "blob"; data: string; mimeType: string; displayName?: string };

export type RoutedMessage =
  | { type: "max-command"; name: string; args: string[]; senderId: string }
  | { type: "cli-command"; command: string; senderId: string }
  | { type: "prompt"; text: string; attachments?: Attachment[]; workingDirectory?: string; senderId: string };

export interface CommandContext {
  senderId: string;
  /** Name of the user's active workspace (default: "default") */
  activeWorkspace: string;
  /** Channel key for persisting active workspace preference */
  channelKey: string;
}

export interface CommandResult {
  /** Human-readable response */
  reply: string;
  /** If the active workspace changed, the new name */
  activeWorkspaceChanged?: string;
  /** If a workspace was created, its working directory */
  workspaceDirectory?: string;
  /** If set, enqueue this as the first prompt — Copilot needs to know the goal. */
  delegateStartPrompt?: string;
  /** If true, only enqueue delegateStartPrompt when Copilot is idle. */
  delegateStartOnlyIfIdle?: boolean;
}

// ── Handlers ──────────────────────────────────────────────────────────

const handlers: Record<string, (args: string[], ctx: CommandContext) => Promise<CommandResult>> = {
  async ws(args, ctx) {
    const sub = args[0]?.toLowerCase();
    const rest = args.slice(1);

    switch (sub) {
      case "new": {
        const name = rest[0];
        const dir = rest[1] ?? (name ? join(process.env.HOME || "/home", "workspaces", name) : undefined);
        if (!name || !dir) return { reply: "Usage: /max:ws new <name> <path>" };
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
          return { reply: "Workspace name must be lowercase alphanumeric with optional hyphens (e.g. my-project)." };
        }
        if (name === "default") {
          return { reply: "Cannot create a workspace named 'default'." };
        }
        if (getWorkspace(name)) {
          return { reply: `Workspace '${name}' already exists. Use /max:ws switch ${name} to activate it.` };
        }
        if (!existsSync(dir)) {
          return { reply: `Directory not found: ${dir}` };
        }
        try {
          createWorkspace(name, dir);
          return { reply: `✅ Workspace '${name}' created → ${dir}\nUse /max:ws switch ${name} to activate it.`, workspaceDirectory: dir };
        } catch (e: any) {
          return { reply: `Failed to create workspace: ${e.message}` };
        }
      }
      case "switch": {
        const name = rest[0];
        if (!name) return { reply: "Usage: /max:ws switch <name>" };
        if (name !== "default" && !getWorkspace(name)) {
          return { reply: `Workspace '${name}' not found. Use /max:ws list to see available workspaces.` };
        }
        setActiveWorkspace(ctx.channelKey, name);
        if (name === "default") {
          return { reply: "Switched to default workspace (daemon cwd).", activeWorkspaceChanged: name };
        }
        const ws = getWorkspace(name)!;
        return { reply: `Switched to workspace '${name}' → ${ws.working_dir}`, activeWorkspaceChanged: name, workspaceDirectory: ws.working_dir };
      }
      case "delete": {
        const name = rest[0];
        if (!name) return { reply: "Usage: /max:ws delete <name>" };
        if (name === "default") return { reply: "Cannot delete the default workspace." };
        try {
          deleteWorkspace(name);
          const wasActive = name === ctx.activeWorkspace;
          if (wasActive) setActiveWorkspace(ctx.channelKey, "default");
          const msg = wasActive
            ? `Workspace '${name}' deleted. Switched back to default.`
            : `Workspace '${name}' deleted.`;
          return { reply: msg, activeWorkspaceChanged: wasActive ? "default" : undefined };
        } catch (e: any) {
          return { reply: `Failed to delete workspace: ${e.message}` };
        }
      }
      case "list": {
        const wsList = listWorkspaces();
        const active = getActiveWorkspace(ctx.channelKey);
        const lines: string[] = ["Workspaces:"];
        lines.push(`  ${active === "default" ? "●" : "○"} default (daemon cwd)`);
        for (const ws of wsList) {
          lines.push(`  ${ws.name === active ? "●" : "○"} ${ws.name} → ${ws.working_dir}`);
        }
        return { reply: lines.join("\n") };
      }
      default:
        return { reply: "Usage: /max:ws new|switch|delete|list" };
    }
  },

  async delegate(args, ctx) {
    const sub = args[0]?.toLowerCase();
    const wsKey = `${ctx.channelKey}:${ctx.activeWorkspace}`;

    // Not configured
    if (!config.delegateEnabled) {
      return { reply: "⚠️ Delegate 未配置。请设置 MAX_DELEGATE_MODEL、MAX_DELEGATE_API_KEY、MAX_DELEGATE_BASE_URL。" };
    }

    // /max:delegate end
    if (sub === "end") {
      if (!delegateStore.isActive(wsKey)) {
        return { reply: "当前未处于委托模式。" };
      }
      delegateStore.exit(wsKey);
      return { reply: "✅ 已退出委托模式。" };
    }

    // /max:delegate status
    if (sub === "status") {
      const st = delegateStore.getStatus(wsKey);
      if (!st) return { reply: "⚪ 当前未处于委托模式。" };
      return { reply: `🟢 委托模式激活中 — 目标：${st.goal}` };
    }

    // /max:delegate — extract goal from conversation history
    if (sub === undefined || args.length === 0) {
      // No goal text provided — extract from conversation history
      // We import db here to avoid circular dependency at module level
      const { getRecentUserMessages } = await import("./store/db.js");
      const userMessages = getRecentUserMessages(10);
      if (userMessages.length === 0) {
        return { reply: "没有找到对话历史，无法提取目标。请用 /max:delegate goal <你的目标>" };
      }
      const goal = await extractGoal(userMessages);
      delegateStore.enter(wsKey, goal);
      return {
        reply: `✅ 已进入委托模式。\n目标：${goal}\n\n可随时用 /max:delegate goal <新目标> 更新目标，或用 /max:delegate end 退出。`,
        delegateStartPrompt: goal,
        delegateStartOnlyIfIdle: true,
      };
    }

    // /max:delegate goal <goal text> — explicit goal, rest joined as text
    const goal = args.slice(1).join(" ");
    if (!goal) {
      return { reply: "用法：/max:delegate goal <目标描述>" };
    }
    delegateStore.enter(wsKey, goal);
    return {
      reply: `✅ 已进入委托模式。\n目标：${goal}\n\n可随时用 /max:delegate goal <新目标> 更新目标，或用 /max:delegate end 退出。`,
      delegateStartPrompt: goal,
    };
  },

  async restart(_args, _ctx) {
    // Delay the actual restart so the reply can be sent to the user first.
    // Use the daemon's restartDaemon() (via dynamic import to avoid circular
    // dependency) so the CLI PTY subprocess is properly stopped before exit.
    // Without this, the old copilot --ui-server process lingers and is left
    // behind when the user later Ctrl+C's the new daemon.
    setTimeout(() => {
      import("./daemon.js").then(({ restartDaemon }) =>
        restartDaemon().catch((err: unknown) => {
          console.error("[max] Restart failed:", err);
          process.exit(1);
        }),
      );
    }, 200);
    return { reply: "🔄 Restarting Max..." };
  },

  async help(_args, _ctx) {
    return {
      reply: [
        "Max commands:",
        "  /max:ws new <name> <path>   Create new workspace",
        "  /max:ws switch <name>        Switch workspace",
        "  /max:ws delete <name>        Delete workspace",
        "  /max:ws list                 List all workspaces",
        "  /max:delegate                 Enter delegate mode (extract goal from history)",
        "  /max:delegate goal <text>     Enter delegate mode with explicit goal",
        "  /max:delegate end            Exit delegate mode",
        "  /max:delegate status         Show delegate status",
        "  /max:restart                 Restart the daemon",
        "  /max:skip                    Skip the current question",
        "  /max:cancel                  Cancel queued messages, or in-flight if queue is empty",
        "  /max:clear                   Clear the current workspace's Max conversation",
        "  /max:status                  Show daemon status",
        "  /max:help                    Show this help",
        "",
        "Use /help for Copilot CLI commands.",
      ].join("\n"),
    };
  },

  async clear(args, ctx) {
    // /max:clear takes no parameters. The active workspace is implied
    // (each channel has its own active workspace). If a parameter is
    // passed, the user probably wanted to clear a specific workspace —
    // refuse and tell them how to switch first.
    if (args.length > 0) {
      return {
        reply: "Usage: /max:clear (no parameters; clears the current workspace's Max conversation). To clear a different workspace, /max:ws switch to it first.",
      };
    }
    const wsName = ctx.activeWorkspace;
    if (!destroyAndInvalidateSession(wsName)) {
      return {
        reply: `⏳ Workspace '${wsName}' is busy with an in-flight prompt. Use /max:cancel first, then /max:clear.`,
      };
    }
    return {
      reply: `🧹 Max session cleared for workspace '${wsName}'. The next prompt will start a fresh conversation.`,
    };
  },

  async clearHint(_args, _ctx) {
    // Returned when a chat-channel user types raw `/clear`. The Copilot
    // CLI TUI's own /clear only clears the CLI's screen buffer; it
    // never reaches the SDK session that handles chat-channel prompts,
    // so routing it to the PTY is misleading. Tell the user to use
    // /max:clear instead.
    return {
      reply: "⚠️ `/clear` 在 chat 渠道已禁用 — 它只清 Copilot CLI TUI 自己的屏显，不会清 Max 的对话历史。\n请用 `/max:clear` 来清空当前 workspace 的对话上下文。\n(TUI 终端里直接打 `/clear` 仍按 CLI 自己的方式工作。)",
    };
  },

  async status(_args, ctx) {
    const wsList = listWorkspaces();
    const wsKey = `${ctx.channelKey}:${ctx.activeWorkspace}`;
    const delegateStatus = delegateStore.getStatus(wsKey);
    const delegateLine = delegateStatus
      ? `**Delegate:** 🟢 active → ${delegateStatus.goal}`
      : "**Delegate:** ⚪ inactive";
    const lines: string[] = [
      `**Active workspace:** ${ctx.activeWorkspace}`,
      delegateLine,
      `**Total workspaces:** ${wsList.length}`,
    ];
    return { reply: lines.join("\n") };
  },
};

export function route(message: string, ctx: { senderId: string; channelKey: string; messageId?: string }): RoutedMessage {
  const trimmed = message.trim();

  // Special-case raw `/clear` in chat channels AND TUI: route to
  // clearHint instead of forwarding to the Copilot CLI PTY. The
  // CLI's /clear only clears the CLI's own TUI screen, not Max's
  // SDK session — forwarding it would be misleading (the user
  // thinks the conversation is cleared but turn 23 still shows up
  // next prompt). TUI was added in commit a following the principle
  // "TUI is a chat-like channel, behavior should not differ".
  if (trimmed === "/clear" && (
    ctx.channelKey.startsWith("feishu:") ||
    ctx.channelKey.startsWith("telegram:") ||
    ctx.channelKey.startsWith("tui:")
  )) {
    return { type: "max-command", name: "clear-hint", args: [], senderId: ctx.senderId };
  }

  if (trimmed.startsWith("/max:")) {
    // ─── Max command ───
    const rest = trimmed.slice("/max:".length).trim();
    const spaceIdx = rest.indexOf(" ");
    const name = spaceIdx === -1 ? rest.toLowerCase() : rest.slice(0, spaceIdx).toLowerCase();
    const argsStr = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();
    const args = argsStr ? argsStr.split(/\s+/) : [];
    const mid = ctx.messageId ? ` msg=${ctx.messageId.slice(0, 8)}` : "";
    console.log(`[max] Routed max-command: /max:${name} ${argsStr}`.trimEnd() + ` (sender: ${ctx.senderId}${mid})`);
    return { type: "max-command", name, args, senderId: ctx.senderId };
  }

  if (trimmed.startsWith("/")) {
    const mid = ctx.messageId ? ` msg=${ctx.messageId.slice(0, 8)}` : "";
    console.log(`[max] Routed cli-command: ${trimmed.slice(0, 80)} (sender: ${ctx.senderId}${mid})`);
    return { type: "cli-command", command: trimmed, senderId: ctx.senderId };
  }

  // ─── Plain text prompt ───
  return { type: "prompt", text: trimmed, senderId: ctx.senderId };
}

/** Execute a /max: command and return the result */
export async function executeMaxCommand(
  name: string,
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  const handler = handlers[name];
  if (!handler) {
    return { reply: `Unknown command: /max:${name}. Use /max:help to see available commands.` };
  }
  try {
    return await handler(args, ctx);
  } catch (err: any) {
    return { reply: `命令执行出错: ${err.message}` };
  }
}
