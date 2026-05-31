import { getClient, stopClient } from "./copilot-client.js";
import { startApiServer } from "./api/server.js";
import { createBot, startBot, stopBot, sendProactiveMessage } from "./telegram/bot.js";
import {
  createBot as createFeishuBot,
  startBot as startFeishuBot,
  stopBot as stopFeishuBot,
  sendProactiveMessage as sendFeishuProactiveMessage,
} from "./feishu/bot.js";
import { getDb, closeDb } from "./store/db.js";
import { config } from "./config.js";
import { spawn, execSync } from "child_process";
import { readdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { checkForUpdate } from "./update.js";
import { ensureWikiStructure } from "./wiki/fs.js";
import { shouldMigrate, migrateMemoriesToWiki, shouldReorganize, reorganizeWiki } from "./wiki/migrate.js";
import { SESSIONS_DIR } from "./paths.js";
import { CLIProcess } from "./cli-process.js";
import { MessageHandler } from "./message-handler.js";
import { getWorkspace, getActiveWorkspace } from "./store/db.js";
import { getOrCreateSession } from "./copilot-client.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let cliProcess: CLIProcess | undefined;
let messageHandler: MessageHandler | undefined;

/** Kill any process already listening on our copilot port (stale from a crashed/restarted daemon). */
async function killStaleCopilotOnPort(port: number): Promise<void> {
  try {
    // Find PID of process listening on our port
    const result = execSync(`fuser ${port}/tcp 2>/dev/null || true`, {
      timeout: 3000,
      encoding: "utf-8",
    }).trim();
    if (!result) {
      console.log(`[max] Port ${port} is free`);
      return;
    }
    // fuser output is like "9999/tcp: 12345" — extract PID
    const pidMatch = result.match(/(\d+)$/);
    if (!pidMatch) return;
    const pid = parseInt(pidMatch[1], 10);
    console.log(`[max] Port ${port} held by PID ${pid} — killing stale copilot...`);
    try { process.kill(pid, "SIGTERM"); } catch {}
    // Wait a moment then force kill if still alive
    await new Promise((r) => setTimeout(r, 500));
    try { process.kill(pid, "SIGKILL"); } catch {}
    console.log(`[max] Stale copilot (PID ${pid}) killed`);
  } catch {
    // best effort — if the port is free, start() will succeed
  }
}

/** Remove orphaned session folders older than 7 days. */
function pruneOldSessions(): void {
  try {
    const sessionStateDir = join(SESSIONS_DIR, "session-state");

    let entries: string[];
    try {
      entries = readdirSync(sessionStateDir);
    } catch {
      return; // directory may not exist yet
    }

    const cutoff = Date.now() - SEVEN_DAYS_MS;
    let pruned = 0;

    for (const entry of entries) {
      const fullPath = join(sessionStateDir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          rmSync(fullPath, { recursive: true, force: true });
          pruned++;
        }
      } catch {
        // skip entries we can't stat or remove
      }
    }

    if (pruned > 0) {
      console.log(`[max] Pruned ${pruned} orphaned session folder(s)`);
    }
  } catch (err) {
    console.error("[max] Session pruning failed (non-fatal):", err instanceof Error ? err.message : err);
  }
}

