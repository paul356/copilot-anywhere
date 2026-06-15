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
import { join } from "path";
import { existsSync } from "fs";

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
        "  /max:restart                 Restart the daemon",
        "  /max:skip                    Skip the current question",
        "  /max:cancel                  Cancel the current operation",
        "  /max:status                  Show daemon status",
        "  /max:help                    Show this help",
        "",
        "Use /help for Copilot CLI commands.",
      ].join("\n"),
    };
  },

  async status(_args, ctx) {
    const wsList = listWorkspaces();
    const lines: string[] = [
      `**Active workspace:** ${ctx.activeWorkspace}`,
      `**Total workspaces:** ${wsList.length}`,
    ];
    return { reply: lines.join("\n") };
  },
};

export function route(message: string, ctx: { senderId: string; channelKey: string; messageId?: string }): RoutedMessage {
  const trimmed = message.trim();

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
