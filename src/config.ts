import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";
import { ENV_PATH, ensureMaxHome } from "./paths.js";

// Load from ~/.max/.env, fall back to cwd .env for dev
loadEnv({ path: ENV_PATH });
loadEnv(); // also check cwd for backwards compat

const configSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  AUTHORIZED_USER_ID: z.string().min(1).optional(),
  API_PORT: z.string().optional(),
  COPILOT_MODEL: z.string().optional(),
  WORKER_TIMEOUT: z.string().optional(),
  FEISHU_APP_ID: z.string().min(1).optional(),
  FEISHU_APP_SECRET: z.string().min(1).optional(),
  FEISHU_AUTHORIZED_OPEN_ID: z.string().min(1).optional(),
  FEISHU_DOMAIN: z.enum(["feishu", "lark"]).optional(),
  COPILOT_UI_SERVER_PORT: z.string().optional(),
  MAX_DELEGATE_MODEL: z.string().min(1).optional(),
  MAX_DELEGATE_API_KEY: z.string().min(1).optional(),
  MAX_DELEGATE_BASE_URL: z.string().min(1).optional(),
  MAX_DELEGATE_TYPE: z.string().min(1).optional(),
  MAX_DELEGATE_PROMPT_LENGTH: z.string().optional(),
  MAX_DELEGATE_MAX_ITERATIONS: z.string().optional(),
  MAX_DELEGATE_VERBOSE: z.string().optional(),
});

const raw = configSchema.parse(process.env);

const parsedUserId = raw.AUTHORIZED_USER_ID
  ? parseInt(raw.AUTHORIZED_USER_ID, 10)
  : undefined;
const parsedPort = parseInt(raw.API_PORT || "7777", 10);

if (parsedUserId !== undefined && (Number.isNaN(parsedUserId) || parsedUserId <= 0)) {
  throw new Error(`AUTHORIZED_USER_ID must be a positive integer, got: "${raw.AUTHORIZED_USER_ID}"`);
}
if (Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  throw new Error(`API_PORT must be 1-65535, got: "${raw.API_PORT}"`);
}

const DEFAULT_WORKER_TIMEOUT_MS = 600_000; // 10 minutes
const parsedWorkerTimeout = raw.WORKER_TIMEOUT
  ? Number(raw.WORKER_TIMEOUT)
  : DEFAULT_WORKER_TIMEOUT_MS;

if (!Number.isInteger(parsedWorkerTimeout) || parsedWorkerTimeout <= 0) {
  throw new Error(`WORKER_TIMEOUT must be a positive integer (ms), got: "${raw.WORKER_TIMEOUT}"`);
}

export const DEFAULT_MODEL = "claude-sonnet-4.6";

/**
 * Vision-capable model whitelist.
 *
 * The Copilot SDK's `listModels()` is the authoritative source for vision support,
 * but its server-side registry does not always enumerate every model a user has
 * access to (e.g. aliases, custom/internal IDs). When a model ID isn't in the
 * registry, the SDK falls back to `vision=false`, which causes Max to silently
 * strip image attachments before they reach the LLM.
 *
 * Models on this list are treated as vision-capable regardless of what the SDK
 * reports. Order of precedence in `modelSupportsVision()`:
 *   1. This whitelist (user-declared authority)
 *   2. SDK-reported `capabilities.supports.vision`
 *   3. default `false`
 *
 * Extend by adding a model ID. Matching is exact (case-sensitive).
 */
const VISION_CAPABLE_MODEL_OVERRIDES: ReadonlySet<string> = new Set<string>([
  "MiniMax-M3",
]);

let _copilotModel = raw.COPILOT_MODEL || DEFAULT_MODEL;
let _feishuAuthorizedOpenId = raw.FEISHU_AUTHORIZED_OPEN_ID;

