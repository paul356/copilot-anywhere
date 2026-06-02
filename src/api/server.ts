import express from "express";
import type { Request, Response, NextFunction } from "express";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomBytes } from "crypto";
import { sendPhoto } from "../telegram/bot.js";
import { config, persistModel } from "../config.js";
import { searchIndex, parseIndex } from "../wiki/index-manager.js";
import { readPage, ensureWikiStructure } from "../wiki/fs.js";
import { restartDaemon } from "../daemon.js";
import { API_TOKEN_PATH, ensureMaxHome } from "../paths.js";

import { MessageHandler } from "../message-handler.js";
import { route } from "../command-router.js";

// Set by daemon.ts at startup
let _messageHandler: MessageHandler | undefined;
type CancelFn = (channelId: string) => void;
let _cancelChannel: CancelFn | undefined;

export function setMessageHandler(mh: MessageHandler): void { _messageHandler = mh; }
export function setCancelChannel(fn: CancelFn): void { _cancelChannel = fn; }

// Ensure token file exists (generate on first run)
let apiToken: string | null = null;
try {
  if (existsSync(API_TOKEN_PATH)) {
    apiToken = readFileSync(API_TOKEN_PATH, "utf-8").trim();
  } else {
    ensureMaxHome();
    apiToken = randomBytes(32).toString("hex");
    writeFileSync(API_TOKEN_PATH, apiToken, { mode: 0o600 });
  }
} catch (err) {
  console.error(`[auth] Failed to load/generate API token: ${err}`);
  process.exit(1);
}

const app = express();
app.use(express.json());

// Bearer token authentication middleware (skip /status health check)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!apiToken || req.path === "/status") return next();
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${apiToken}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// Active SSE connections
const sseClients = new Map<string, Response>();
let connectionCounter = 0;

// Health check — intentionally unauthenticated, returns no sensitive data
app.get("/status", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    workers: [], // pass-through mode — no agent workers
  });
});

// List agents (pass-through mode — no agents, always empty)
app.get("/agents", (_req: Request, res: Response) => {
  res.json([]);
});

// Keep /sessions as an alias for backwards compat
app.get("/sessions", (_req: Request, res: Response) => {
  res.json([]);
});

// SSE stream for real-time responses
app.get("/stream", (req: Request, res: Response) => {
  const connectionId = `tui-${++connectionCounter}`;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "connected", connectionId })}\n\n`);

  sseClients.set(connectionId, res);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`:ping\n\n`);
  }, 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(connectionId);
  });
});

// Send a message to Copilot (same pass-through flow as Feishu)
app.post("/message", (req: Request, res: Response) => {
  const { prompt, connectionId } = req.body as { prompt?: string; connectionId?: string };

  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "Missing 'prompt' in request body" });
    return;
  }

  if (!connectionId || !sseClients.has(connectionId)) {
    res.status(400).json({ error: "Missing or invalid 'connectionId'. Connect to /stream first." });
    return;
  }

  if (!_messageHandler) {
    res.status(503).json({ error: "Message handler not ready yet" });
    return;
  }

  const channelKey = `tui:${connectionId}`;
  const result = route(prompt, { senderId: channelKey, channelKey });

  _messageHandler.handle(result, channelKey, (text: string, done: boolean) => {
    const sseRes = sseClients.get(connectionId);
    if (!sseRes) return;

    // User-input questions (ask_user) arrive as JSON — emit them directly
    // as their native event type so the TUI renders them properly.
    if (text.startsWith('{"type":"question"')) {
      sseRes.write(`data: ${text}\n\n`);
      return;
    }

    sseRes.write(
      `data: ${JSON.stringify({ type: done ? "message" : "delta", content: text })}\n\n`
    );
  });

  res.json({ status: "queued" });
});

// Cancel the current in-flight message for a specific TUI connection.
app.post("/cancel", async (req: Request, res: Response) => {
  const { connectionId } = req.body as { connectionId?: string };

  if (!connectionId || !sseClients.has(connectionId)) {
    res.status(400).json({ error: "Missing or invalid 'connectionId'. Connect to /stream first." });
    return;
  }

  if (_cancelChannel) {
    _cancelChannel(`tui:${connectionId}`);
  }
  const sseRes = sseClients.get(connectionId);
  if (sseRes) {
    sseRes.write(
      `data: ${JSON.stringify({ type: "cancelled" })}\n\n`
    );
  }
  res.json({ status: "ok", cancelled: true });
});

// Answer a pending ask_user question from the LLM.
app.post("/answer", (req: Request, res: Response) => {
  const { connectionId, answer } = req.body as { connectionId?: string; answer?: string };

  if (!connectionId || typeof answer !== "string") {
    res.status(400).json({ error: "Missing or invalid 'connectionId' / 'answer'" });
    return;
  }

  if (!sseClients.has(connectionId)) {
    res.status(400).json({ error: "Invalid 'connectionId'. Connect to /stream first." });
    return;
  }

  if (!_messageHandler) {
    res.status(503).json({ error: "Message handler not ready yet" });
    return;
  }

  const ok = _messageHandler.answerUserInput(`tui:${connectionId}`, answer);
  res.json({ ok });
});

// Get or switch model
app.get("/model", (_req: Request, res: Response) => {
  res.json({ model: config.copilotModel });
});
app.post("/model", async (req: Request, res: Response) => {
  const { model } = req.body as { model?: string };
  if (!model || typeof model !== "string") {
    res.status(400).json({ error: "Missing 'model' in request body" });
    return;
  }
  // Validate against available models before persisting
  try {
    const { getClient } = await import("../copilot/client.js");
    const client = await getClient();
    const models = await client.listModels();
    const match = models.find((m) => m.id === model);
    if (!match) {
      const suggestions = models
        .filter((m) => m.id.includes(model) || m.id.toLowerCase().includes(model.toLowerCase()))
        .map((m) => m.id);
      const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
      res.status(400).json({ error: `Model '${model}' not found.${hint}` });
      return;
    }
  } catch {
    // If we can't validate (client not ready), allow the switch — it'll fail on next message if wrong
  }
  const previous = config.copilotModel;
  config.copilotModel = model;
  persistModel(model);
  res.json({ previous, current: model });
});

// List all available models
app.get("/models", async (_req: Request, res: Response) => {
  try {
    const { getClient } = await import("../copilot/client.js");
    const client = await getClient();
    const models = await client.listModels();
    res.json({ models: models.map((m) => m.id), current: config.copilotModel });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to list models: ${msg}` });
  }
});