async function main(): Promise<void> {
  console.log("[max] Starting Max daemon...");
  if (config.selfEditEnabled) {
    console.log("[max] ⚠ Self-edit mode enabled — Max can modify his own source code");
  }

  // Set up logging
  console.log("[max] Message logger ready");

  // Initialize SQLite
  getDb();
  console.log("[max] Database initialized");

  // Initialize wiki knowledge base
  const wikiIsNew = ensureWikiStructure();
  if (wikiIsNew) {
    console.log("[max] Created wiki at ~/.max/wiki/");
  }
  if (shouldMigrate()) {
    console.log("[max] Migrating SQLite memories to wiki...");
    const count = migrateMemoriesToWiki();
    console.log(`[max] Migrated ${count} memories to wiki`);
  }
  if (shouldReorganize()) {
    console.log("[max] Reorganizing wiki pages into entity structure...");
    const count = reorganizeWiki();
    console.log(`[max] Created ${count} entity pages`);
  }

  // Prune orphaned session folders older than 7 days
  pruneOldSessions();

  // Kill any stale copilot process on our port (from a previous run)
  await killStaleCopilotOnPort(config.copilotUiServerPort);

  // Start Copilot CLI in --ui-server mode
  console.log("[max] Starting Copilot CLI (--ui-server)...");
  cliProcess = new CLIProcess({
    port: config.copilotUiServerPort,
  });
  await cliProcess.start();
  console.log("[max] Copilot CLI ready on port", config.copilotUiServerPort);

  // Start Copilot SDK client (connects to --ui-server)
  console.log("[max] Starting Copilot SDK client...");
  await getClient(config.copilotUiServerPort);
  console.log("[max] Copilot SDK client ready");

  // Create unified message handler — all channels (Feishu, TUI, Telegram)
  // share the same session-per-channel pass-through model.
  messageHandler = new MessageHandler({
    port: config.copilotUiServerPort,
    cliProcess,
    async getSessionForChannel(channelId: string) {
      const wsName = getActiveWorkspace(channelId);
      const wsRow = getWorkspace(wsName);
      const workingDir = wsRow?.working_dir;
      const session = await getOrCreateSession(wsName, config.copilotUiServerPort, {
        workingDirectory: workingDir,
        model: config.copilotModel,
      });
      return { session, workspaceName: wsName, workingDir };
    },
  });
  console.log("[max] Message handler ready (pass-through mode)");

  // Capture for closures (TS doesn't narrow module-level variables through closures)
  const handler = messageHandler;

  // Wire up to API server (same pass-through flow as Feishu)
  const { setMessageHandler, setCancelChannel } = await import("./api/server.js");
  setMessageHandler(handler);
  setCancelChannel((channelId: string) => handler.cancelChannel(channelId));

  // Start HTTP API for TUI
  await startApiServer();

  // Start Telegram bot (if configured)
  if (config.telegramEnabled) {
    createBot(handler);
    await startBot();
  } else if (!config.telegramBotToken && config.authorizedUserId === undefined) {
    console.log("[max] Telegram not configured — skipping bot. Run 'max setup' to configure.");
  } else if (!config.telegramBotToken) {
    console.log("[max] Telegram bot token missing — skipping bot. Run 'max setup' and enter your bot token.");
  } else {
    console.log("[max] Telegram user ID missing — skipping bot. Run 'max setup' and enter your Telegram user ID (get it from @userinfobot).");
  }

  // Start Feishu bot (if configured)
  if (config.feishuEnabled) {
    createFeishuBot(messageHandler);
    await startFeishuBot();
  } else if (!config.feishuAppId && !config.feishuAppSecret && !config.feishuAuthorizedOpenId) {
    console.log("[max] Feishu not configured — skipping bot. Run 'max setup' to configure.");
  } else {
    console.log("[max] Feishu config incomplete — skipping bot. Run 'max setup' and provide App ID, App Secret, and authorized open_id.");
  }

  console.log("[max] Max is fully operational.");

  // Non-blocking update check
  checkForUpdate()
    .then(({ updateAvailable, current, latest }) => {
      if (updateAvailable) {
        console.log(`[max] ⬆ Update available: v${current} → v${latest}  —  run 'max update' to install`);
      }
    })
    .catch(() => {});  // silent — network may be unavailable

  // Notify user if this is a restart (not a fresh start)
  if (process.env.MAX_RESTARTED === "1") {
    if (config.telegramEnabled) {
      await sendProactiveMessage("I'm back online 🟢").catch(() => {});
    }
    if (config.feishuEnabled) {
      await sendFeishuProactiveMessage("I'm back online 🟢").catch(() => {});
    }
    delete process.env.MAX_RESTARTED;
  }
}

// Graceful shutdown
let shutdownState: "idle" | "warned" | "shutting_down" = "idle";
async function shutdown(): Promise<void> {
  if (shutdownState === "shutting_down") {
    console.log("\n[max] Forced exit.");
    process.exit(1);
  }

  // Check for running workers before shutting down (pass-through mode — no workers)

  shutdownState = "shutting_down";
  console.log("\n[max] Shutting down... (Ctrl+C again to force)");

  // Force exit after 3 seconds no matter what
  const forceTimer = setTimeout(() => {
    console.log("[max] Shutdown timed out — forcing exit.");
    process.exit(1);
  }, 3000);
  forceTimer.unref();

  if (config.telegramEnabled) {
    try { await stopBot(); } catch { /* best effort */ }
  }
  if (config.feishuEnabled) {
    try { await stopFeishuBot(); } catch { /* best effort */ }
  }

  messageHandler?.cancelAll();
  try { await cliProcess?.stop(); } catch { /* best effort */ }
  try { await stopClient(); } catch { /* best effort */ }
  closeDb();
  console.log("[max] Goodbye.");
  process.exit(0);
}

/** Restart the daemon by spawning a new process and exiting. */
export async function restartDaemon(): Promise<void> {
  console.log("[max] Restarting...");

  if (config.telegramEnabled) {
    await sendProactiveMessage("Restarting — back in a sec ⏳").catch(() => {});
    try { await stopBot(); } catch { /* best effort */ }
  }
  if (config.feishuEnabled) {
    await sendFeishuProactiveMessage("Restarting — back in a sec ⏳").catch(() => {});
    try { await stopFeishuBot(); } catch { /* best effort */ }
  }

  // Cancel all in-flight message processing
  messageHandler?.cancelAll();

  try { await cliProcess?.stop(); } catch { /* best effort */ }
  try { await stopClient(); } catch { /* best effort */ }
  closeDb();

  // Spawn a detached replacement process with the same args (include execArgv for tsx/loaders)
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    detached: true,
    stdio: "inherit",
    env: { ...process.env, MAX_RESTARTED: "1" },
  });
  child.unref();

  console.log("[max] New process spawned. Exiting old process.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Prevent unhandled errors from crashing the daemon
process.on("unhandledRejection", (reason) => {
  console.error("[max] Unhandled rejection (kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[max] Uncaught exception — shutting down:", err);
  process.exit(1);
});

main().catch((err) => {
  console.error("[max] Fatal error:", err);
  process.exit(1);
});
