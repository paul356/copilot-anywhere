/**
 * Copilot SDK Client
 *
 * Connects to a running copilot --ui-server via cliUrl.
 * Manages CopilotSessions per workspace — each workspace gets its own
 * session with a potentially different workingDirectory.
 */

import {
  CopilotClient,
  CopilotSession,
  approveAll,
} from "@github/copilot-sdk";
import type { PermissionHandler, PermissionRequest, SessionConfig } from "@github/copilot-sdk";
import { DEFAULT_MODEL } from "./config.js";
import {
  SESSIONS_DIR,
} from "./paths.js";
import {
  getWorkspace,
  saveWorkspaceSessionId,
} from "./store/db.js";

// ── User Input Delegation ──────────────────────────────────────────
// When the LLM uses ask_user, the SDK calls onUserInputRequest (an RPC
// handler). We delegate to the message-handler which sends the question
// to the appropriate channel (TUI / Feishu / Telegram) and waits for
// the user's answer.

type UserInputDelegate = (sessionId: string, question: string, choices?: string[], allowFreeform?: boolean) => Promise<string>;

let userInputDelegate: UserInputDelegate | undefined;

export function setUserInputDelegate(delegate: UserInputDelegate): void {
  userInputDelegate = delegate;
}

function createUserInputHandler(): SessionConfig["onUserInputRequest"] {
  if (!userInputDelegate) {
    // Fallback: answer every question with a polite decline so the
    // conversation doesn't hang forever. The delegate will be set
    // once the daemon wires everything up.
    return async () => ({
      answer: "(The user is not available to answer questions right now.)",
      wasFreeform: true,
    });
  }
  return async (request: { question: string; choices?: string[]; allowFreeform?: boolean }, invocation: { sessionId: string }) => {
    const answer = await userInputDelegate!(invocation.sessionId, request.question, request.choices, request.allowFreeform);
    return { answer, wasFreeform: true };
  };
}

let client: CopilotClient | undefined;

export async function getClient(port: number): Promise<CopilotClient> {
  if (!client) {
    client = new CopilotClient({
      cliUrl: `localhost:${port}`,
    });
    await client.start();
    console.log(`[copilot-client] Connected to copilot --ui-server on port ${port}`);
  }
  return client;
}

export async function stopClient(): Promise<void> {
  if (client) {
    try { await client.stop(); } catch {}
    client = undefined;
  }
}

export interface SessionOptions {
  model?: string;
  workingDirectory?: string;
  systemPrompt?: string;
}

/**
 * Build a provider config from COPILOT_PROVIDER_* environment variables.
 * Returns undefined if no custom provider is configured.
 */
export function getProviderConfig() {
  const type = process.env.COPILOT_PROVIDER_TYPE;
  const baseUrl = process.env.COPILOT_PROVIDER_BASE_URL;
  const apiKey = process.env.COPILOT_PROVIDER_API_KEY;

  if (!type || !apiKey) return undefined;

  return {
    type: type as "openai" | "azure" | "anthropic",
    baseUrl: baseUrl || "",
    apiKey,
  } satisfies SessionConfig["provider"];
}

/** Permission handler that logs every request then delegates to approveAll. */
function loggingPermissionHandler(request: PermissionRequest): ReturnType<PermissionHandler> {
  console.log(`[copilot-client] Permission request: kind=${request.kind}, toolCallId=${request.toolCallId ?? "none"}, keys=${Object.keys(request).join(",")}`);
  const result = approveAll(request, { sessionId: "unknown" });
  console.log(`[copilot-client] Permission result: ${JSON.stringify(result)}`);
  return result;
}

/**
 * Pre-tool-use hook that always allows tool execution.
 * This runs on the server side via hooks.invoke RPC, which resolves the
 * permission BEFORE the permission.requested event. When hooks handle it,
 * the event's resolvedByHook flag is set to true, preventing the SDK's
 * legacy _executePermissionAndRespond RPC from double-processing.
 */
function alwaysAllowHook(input: { toolName: string; toolArgs: unknown; timestamp: number; cwd: string }) {
  console.log(`[copilot-client] onPreToolUse hook: toolName=${input.toolName}`);
  return { permissionDecision: "allow" as const };
}

const alwaysAllowHooks = {
  onPreToolUse: alwaysAllowHook,
};

const sessionCache = new Map<string, CopilotSession>();

/**
 * Get or create a CopilotSession for a workspace.
 *
 * Sessions are cached in-memory. Named workspaces try to resume
 * a previously saved session ID; the default workspace always
 * gets a fresh session each daemon start.
 */
