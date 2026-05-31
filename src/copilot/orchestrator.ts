import { AsyncLocalStorage } from "async_hooks";
import { approveAll, type CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { createTools, type ToolDeps } from "./tools.js";
import { getOrchestratorSystemMessage } from "./system-message.js";
import { config, DEFAULT_MODEL } from "../config.js";
import { getProviderConfig } from "../copilot-client.js";
import { loadMcpConfig } from "./mcp-config.js";
import { getSkillDirectories } from "./skills.js";
import { resetClient } from "./client.js";
import {
  logConversation, getState, setState, deleteState,
  getWorkspace, getActiveWorkspace,
  saveWorkspaceSessionId, clearWorkspaceSessionId,
} from "../store/db.js";
import { getWikiSummary } from "../wiki/context.js";
import { SESSIONS_DIR } from "../paths.js";
import { resolveModel, type Tier, type RouteResult } from "./router.js";
import {
  loadAgents, ensureDefaultAgents,
  clearActiveTasks, getAgentRegistry,
  setActiveAgent, parseAtMention, buildAgentRoster,
  getActiveTasks,
} from "./agents.js";


/**
 * Permission handler for the orchestrator session.
 * Approves all tool requests so @max has full access to all tools.
 */
const orchestratorPermissionHandler = approveAll;

const MAX_RETRIES = 3;
const RECONNECT_DELAYS_MS = [1_000, 3_000, 10_000];
const HEALTH_CHECK_INTERVAL_MS = 30_000;

// Legacy DB key — migrated to "session:default" on first run after upgrade
const LEGACY_SESSION_KEY = "orchestrator_session_id";

export type SourceChannel = "telegram" | "tui" | "feishu";

export type MessageSource =
  | { type: "telegram"; chatId: number; messageId: number }
  | { type: "tui"; connectionId: string }
  | { type: "feishu"; chatId: string; messageId: string; openId: string }
  | { type: "background" };

export type MessageCallback = (text: string, done: boolean) => void;

// ---------------------------------------------------------------------------
// Async context — tracks per-request source info across async tool call chains
// ---------------------------------------------------------------------------
type RequestContext = { sourceKey: string | undefined; sourceChannel: SourceChannel | undefined };
const requestContext = new AsyncLocalStorage<RequestContext>();

export function getCurrentSourceKey(): string | undefined {
  return requestContext.getStore()?.sourceKey;
}

export function getCurrentSourceChannel(): SourceChannel | undefined {
  return requestContext.getStore()?.sourceChannel;
}

// ---------------------------------------------------------------------------
// Per-workspace state
// ---------------------------------------------------------------------------
type QueuedMessage = {
  prompt: string;
  attachments?: Array<{ type: "file"; path: string; displayName?: string }>;
  callback: MessageCallback;
  sourceChannel?: SourceChannel;
  /** Target agent slug for @mention routing. If undefined, goes to orchestrator. */
  targetAgent?: string;
  /** Conversation channel key for sticky routing, e.g. "telegram:123" or "tui:conn-1". */
  channelKey?: string;
  resolve: (value: string) => void;
  reject: (err: unknown) => void;
};

type WorkspaceState = {
  session?: CopilotSession;
  createPromise?: Promise<CopilotSession>;
  queue: QueuedMessage[];
  processing: boolean;
  currentModel?: string;
  recentTiers: Tier[];
  lastRouteResult?: RouteResult;
  currentCallback?: MessageCallback;
  /** The channelKey currently being executed — used for targeted cancel/abort. */
  currentSourceKey?: string;
};

const workspacePool = new Map<string, WorkspaceState>();

function getOrCreateWorkspace(name: string): WorkspaceState {
  let ws = workspacePool.get(name);
  if (!ws) {
    ws = { queue: [], processing: false, recentTiers: [] };
    workspacePool.set(name, ws);
  }
  return ws;
}

// ---------------------------------------------------------------------------
// Logging / notification callbacks
// ---------------------------------------------------------------------------
type LogFn = (direction: "in" | "out", source: string, text: string) => void;
let logMessage: LogFn = () => {};

export function setMessageLogger(fn: LogFn): void {
  logMessage = fn;
}

// Proactive notification — sends unsolicited messages to the user on a specific destination.
type ProactiveNotifyFn = (text: string, destination?: string) => void;
let proactiveNotifyFn: ProactiveNotifyFn | undefined;

export function setProactiveNotify(fn: ProactiveNotifyFn): void {
  proactiveNotifyFn = fn;
}

let copilotClient: CopilotClient | undefined;
let healthCheckTimer: ReturnType<typeof setInterval> | undefined;

// Global "last route result" — updated by any workspace, used for model indicator display
let lastRouteResult: RouteResult | undefined;

export function getLastRouteResult(): RouteResult | undefined {
  return lastRouteResult;
}

function getSourceKey(source: MessageSource): string | undefined {
  switch (source.type) {
    case "telegram":
      return `telegram:${source.chatId}`;
    case "tui":
      return `tui:${source.connectionId}`;
    case "feishu":
      return `feishu:${source.chatId}`;
    default:
      return undefined;
  }
}

function getSessionConfig() {
  const tools = createTools({
    client: copilotClient!,
    onAgentTaskComplete: feedAgentResult,
  });
  const mcpServers = loadMcpConfig();
  const skillDirectories = getSkillDirectories();
  return { tools, mcpServers, skillDirectories };
}

/** Feed an agent task result into the orchestrator as a new turn. */
export function feedAgentResult(taskId: string, agentSlug: string, result: string): void {
  const prompt = `[Agent task completed] @${agentSlug} finished task ${taskId}:\n\n${result}`;
  sendToOrchestrator(
    prompt,
    { type: "background" },
    (_text, done) => {
      if (done && proactiveNotifyFn) {
        // Route notification to the task's origin channel
        const tasks = getActiveTasks();
        const task = tasks.find((t) => t.taskId === taskId);
        proactiveNotifyFn(_text, task?.originChannel);
      }
    }
  );
}

/**
 * Return the working directory configured for the active workspace of a channel.
 * Returns undefined for the "default" workspace (uses daemon cwd).
 */
export function getWorkingDirForSourceKey(channelKey: string | undefined): string | undefined {
  if (!channelKey) return undefined;
  const wsName = getActiveWorkspace(channelKey);
  if (wsName === "default") return undefined;
  return getWorkspace(wsName)?.working_dir;
}

/** Drop the in-memory session for a workspace so the next message triggers a fresh resume. */
export function resetWorkspaceSession(wsName: string): void {
  const ws = workspacePool.get(wsName);
  if (ws) {
    ws.session = undefined;
    ws.currentModel = undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ensure the SDK client is connected, resetting if necessary. Coalesces concurrent resets. */
let resetPromise: Promise<CopilotClient> | undefined;
async function ensureClient(): Promise<CopilotClient> {
  if (copilotClient && copilotClient.getState() === "connected") {
    return copilotClient;
  }
  if (!resetPromise) {
    console.log(`[max] Client not connected (state: ${copilotClient?.getState() ?? "null"}), resetting…`);
    resetPromise = resetClient().then((c) => {
      console.log(`[max] Client reset successful, state: ${c.getState()}`);
      copilotClient = c;
      return c;
    }).finally(() => { resetPromise = undefined; });
  }
  return resetPromise;
}

/** Start periodic health check that proactively reconnects the client. */
function startHealthCheck(): void {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(async () => {
    if (!copilotClient) return;
    try {
      const state = copilotClient.getState();
      if (state !== "connected") {
        console.log(`[max] Health check: client state is '${state}', resetting…`);
        await ensureClient();
        // Clear all workspace sessions — they'll be recreated on next use
        for (const ws of workspacePool.values()) {
          ws.session = undefined;
          ws.currentModel = undefined;
        }
      }
    } catch (err) {
      console.error(`[max] Health check error:`, err instanceof Error ? err.message : err);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

function sessionDbKey(wsName: string): string {
  return `session:${wsName}`;
}

/** Internal: create or resume a workspace session (not concurrency-safe — use ensureWorkspaceSession). */
async function createOrResumeWorkspaceSession(wsName: string, workingDir?: string): Promise<CopilotSession> {
  const client = await ensureClient();
  const { tools, mcpServers, skillDirectories } = getSessionConfig();
  const memorySummary = getWikiSummary();
  const ws = getOrCreateWorkspace(wsName);

  const infiniteSessions = {
    enabled: true,
    backgroundCompactionThreshold: 0.80,
    bufferExhaustionThreshold: 0.95,
  };

  // Resolve saved session ID: new key first, then legacy key (default workspace only)
  const dbKey = sessionDbKey(wsName);
  let savedSessionId = getState(dbKey);

  if (!savedSessionId && wsName === "default") {
    const legacyId = getState(LEGACY_SESSION_KEY);
    if (legacyId) {
      savedSessionId = legacyId;
      setState(dbKey, legacyId);
      deleteState(LEGACY_SESSION_KEY);
      console.log(`[max] Migrated legacy session key to '${dbKey}'`);
    }
  }

  // Named workspaces also store session ID in worker_sessions table
  if (!savedSessionId && wsName !== "default") {
    const row = getWorkspace(wsName);
    if (row?.copilot_session_id) {
      savedSessionId = row.copilot_session_id;
    }
  }

  // Resolve configDir: use per-session override if set (e.g. attached VS Code session)
  const savedConfigDir = getState(`configDir:${wsName}`)
    ?? (wsName !== "default" ? getWorkspace(wsName)?.config_dir ?? null : null)
    ?? null;
  const resolvedConfigDir = savedConfigDir ?? SESSIONS_DIR;

  const sessionParams = {
    model: ws.currentModel || config.copilotModel,
    configDir: resolvedConfigDir,
    streaming: true,
    ...(workingDir ? { workingDirectory: workingDir } : {}),
    systemMessage: {
      content: getOrchestratorSystemMessage({
        selfEditEnabled: config.selfEditEnabled,
        memorySummary: memorySummary || undefined,
        agentRoster: buildAgentRoster(),
      }),
    },
    tools,
    mcpServers,
    skillDirectories,
    onPermissionRequest: orchestratorPermissionHandler,
    infiniteSessions,
  };

  const providerConfig = getProviderConfig();
  if (providerConfig) {
    (sessionParams as Record<string, unknown>).provider = providerConfig;
  }

  if (savedSessionId) {
    try {
      console.log(`[max] Resuming session for workspace '${wsName}' (${savedSessionId.slice(0, 8)}…, configDir: ${resolvedConfigDir})`);
      const session = await client.resumeSession(savedSessionId, sessionParams);
      console.log(`[max] Resumed workspace '${wsName}' session`);
      deleteState(`${dbKey}:backup`);
      ws.currentModel = ws.currentModel || config.copilotModel;
      return session;
    } catch (err) {
      console.log(`[max] Could not resume '${wsName}' session: ${err instanceof Error ? err.message : err}.`);
      deleteState(`configDir:${wsName}`);
      if (wsName !== "default") clearWorkspaceSessionId(wsName);
      // Restore previous session if this was a failed attach attempt
      const backupId = getState(`${dbKey}:backup`);
      if (backupId) {
        setState(dbKey, backupId);
        deleteState(`${dbKey}:backup`);
        console.log(`[max] Restored previous session for workspace '${wsName}' (${backupId.slice(0, 8)}…)`);
      } else {
        deleteState(dbKey);
      }
      // Don't throw — fall through to create a new session below
    }
  }

  console.log(`[max] Creating new session for workspace '${wsName}'${workingDir ? ` (dir: ${workingDir})` : ""}`);
  const session = await client.createSession(sessionParams);
  setState(dbKey, session.sessionId);
  if (wsName !== "default") saveWorkspaceSessionId(wsName, session.sessionId);
  console.log(`[max] Created workspace '${wsName}' session ${session.sessionId.slice(0, 8)}…`);
  ws.currentModel = ws.currentModel || config.copilotModel;
  return session;
}

/** Ensure a workspace has an active session, coalescing concurrent callers. */
async function ensureWorkspaceSession(wsName: string, workingDir?: string): Promise<CopilotSession> {
  const ws = getOrCreateWorkspace(wsName);
  if (ws.session) return ws.session;
  if (ws.createPromise) return ws.createPromise;

  ws.createPromise = createOrResumeWorkspaceSession(wsName, workingDir);
  try {
    const session = await ws.createPromise;
    ws.session = session;
    return session;
  } finally {
    ws.createPromise = undefined;
  }
}

export async function initOrchestrator(client: CopilotClient): Promise<void> {
  copilotClient = client;
  const { mcpServers, skillDirectories } = getSessionConfig();

  // Initialize agent system
  ensureDefaultAgents();
  const agents = loadAgents();
  console.log(`[max] Loaded ${agents.length} agent(s): ${agents.map((a) => `@${a.slug}`).join(", ") || "(none)"}`);

  // Validate configured model against available models
  // Skip validation if using a custom provider (BYOK) — the model list
  // only contains official Copilot models, not custom provider ones.
  try {
    const models = await client.listModels();
    const configured = config.copilotModel;
    const isCustomProvider = !!process.env.COPILOT_PROVIDER_TYPE && !!process.env.COPILOT_PROVIDER_API_KEY;
    
    if (!isCustomProvider && !models.some((m) => m.id === configured)) {
      console.log(`[max] ⚠️ Configured model '${configured}' is not available. Falling back to '${DEFAULT_MODEL}'.`);
      config.copilotModel = DEFAULT_MODEL;
    }
  } catch (err) {
    console.log(`[max] Could not validate model (will use '${config.copilotModel}' as-is): ${err instanceof Error ? err.message : err}`);
  }

  console.log(`[max] Loading ${Object.keys(mcpServers).length} MCP server(s): ${Object.keys(mcpServers).join(", ") || "(none)"}`);
  console.log(`[max] Skill directories: ${skillDirectories.join(", ") || "(none)"}`);
  console.log(`[max] Persistent session mode — conversation history maintained by SDK`);
  startHealthCheck();

  // Skip eager session creation — sessions are created on-demand by
  // message-handler (Feishu) or per-channel as messages arrive (Telegram/TUI).
  // The orchestrator's own session path is kept for backward compat but not
  // eagerly initialized at startup.
}

/** How long to wait for the orchestrator to finish a turn (10 min). */
const ORCHESTRATOR_TIMEOUT_MS = 600_000;

/** Send a prompt on a workspace session, return the response. */
async function executeOnWorkspaceSession(
  wsName: string,
  workingDir: string | undefined,
  prompt: string,
  callback: MessageCallback,
  attachments?: Array<{ type: "file"; path: string; displayName?: string }>
): Promise<string> {
  const ws = getOrCreateWorkspace(wsName);
  const session = await ensureWorkspaceSession(wsName, workingDir);
  ws.currentCallback = callback;

  let accumulated = "";
  let toolCallExecuted = false;
  let toolCallCount = 0;
  const unsubToolDone = session.on("tool.execution_complete", () => {
    toolCallExecuted = true;
    toolCallCount++;
  });
  const unsubDelta = session.on("assistant.message_delta", (event) => {
    // After a tool call completes, ensure a line break separates the text blocks
    // so they don't visually run together in the TUI.
    if (toolCallExecuted && accumulated.length > 0 && !accumulated.endsWith("\n")) {
      accumulated += "\n";
    }
    toolCallExecuted = false;
    accumulated += event.data.deltaContent;
    callback(accumulated, false);
  });

  try {
    const result = await session.sendAndWait(
      { prompt, ...(attachments && attachments.length > 0 ? { attachments } : {}) },
      ORCHESTRATOR_TIMEOUT_MS
    );
    const finalContent = result?.data?.content || accumulated || "(No response)";
    return finalContent;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // On timeout, never throw — the message was already sent to the persistent
    // session and may have been (partially) processed. Return what we have.
    if (/timeout/i.test(msg)) {
      if (accumulated.length > 0) {
        console.log(`[max] Timeout after ${ORCHESTRATOR_TIMEOUT_MS / 1000}s but have ${accumulated.length} chars — returning partial response`);
        return accumulated;
      }
      if (toolCallCount > 0) {
        console.log(`[max] Timeout after ${ORCHESTRATOR_TIMEOUT_MS / 1000}s — ${toolCallCount} tool call(s) executed but no text yet. Session is still working.`);
        return "I'm still working on this — I've started processing but it's taking longer than expected. I'll send you the results when I'm done.";
      }
      console.log(`[max] Timeout after ${ORCHESTRATOR_TIMEOUT_MS / 1000}s with no activity. Session may be stuck.`);
      return "Sorry, that request timed out before I could start working on it. Try again or break it into smaller pieces?";
    }

    // If the session is broken, invalidate it so it's recreated on next attempt
    if (/closed|destroy|disposed|invalid|expired|not found/i.test(msg)) {
      console.log(`[max] Session '${wsName}' appears dead, will recreate: ${msg}`);
      ws.session = undefined;
      ws.currentModel = undefined;
      deleteState(sessionDbKey(wsName));
      if (wsName !== "default") clearWorkspaceSessionId(wsName);
    }
    throw err;
  } finally {
    unsubDelta();
    unsubToolDone();
    ws.currentCallback = undefined;
  }
}

/** Process the message queue for a workspace one at a time. */
async function processWorkspaceQueue(wsName: string, workingDir?: string): Promise<void> {
  const ws = getOrCreateWorkspace(wsName);
  if (ws.processing) {
    if (ws.queue.length > 0) {
      console.log(`[max] Message queued for workspace '${wsName}' (${ws.queue.length} waiting)`);
    }
    return;
  }
  ws.processing = true;

  while (ws.queue.length > 0) {
    const item = ws.queue.shift()!;
    ws.currentSourceKey = item.channelKey;
    const ctx: RequestContext = { sourceKey: item.channelKey, sourceChannel: item.sourceChannel };
    try {
      const result = await requestContext.run(ctx, async (): Promise<string> => {
        if (item.targetAgent && item.targetAgent !== "max") {
          // @mention switches the active agent — route through the workspace session
          setActiveAgent(item.channelKey || "default", item.targetAgent);
          return executeOnWorkspaceSession(wsName, workingDir, item.prompt, item.callback, item.attachments);
        }

        // Route the model before executing
        const routeResult = await resolveModel(item.prompt, ws.currentModel || config.copilotModel, ws.recentTiers);
        if (routeResult.switched) {
          console.log(`[max] Auto: switching to ${routeResult.model} (${routeResult.overrideName || routeResult.tier}) in workspace '${wsName}'`);
          config.copilotModel = routeResult.model;
          if (ws.session) {
            try {
              await ws.session.setModel(routeResult.model);
              ws.currentModel = routeResult.model;
              console.log(`[max] Model switched in-place for workspace '${wsName}'`);
            } catch (err) {
              console.log(`[max] setModel() failed for '${wsName}', will recreate: ${err instanceof Error ? err.message : err}`);
              ws.session = undefined;
              deleteState(sessionDbKey(wsName));
              if (wsName !== "default") clearWorkspaceSessionId(wsName);
            }
          }
        }
        if (routeResult.tier) {
          ws.recentTiers.push(routeResult.tier);
          if (ws.recentTiers.length > 5) ws.recentTiers = ws.recentTiers.slice(-5);
        }
        ws.lastRouteResult = routeResult;
        lastRouteResult = routeResult;

        return executeOnWorkspaceSession(wsName, workingDir, item.prompt, item.callback, item.attachments);
      });
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    }
    ws.currentSourceKey = undefined;
  }

  ws.processing = false;
}

function isRecoverableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Timeouts are NOT retryable on a persistent session — the message was already
  // sent and likely processed; re-sending creates "duplicate" responses.
  if (/timeout/i.test(msg)) return false;
  return /disconnect|connection|EPIPE|ECONNRESET|ECONNREFUSED|socket|closed|ENOENT|spawn|not found|expired|stale/i.test(msg);
}

export async function sendToOrchestrator(
  prompt: string,
  source: MessageSource,
  callback: MessageCallback,
  attachments?: Array<{ type: "file"; path: string; displayName?: string }>
): Promise<void> {
  const sourceLabel =
    source.type === "telegram" ? "telegram" :
    source.type === "tui" ? "tui" :
    source.type === "feishu" ? "feishu" : "background";
  logMessage("in", sourceLabel, prompt);

  // Parse @mention routing (e.g., "@coder fix the bug" → target "coder")
  const mention = parseAtMention(prompt);
  const targetAgent = mention?.agentSlug;
  const routedPrompt = mention ? mention.message : prompt;

  // Tag the prompt with its source channel
  const taggedPrompt = source.type === "background"
    ? routedPrompt
    : `[via ${sourceLabel}] ${routedPrompt}`;

  // Log role: background events are "system", user messages are "user"
  const logRole = source.type === "background" ? "system" : "user";

  // Determine the source channel for agent origin tracking
  const sourceChannel: SourceChannel | undefined =
    source.type === "telegram" ? "telegram" :
    source.type === "tui" ? "tui" :
    source.type === "feishu" ? "feishu" : undefined;
  const channelKey = getSourceKey(source);

  // Resolve workspace for this channel
  const wsName = channelKey ? getActiveWorkspace(channelKey) : "default";
  const workingDir = wsName !== "default" ? getWorkspace(wsName)?.working_dir : undefined;

  // Enqueue and process
  void (async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const finalContent = await new Promise<string>((resolve, reject) => {
          const ws = getOrCreateWorkspace(wsName);
          ws.queue.push({ prompt: taggedPrompt, attachments, callback, sourceChannel, targetAgent, channelKey, resolve, reject });
          processWorkspaceQueue(wsName, workingDir);
        });
        // Deliver response to user FIRST, then log best-effort
        callback(finalContent, true);
        try { logMessage("out", sourceLabel, finalContent); } catch { /* best-effort */ }
        // Log both sides of the conversation after delivery
        try { logConversation(logRole, prompt, sourceLabel); } catch { /* best-effort */ }
        try { logConversation("assistant", finalContent, sourceLabel); } catch { /* best-effort */ }
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // Don't retry cancelled messages
        if (/cancelled|abort/i.test(msg)) {
          return;
        }

        if (isRecoverableError(err) && attempt < MAX_RETRIES) {
          const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
          console.error(`[max] Recoverable error: ${msg}. Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms…`);
          await sleep(delay);
          // Reset client before retry in case the connection is stale
          try { await ensureClient(); } catch { /* will fail again on next attempt */ }
          continue;
        }

        console.error(`[max] Error processing message: ${msg}`);
        callback(`Error: ${msg}`, true);
        return;
      }
    }
  })();
}

/** Cancel the in-flight message and queued work for a specific source when provided. */
export async function cancelCurrentMessage(sourceKey?: string): Promise<boolean> {
  let drained = 0;

  // Drain matching queued messages from all workspaces
  for (const ws of workspacePool.values()) {
    for (let i = ws.queue.length - 1; i >= 0; i--) {
      const item = ws.queue[i];
      if (sourceKey && item.channelKey !== sourceKey) continue;
      ws.queue.splice(i, 1);
      item.reject(new Error("Cancelled"));
      drained++;
    }
  }

  // Abort the in-flight request in the matching workspace
  for (const ws of workspacePool.values()) {
    if (ws.session && ws.currentCallback && (!sourceKey || ws.currentSourceKey === sourceKey)) {
      try {
        await ws.session.abort();
        console.log(`[max] Aborted in-flight request`);
        return true;
      } catch (err) {
        console.error(`[max] Abort failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  return drained > 0;
}

/** Switch the model on the live session for the current async context's workspace. */
export function switchSessionModel(newModel: string): Promise<void> {
  const channelKey = requestContext.getStore()?.sourceKey;
  const wsName = channelKey ? getActiveWorkspace(channelKey) : "default";
  const ws = workspacePool.get(wsName);
  if (ws?.session) {
    return ws.session.setModel(newModel).then(() => {
      ws.currentModel = newModel;
    });
  }
  return Promise.resolve();
}

/** Return a snapshot of currently running workers for API/UI consumers. */
export function getAgentInfo(): Array<{ slug: string; name: string; model: string; taskId: string; description: string }> {
  const allTasks = getActiveTasks().filter((t) => t.status === "running");
  const registry = getAgentRegistry();
  return allTasks.map((t) => {
    const agent = registry.find((a) => a.slug === t.agentSlug);
    return {
      slug: t.agentSlug,
      name: agent?.name || t.agentSlug,
      model: agent?.model || "unknown",
      taskId: t.taskId,
      description: t.description,
    };
  });
}

/** Clean up on shutdown/restart. */
export async function shutdownAgents(): Promise<void> {
  await clearActiveTasks();
}

