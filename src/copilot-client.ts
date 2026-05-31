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