export async function getOrCreateSession(
  wsName: string,
  port: number,
  options: SessionOptions = {},
): Promise<CopilotSession> {
  // Ensure this workspace has a pool slot (may evict oldest non-busy).
  if (wsName !== "default") {
    ensurePoolSlot(wsName);
  }

  recordPoolUse(wsName);
  const cacheKey = `${wsName}:${options.workingDirectory ?? "cwd"}`;
  const cached = sessionCache.get(cacheKey);
  if (cached) return cached;

  const cli = await getClient(port);
  const workingDir = options.workingDirectory;

  // Try to resume a saved session for named workspaces
  if (wsName !== "default" && workingDir) {
    const wsRow = getWorkspace(wsName);
    if (wsRow?.copilot_session_id) {
      try {
        const resumeConfig: SessionConfig = {
          model: options.model ?? DEFAULT_MODEL,
          configDir: wsRow.config_dir ?? SESSIONS_DIR,
          streaming: true,
          onPermissionRequest: loggingPermissionHandler,
          onUserInputRequest: createUserInputHandler(),
          hooks: alwaysAllowHooks,
        };
        const providerConfig = getProviderConfig();
        if (providerConfig) {
          resumeConfig.provider = providerConfig;
        }
        const session = await cli.resumeSession(wsRow.copilot_session_id, resumeConfig);
        sessionCache.set(cacheKey, session);
        console.log(`[copilot-client] Resumed session for workspace '${wsName}', workspacePath=${(session as any)._workspacePath ?? "unknown"}`);
        return session;
      } catch (err) {
        console.log(`[copilot-client] Session for ${wsName} not found on server (normal after restart), creating new...`);
      }
    }
  }

  // Create a fresh session
  const sessionConfig: SessionConfig = {
    model: options.model ?? DEFAULT_MODEL,
    configDir: SESSIONS_DIR,
    streaming: true,
    onPermissionRequest: loggingPermissionHandler,
    onUserInputRequest: createUserInputHandler(),
    hooks: alwaysAllowHooks,
  };

  const providerConfig = getProviderConfig();
  if (providerConfig) {
    sessionConfig.provider = providerConfig;
  }

  if (workingDir) {
    sessionConfig.workingDirectory = workingDir;
  }

  if (options.systemPrompt) {
    sessionConfig.systemMessage = { content: options.systemPrompt };
  }

  const session = await cli.createSession(sessionConfig);
  sessionCache.set(cacheKey, session);

  // Log the server-assigned workspace path for debugging file-access issues
  console.log(`[copilot-client] Session ${session.sessionId.slice(0, 8)}… workspacePath=${(session as any)._workspacePath ?? "unknown"}`);

  // Persist session ID for named workspaces
  if (wsName !== "default" && workingDir) {
    saveWorkspaceSessionId(wsName, session.sessionId);
  }

  console.log(`[copilot-client] Created session for workspace '${wsName}' (${session.sessionId.slice(0, 8)}…, model=${sessionConfig.model ?? "default"}, workingDir=${sessionConfig.workingDirectory ?? "cwd"}, provider=${providerConfig ? providerConfig.type : "copilot"})`);
  return session;
}

/** Invalidate a cached session (e.g., after an error) */
export function invalidateSession(wsName: string, workingDir?: string): void {
  const cacheKey = `${wsName}:${workingDir ?? "cwd"}`;
  sessionCache.delete(cacheKey);
}

/** Invalidate all cached sessions (e.g., after CLI restart) */
export function invalidateAllSessions(): void {
  sessionCache.clear();
}

// ── Workspace Pool ────────────────────────────────────────────────
// Tracks which workspaces are "active" (have a copilot session) and
// enforces a soft cap.  When the cap is hit, the oldest non-busy
// workspace is evicted (its session invalidated).

interface PoolEntry {
  lastUsed: number;
  busy: boolean;
}

const workspacePool = new Map<string, PoolEntry>();
const MAX_ACTIVE = 5;

/** Ensure the pool has a slot for `wsName`. If full, evicts the oldest non-busy workspace (excluding "default"). */
export function ensurePoolSlot(wsName: string): void {
  if (workspacePool.has(wsName)) return;

  if (workspacePool.size < MAX_ACTIVE) {
    workspacePool.set(wsName, { lastUsed: Date.now(), busy: false });
    console.log(`[copilot-client] Pool slot allocated for '${wsName}' (${workspacePool.size}/${MAX_ACTIVE})`);
    return;
  }

  // Find oldest non-busy workspace to evict.
  let oldestKey: string | undefined;
  let oldestTime = Infinity;
  for (const [key, entry] of workspacePool) {
    if (key === "default" || entry.busy) continue;
    if (entry.lastUsed < oldestTime) {
      oldestTime = entry.lastUsed;
      oldestKey = key;
    }
  }

  if (!oldestKey) {
    console.warn(`[copilot-client] All ${MAX_ACTIVE} workspaces are busy — cannot allocate slot for '${wsName}'`);
    return; // Caller will fall back to default or retry.
  }

  console.log(`[copilot-client] Evicting workspace '${oldestKey}' (last used ${Math.round((Date.now() - oldestTime) / 1000)}s ago) to make room for '${wsName}'`);
  invalidateSession(oldestKey);
  workspacePool.delete(oldestKey);
  workspacePool.set(wsName, { lastUsed: Date.now(), busy: false });
  console.log(`[copilot-client] Pool slot allocated for '${wsName}' (${workspacePool.size}/${MAX_ACTIVE})`);
}

/** Mark a workspace as busy (processing a prompt). */
export function markPoolBusy(wsName: string): void {
  const entry = workspacePool.get(wsName);
  if (entry) entry.busy = true;
}

/** Mark a workspace as idle. */
export function markPoolIdle(wsName: string): void {
  const entry = workspacePool.get(wsName);
  if (entry) entry.busy = false;
}

/** Record that the workspace was just used (updates lastUsed). */
export function recordPoolUse(wsName: string): void {
  const entry = workspacePool.get(wsName);
  if (entry) entry.lastUsed = Date.now();
}

/** Remove a workspace from the pool (e.g., on ws delete). */
export function removeFromPool(wsName: string): void {
  invalidateSession(wsName);
  workspacePool.delete(wsName);
}

/** Clean up all pooled workspaces. */
export function clearPool(): void {
  invalidateAllSessions();
  workspacePool.clear();
}

/** Check if a workspace is in the pool and currently busy. */
export function isPoolBusy(wsName: string): boolean {
  return workspacePool.get(wsName)?.busy ?? false;
}