// List wiki knowledge
app.get("/memory", (_req: Request, res: Response) => {
  ensureWikiStructure();
  const entries = parseIndex();
  const results = entries.map((e) => ({
    path: e.path,
    title: e.title,
    summary: e.summary,
    tags: e.tags || [],
    updated: e.updated || "",
  }));
  res.json(results);
});

// Restart daemon
app.post("/restart", (_req: Request, res: Response) => {
  res.json({ status: "restarting" });
  setTimeout(() => {
    restartDaemon().catch((err) => {
      console.error("[max] Restart failed:", err);
    });
  }, 500);
});

// Send a photo to Telegram
app.post("/send-photo", async (req: Request, res: Response) => {
  const { photo, caption } = req.body as { photo?: string; caption?: string };

  if (!photo || typeof photo !== "string") {
    res.status(400).json({ error: "Missing 'photo' (file path or URL) in request body" });
    return;
  }

  // Restrict local file paths to the system temp directory to prevent arbitrary file exfiltration
  if (!photo.startsWith("http://") && !photo.startsWith("https://")) {
    const { resolve } = await import("path");
    const { tmpdir } = await import("os");
    const resolvedPhoto = resolve(photo);
    const allowedBase = resolve(tmpdir());
    if (!resolvedPhoto.startsWith(allowedBase + "/") && resolvedPhoto !== allowedBase) {
      res.status(403).json({ error: "Local file paths must be within the system temp directory. Use a URL or save the file to the temp dir first." });
      return;
    }
  }

  try {
    await sendPhoto(photo, caption);
    res.json({ status: "sent" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export function startApiServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.apiPort, "127.0.0.1", () => {
      console.log(`[max] HTTP API listening on http://127.0.0.1:${config.apiPort}`);
      resolve();
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${config.apiPort} is already in use. Is another Max instance running?`));
      } else {
        reject(err);
      }
    });
  });
}

/** Broadcast a proactive message to all connected SSE clients (for background task completions). */
export function broadcastToSSE(text: string): void {
  for (const [, res] of sseClients) {
    res.write(
      `data: ${JSON.stringify({ type: "message", content: text })}\n\n`
    );
  }
}

export function sendToSSEConnection(connectionId: string, text: string): void {
  const res = sseClients.get(connectionId);
  if (!res) return;
  res.write(
    `data: ${JSON.stringify({ type: "message", content: text })}\n\n`
  );
}
