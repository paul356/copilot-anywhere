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
  clearWorkspaceSessionId,
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

/** In-flight `getOrCreateSession` promises keyed by cacheKey. Lets a second
 *  concurrent caller (e.g. Feishu + Telegram hitting the same workspace
 *  right after a daemon restart) reuse the first caller's resume/create
 *  instead of issuing a duplicate one — without this, both callers pass
 *  the cache check, both call resumeSession/createSession, and the second
 *  sessionCache.set overwrites the first, leaving a stale handle whose
 *  event subscriptions still fire and pollute the other channel's output. */
const inflightSessions = new Map<string, Promise<CopilotSession>>();

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
    if (!ensurePoolSlot(wsName)) {
      // All MAX_ACTIVE slots are busy and none can be evicted. Don't
      // create a session that no one tracks — the next LRU pass would
      // just orphan it again. Surface the contention to the caller.
      throw new Error(
        `Cannot allocate session for workspace '${wsName}': all ${MAX_ACTIVE} workspace slots are busy. ` +
        `Wait for an active prompt to finish, or use /max:ws switch to an idle workspace.`
      );
    }
  }

  recordPoolUse(wsName);
  const cacheKey = `${wsName}:${options.workingDirectory ?? "cwd"}`;

  // Fast path: already cached — return immediately.
  const cached = sessionCache.get(cacheKey);
  if (cached) return cached;

  // Single-flight: if another caller is already mid-create/mid-resume for
  // this cacheKey, share its promise. Prevents the
  // "Feishu + Telegram race the first prompt after restart" bug where
  // both pass the cache check above, both hit resumeSession/createSession,
  // and the second sessionCache.set overwrites the first. Cleanup happens
  // in the first caller's finally — the second caller just rides the same
  // promise (resolved value or rejected error).
  const inflight = inflightSessions.get(cacheKey);
  if (inflight) return inflight;

  const promise = doGetOrCreateSession(wsName, port, options);
  inflightSessions.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    // Clear whether the inner call resolved or threw. The entry must
    // NOT outlive the operation, otherwise future callers would get a
    // stale settled promise.
    inflightSessions.delete(cacheKey);
  }
}

/** Inner body of getOrCreateSession — wrapped by the single-flight
 *  inflight map above. Only the caller that wins the inflight race
 *  (i.e. the one that called getOrCreateSession first for this cacheKey
 *  with a cache miss) ever executes this function. */
async function doGetOrCreateSession(
  wsName: string,
  port: number,
  options: SessionOptions,
): Promise<CopilotSession> {
  const cacheKey = `${wsName}:${options.workingDirectory ?? "cwd"}`;
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

/** Invalidate a cached session (e.g., after an error or pool eviction).
 *  Removes every cache entry whose key starts with `${wsName}:`.
 *
 *  The eviction path (ensurePoolSlot's LRU eviction, removeFromPool) only
 *  has the wsName, not the workingDir that was used to construct the cache
 *  key at session creation. A key built from wsName alone would miss the
 *  real entry and leave the session dangling in the cache, causing the
 *  next getOrCreateSession for that workspace to return the stale handle
 *  instead of recreating. Prefix scan is the safe fix. */
export function invalidateSession(wsName: string): void {
  const prefix = `${wsName}:`;
  for (const key of [...sessionCache.keys()]) {
    if (key.startsWith(prefix)) sessionCache.delete(key);
  }
}

/** Invalidate all cached sessions (e.g., after CLI restart) */
export function invalidateAllSessions(): void {
  sessionCache.clear();
}

/** Destroy the cached SDK session for a workspace, drop it from the
 *  workspace pool, and clear its persisted `copilot_session_id` in
 *  worker_sessions. After this returns true, the next
 *  getOrCreateSession for `wsName` will allocate a fresh pool slot
 *  and go through the createSession path (resumeSession on the
 *  destroyed id will fail, and the existing fallback in
 *  getOrCreateSession already handles that).
 *
 *  Returns true on success, false if the workspace is currently busy
 *  with an in-flight prompt — destruction would orphan that prompt's
 *  event subscriptions, so the caller (the /max:clear handler) refuses
 *  and tells the user to /max:cancel first. The `default` workspace
 *  has no pool entry and no persisted id; the function is still safe
 *  to call on it (just clears sessionCache). */
export function destroyAndInvalidateSession(wsName: string): boolean {
  const entry = workspacePool.get(wsName);
  if (entry?.busy) {
    return false;
  }

  // Find and destroy any cached session for this workspace. Fire-and-
  // forget — the SDK destroy is best-effort and we already committed
  // to clearing. (The caller checked busy; either there is no in-
  // flight prompt, or we refused and the caller is not calling us.)
  for (const [key, session] of sessionCache.entries()) {
    if (key.startsWith(`${wsName}:`)) {
      session.destroy().catch((err: unknown) => {
        console.warn(`[copilot-client] Session destroy failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
      });
      break;
    }
  }

  // Clear sessionCache (prefix scan), pool entry, and persisted id.
  // invalidateSession now ignores workingDir and deletes every entry
  // whose key starts with `${wsName}:`.
  invalidateSession(wsName);
  workspacePool.delete(wsName);
  clearWorkspaceSessionId(wsName);

  console.log(`[copilot-client] Destroyed and invalidated session for workspace '${wsName}'`);
  return true;
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

/** Ensure the pool has a slot for `wsName`. If full, evicts the oldest
 *  non-busy, non-default workspace.
 *
 *  Returns `true` if a slot was allocated (or already existed for this
 *  wsName). Returns `false` if all MAX_ACTIVE slots are busy and no
 *  eviction was possible — caller should treat that as a hard failure
 *  (don't create a session that no one will manage). */
export function ensurePoolSlot(wsName: string): boolean {
  if (workspacePool.has(wsName)) return true;

  if (workspacePool.size < MAX_ACTIVE) {
    workspacePool.set(wsName, { lastUsed: Date.now(), busy: false });
    console.log(`[copilot-client] Pool slot allocated for '${wsName}' (${workspacePool.size}/${MAX_ACTIVE})`);
    return true;
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
    // All MAX_ACTIVE slots are busy. Caller will throw so the user gets a
    // clear error instead of silently creating a session that nothing
    // tracks in the pool.
    console.warn(`[copilot-client] All ${MAX_ACTIVE} workspaces are busy — cannot allocate slot for '${wsName}'`);
    return false;
  }

  console.log(`[copilot-client] Evicting workspace '${oldestKey}' (last used ${Math.round((Date.now() - oldestTime) / 1000)}s ago) to make room for '${wsName}'`);
  invalidateSession(oldestKey);
  workspacePool.delete(oldestKey);
  workspacePool.set(wsName, { lastUsed: Date.now(), busy: false });
  console.log(`[copilot-client] Pool slot allocated for '${wsName}' (${workspacePool.size}/${MAX_ACTIVE})`);
  return true;
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