export const config = {
  telegramBotToken: raw.TELEGRAM_BOT_TOKEN,
  authorizedUserId: parsedUserId,
  apiPort: parsedPort,
  workerTimeoutMs: parsedWorkerTimeout,
  feishuAppId: raw.FEISHU_APP_ID,
  feishuAppSecret: raw.FEISHU_APP_SECRET,
  feishuDomain: raw.FEISHU_DOMAIN ?? "feishu",
  get feishuAuthorizedOpenId(): string | undefined {
    return _feishuAuthorizedOpenId;
  },
  set feishuAuthorizedOpenId(v: string) {
    _feishuAuthorizedOpenId = v;
  },
  get copilotUiServerPort(): number {
    return parseInt(raw.COPILOT_UI_SERVER_PORT || "9999", 10);
  },
  get copilotModel(): string {
    return _copilotModel;
  },
  set copilotModel(model: string) {
    _copilotModel = model;
  },
  /**
   * Model IDs that Max treats as vision-capable regardless of what the Copilot
   * SDK reports. See `VISION_CAPABLE_MODEL_OVERRIDES` for the rationale.
   */
  get visionCapableModelOverrides(): ReadonlySet<string> {
    return VISION_CAPABLE_MODEL_OVERRIDES;
  },
  get telegramEnabled(): boolean {
    return !!this.telegramBotToken && this.authorizedUserId !== undefined;
  },
  get feishuEnabled(): boolean {
    return !!this.feishuAppId && !!this.feishuAppSecret;
  },
  get selfEditEnabled(): boolean {
    return process.env.MAX_SELF_EDIT === "1";
  },
  /**
   * When true, Max prefixes every assistant reply (across all channels) with
   * a small `[ws: <name>]` tag so the user can tell which workspace replied
   * when running multiple workspaces in parallel. Set to "0" to disable.
   */
  get workspaceTagEnabled(): boolean {
    const v = process.env.WORKSPACE_TAG_ENABLED;
    return v === undefined ? true : v !== "0" && v.toLowerCase() !== "false";
  },

  // ── Delegate (attention proxy) config ─────────────────────────

  get delegateModel(): string | undefined {
    return raw.MAX_DELEGATE_MODEL;
  },
  get delegateApiKey(): string | undefined {
    return raw.MAX_DELEGATE_API_KEY;
  },
  get delegateBaseUrl(): string | undefined {
    return raw.MAX_DELEGATE_BASE_URL;
  },
  get delegateEnabled(): boolean {
    return !!this.delegateModel && !!this.delegateApiKey && !!this.delegateBaseUrl;
  },
  get delegateProviderType(): string {
    return raw.MAX_DELEGATE_TYPE || "openai";
  },
  get delegatePromptLength(): number {
    const v = raw.MAX_DELEGATE_PROMPT_LENGTH;
    return v ? parseInt(v, 10) : 400;
  },
  get delegateMaxIterations(): number {
    const v = raw.MAX_DELEGATE_MAX_ITERATIONS;
    return v ? parseInt(v, 10) : 20;
  },
  get delegateVerbose(): boolean {
    return raw.MAX_DELEGATE_VERBOSE === "true";
  },
};

/** Update or append an env var in ~/.max/.env */
function persistEnvVar(key: string, value: string): void {
  ensureMaxHome();
  try {
    const content = readFileSync(ENV_PATH, "utf-8");
    const lines = content.split("\n");
    let found = false;
    const updated = lines.map((line) => {
      if (line.startsWith(`${key}=`)) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });
    if (!found) updated.push(`${key}=${value}`);
    writeFileSync(ENV_PATH, updated.join("\n"));
  } catch {
    // File doesn't exist — create it
    writeFileSync(ENV_PATH, `${key}=${value}\n`);
  }
}

/** Persist the current model choice to ~/.max/.env */
export function persistModel(model: string): void {
  persistEnvVar("COPILOT_MODEL", model);
}

/** Persist a newly registered Feishu user's open_id to ~/.max/.env */
export function persistFeishuAuthorizedOpenId(openId: string): void {
  persistEnvVar("FEISHU_AUTHORIZED_OPEN_ID", openId);
}

/** Clear the paired Feishu open_id from memory and ~/.max/.env */
export function clearFeishuAuthorizedOpenId(): void {
  _feishuAuthorizedOpenId = undefined;
  try {
    const content = readFileSync(ENV_PATH, "utf-8");
    const lines = content.split("\n").filter((l) => !l.startsWith("FEISHU_AUTHORIZED_OPEN_ID="));
    writeFileSync(ENV_PATH, lines.join("\n"));
  } catch {
    // File may not exist — nothing to clear
  }
}
