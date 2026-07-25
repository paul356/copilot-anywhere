/**
 * Message Handler
 *
 * Executes routed messages against the appropriate backend:
 *   - "prompt" → Copilot SDK session
 *   - "cli-command" → CLI PTY
 *   - "max-command" → command-router.executeMaxCommand
 *
 * Per-channel serial queues: only one in-flight message per channel at a time.
 * Retry on recoverable errors (3x, exponential backoff).
 *
 * Timeout policy:
 *   - LLM processing: 1 hour hard cap (resets on every session event).
 *   - ask_user waiting: NO timeout — user can come back arbitrarily later.
 *     The hard timer is paused while pendingInput holds a question and
 *     resumed once the user answers.
 *   - Cleanup runs in a single try/finally so cancelled / timed-out /
 *     errored prompts all release session subscriptions and map entries.
 */

import { CopilotSession } from "@github/copilot-sdk";
import { RoutedMessage, executeMaxCommand, type Attachment } from "./command-router.js";
import { CLIProcess } from "./cli-process.js";
import { getActiveWorkspace } from "./store/db.js";
import { getClient } from "./copilot/client.js";
import { invalidateSession, markPoolBusy, markPoolIdle } from "./copilot-client.js";
import { config } from "./config.js";
import { appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import * as delegateStore from "./delegate-store.js";
import { check as delegateCheck } from "./delegate.js";
import { getRecentConversation } from "./store/db.js";

const MH_DBG_LOG = join(homedir(), ".max", "feishu-debug.log");
function mhDbg(...args: unknown[]): void {
  try {
    const line = `[${new Date().toISOString()}] [mh] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`;
    appendFileSync(MH_DBG_LOG, line);
  } catch { /* ignore */ }
}

// ── Types ──────────────────────────────────────────────────────────

export type MessageCallback = (text: string, done: boolean, meta?: { source: "copilot" | "delegate" | "delegate-prompt" | "delegate-status" }) => void;

export interface MessageHandlerOptions {
  port: number;
  // wsName is the workspace captured at queue-entry time — NOT the current
  // active workspace. Reading getActiveWorkspace() here would silently
  // re-route work prompts to the max session (or vice-versa) if the user
  // switched active ws while the queue item was waiting.
  getSessionForChannel: (channelId: string, wsName: string) => Promise<{ session: CopilotSession; workspaceName: string; workingDir?: string }>;
  cliProcess: CLIProcess;
  defaultTimeoutMs?: number;
}

export interface QueuedMessage {
  routed: RoutedMessage;
  callback: MessageCallback;
  resolve: () => void;
  reject: (err: Error) => void;
}

// ── Constants ──────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000];
const LLM_HARD_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour cap on LLM call-to-response time
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (legacy — no longer used for activity)
const RECOVERABLE_PATTERNS = /connection|EADDR|ECONN|ETIMEDOUT|ENOTFOUND|socket hang up|pipe/i;
const FATAL_TIMEOUT_PATTERNS = /LLM not responding|LLM call timed out|no activity/i;
const CLI_COMMAND_TIMEOUT_MS = 15_000; // 15s for CLI slash command TUI output
const CLI_COMMAND_SETTLE_MS = 1_500;   // wait 1.5s for TUI to finish rendering
const ASK_USER_FALLBACK_ANSWER = "(Previous question was abandoned due to timeout. Please re-ask if needed.)";

function isRecoverable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (FATAL_TIMEOUT_PATTERNS.test(msg)) return false;
  return RECOVERABLE_PATTERNS.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build the per-turn workspace tag that Max prepends to assistant replies.
 *
 * Returned as `""` when disabled or when no workspace name is known. The tag is
 * intended for the user, never for the LLM — do NOT splice it into the
 * messages array or session state.
 *
 * Exported so other channels (e.g. Feishu's "正在思考..." notice) can prepend
 * the same tag for consistency with assistant replies.
 */
export function buildWorkspaceTag(wsName: string | undefined): string {
  if (!config.workspaceTagEnabled) return "";
  if (!wsName) return "";
  return `[ws: ${wsName}]\n`;
}

/**
 * Wrap a per-channel reply callback so every assistant reply in this turn
 * starts with a small `[ws: <name>]` reminder. The tag is re-prepended on
 * every call (not just the first) because Telegram and Feishu compute
 * `text.slice(sentLength)` to send only the newly arrived slice — if we
 * dropped the tag after the first call, subsequent slices would lose it.
 * For channels that render the full accumulated text on each call (TUI SSE
 * stream), the user just sees a single tag in the final message because
 * the channel replaces the prior content.
 *
 * `ask_user` JSON envelopes are passed through verbatim (they start with
 * `{"type":"question"`) — prefixing them would break downstream parsing in
 * the channels.
 *
 * The wrapper is a no-op when the feature is disabled by config.
 */
function wrapCallbackWithWorkspaceTag(
  rawCallback: MessageCallback,
  wsName: string,
): MessageCallback {
  const tag = buildWorkspaceTag(wsName);
  if (!tag) return rawCallback;
  return (text: string, done: boolean) => {
    if (!text) {
      // Pure "done" signal with no content (e.g. the final session.idle
      // callback). Pass through untouched.
      rawCallback(text, done);
      return;
    }
    // ask_user JSON envelopes must reach the channel untouched.
    if (text.startsWith('{"type":"question"')) {
      rawCallback(text, done);
      return;
    }
    rawCallback(tag + text, done);
  };
}

// ── Model capability check (cached) ───────────────────────────────

/** Cached result of the last model capability query. */
let _modelVisionSupport: { modelId: string; supportsVision: boolean } | null = null;

/**
 * Check whether the currently configured model supports vision/image inputs.
 * Result is cached per model ID — re-fetches only when the model changes.
 */
async function modelSupportsVision(): Promise<boolean> {
  const modelId = config.copilotModel;

  // Whitelist takes precedence — see VISION_CAPABLE_MODEL_OVERRIDES in config.ts.
  // If the active model is on the whitelist, skip the SDK round-trip entirely.
  if (config.visionCapableModelOverrides.has(modelId)) {
    if (!_modelVisionSupport || _modelVisionSupport.modelId !== modelId) {
      _modelVisionSupport = { modelId, supportsVision: true };
      console.log(`[message-handler] Model vision support: model=${modelId} vision=true (whitelist override)`);
    }
    return true;
  }

  if (_modelVisionSupport && _modelVisionSupport.modelId === modelId) {
    return _modelVisionSupport.supportsVision;
  }
  try {
    const client = await getClient();
    const models = await client.listModels();
    const current = models.find((m) => m.id === modelId);
    const supportsVision = current?.capabilities?.supports?.vision ?? false;
    _modelVisionSupport = { modelId, supportsVision };
    console.log(`[message-handler] Model vision support: model=${modelId} vision=${supportsVision}`);
    return supportsVision;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[message-handler] Could not check model capabilities: ${msg}. Assuming no vision support.`);
    return false;
  }
}

/**
 * Filter attachments against model capabilities.
 * - blob type attachments (images) require vision support
 * - file type attachments are always allowed
 *
 * Returns the filtered list and a warning message (empty string if all good).
 */
async function filterAttachments(
  attachments: Attachment[],
): Promise<{ filtered: Attachment[]; warning: string }> {
  if (!attachments || attachments.length === 0) {
    return { filtered: [], warning: "" };
  }

  const hasBlobs = attachments.some((a) => a.type === "blob");
  if (!hasBlobs) {
    // Only file-type attachments — always allowed
    return { filtered: attachments, warning: "" };
  }

  const supportsVision = await modelSupportsVision();
  if (supportsVision) {
    return { filtered: attachments, warning: "" };
  }

  // Model doesn't support vision — strip blob attachments, keep files
  const stripped: string[] = [];
  const kept = attachments.filter((a) => {
    if (a.type === "blob") {
      stripped.push(a.displayName || a.mimeType);
      return false;
    }
    return true;
  });

  const warning = stripped.length > 0
    ? `\n\n⚠️ 当前模型不支持图片输入，已跳过：${stripped.join("、")}。`
    : "";

  if (stripped.length > 0) {
    console.log(`[message-handler] Stripped ${stripped.length} blob attachment(s) — model lacks vision: ${stripped.join(", ")}`);
  }

  return { filtered: kept, warning };
}

/** Strip ANSI escape codes and cursor movement sequences from PTY output */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")  // CSI sequences (colors, cursor, private modes like [?25l)
    .replace(/\x1b\][0-9];.*?(\x07|\x1b\\)/g, "")                // OSC sequences (title, etc.)
    .replace(/\x1b[PX^_].*?\x1b\\/g, "")                          // DCS/SOS/PM/APC strings
    .replace(/\x1b[>=].*?[\x07\x1b]/g, "")                         // other escape sequences
    .replace(/\r/g, "")                                            // carriage returns
    .replace(/\n{3,}/g, "\n\n")                                    // collapse excessive blank lines
    .trim();
}

// PTY dimensions — must match the values in cli-process.ts
const PTY_COLS = 120;
const PTY_ROWS = 40;

/**
 * Render raw PTY output through a lightweight terminal screen emulator.
 * Correctly handles cursor absolute column positioning (\x1b[NG) so that
 * command names and descriptions that are positioned via cursor movement
 * are rendered with proper spacing rather than concatenated together.
 *
 * Returns the final screen contents as plain text with trailing whitespace
 * stripped from each line and empty trailing lines removed.
 */
/** Persistent terminal screen state, shared across pager-page renders. */
interface TerminalState {
  screen: string[][];
  row: number;
  col: number;
  scrollTop: number;
  scrollBottom: number;
  /** VT100 auto-wrap pending: set when a char is written to the last column.
   *  The actual wrap is deferred until the next printable char is written. */
  pendingWrap: boolean;
}

function createTerminalState(): TerminalState {
  return {
    screen: Array.from({ length: PTY_ROWS }, () => Array(PTY_COLS).fill(" ")),
    row: 0,
    col: 0,
    scrollTop: 0,
    scrollBottom: PTY_ROWS - 1,
    pendingWrap: false,
  };
}

/**
 * Process raw PTY bytes into an existing TerminalState (mutates in place).
 * Calling this multiple times on the same state correctly handles pagers that
 * use differential rendering (only redrawing changed cells across pages).
 */
function renderInto(raw: string, st: TerminalState): void {
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const parseNum = (s: string, def: number) => { const n = parseInt(s); return isNaN(n) ? def : n; };
  // Clear pendingWrap whenever cursor is explicitly repositioned.
  const clearWrap = () => { st.pendingWrap = false; };

  const scrollUp = (n: number) => {
    for (let k = 0; k < n; k++) {
      st.screen.splice(st.scrollTop, 1);
      st.screen.splice(st.scrollBottom, 0, Array(PTY_COLS).fill(" "));
    }
  };
  const scrollDown = (n: number) => {
    for (let k = 0; k < n; k++) {
      st.screen.splice(st.scrollBottom, 1);
      st.screen.splice(st.scrollTop, 0, Array(PTY_COLS).fill(" "));
    }
  };

  const chars = Array.from(raw); // iterate Unicode code points (handles emoji etc.)
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "\x1b") {
      const next = chars[i + 1];
      if (next === "[") {
        // CSI sequence: ESC [ <params...> <final>
        let j = i + 2;
        while (j < chars.length && (chars[j].charCodeAt(0) < 0x40 || chars[j].charCodeAt(0) > 0x7e)) j++;
        const params = chars.slice(i + 2, j).join("");
        const cmd = chars[j] ?? "";
        i = j + 1;
        switch (cmd) {
          case "H": case "f": { // cursor position [row;col]
            const parts = params.split(";");
            st.row = clamp(parseNum(parts[0], 1) - 1, 0, PTY_ROWS - 1);
            st.col = clamp(parseNum(parts[1], 1) - 1, 0, PTY_COLS - 1);
            clearWrap();
            break;
          }
          case "G": // cursor absolute column
            st.col = clamp(parseNum(params, 1) - 1, 0, PTY_COLS - 1);
            clearWrap();
            break;
          case "d": // cursor absolute row
            st.row = clamp(parseNum(params, 1) - 1, 0, PTY_ROWS - 1);
            clearWrap();
            break;
          case "A": st.row = clamp(st.row - parseNum(params, 1), 0, PTY_ROWS - 1); clearWrap(); break;
          case "B": st.row = clamp(st.row + parseNum(params, 1), 0, PTY_ROWS - 1); clearWrap(); break;
          case "C": st.col = clamp(st.col + parseNum(params, 1), 0, PTY_COLS - 1); clearWrap(); break;
          case "D": st.col = clamp(st.col - parseNum(params, 1), 0, PTY_COLS - 1); clearWrap(); break;
          case "r": { // DECSTBM — set scrolling region (cursor position unchanged)
            const parts = params.split(";");
            st.scrollTop = clamp(parseNum(parts[0], 1) - 1, 0, PTY_ROWS - 1);
            st.scrollBottom = clamp(parseNum(parts[1], PTY_ROWS) - 1, 0, PTY_ROWS - 1);
            break;
          }
          case "J": // erase in display
            if (params === "2" || params === "3") {
              for (const r of st.screen) r.fill(" ");
              st.row = 0; st.col = 0;
            } else if (params === "1") {
              for (let r = 0; r < st.row; r++) st.screen[r].fill(" ");
              for (let c = 0; c <= st.col; c++) st.screen[st.row][c] = " ";
            } else { // 0 or empty: from cursor to end
              for (let c = st.col; c < PTY_COLS; c++) st.screen[st.row][c] = " ";
              for (let r = st.row + 1; r < PTY_ROWS; r++) st.screen[r].fill(" ");
            }
            clearWrap();
            break;
          case "K": // erase in line
            if (params === "1") { for (let c = 0; c <= st.col; c++) st.screen[st.row][c] = " "; }
            else if (params === "2") { st.screen[st.row].fill(" "); }
            else { for (let c = st.col; c < PTY_COLS; c++) st.screen[st.row][c] = " "; }
            clearWrap();
            break;
          case "S": scrollUp(parseNum(params, 1)); clearWrap(); break;
          case "T": scrollDown(parseNum(params, 1)); clearWrap(); break;
          // All other CSI sequences (SGR colors, mode changes, etc.) are ignored
        }
      } else if (next === "]") {
        // OSC: skip to BEL or ST
        let j = i + 2;
        while (j < chars.length && chars[j] !== "\x07" && !(chars[j] === "\x1b" && chars[j + 1] === "\\")) j++;
        i = j + (chars[j] === "\x07" ? 1 : chars[j] === "\x1b" ? 2 : 1);
      } else {
        i += 2; // other 2-char escape — skip
      }
    } else if (ch === "\r") {
      st.col = 0; st.pendingWrap = false; i++;
    } else if (ch === "\n") {
      st.row = clamp(st.row + 1, 0, PTY_ROWS - 1);
      i++;
    } else if (ch === "\b") {
      st.col = Math.max(0, st.col - 1); st.pendingWrap = false; i++;
    } else if (ch === "\t") {
      st.col = clamp((st.col + 8) & ~7, 0, PTY_COLS - 1); st.pendingWrap = false; i++;
    } else if (ch >= " ") {
      // Printable character — apply any pending wrap first (VT100 auto-wrap behaviour).
      if (st.pendingWrap) {
        st.col = 0;
        st.row = clamp(st.row + 1, 0, PTY_ROWS - 1);
        st.pendingWrap = false;
      }
      if (st.row < PTY_ROWS && st.col < PTY_COLS) {
        st.screen[st.row][st.col] = ch;
        st.col++;
        if (st.col >= PTY_COLS) {
          // Don't wrap yet; set flag so the wrap fires on the next printable char.
          st.col = PTY_COLS - 1;
          st.pendingWrap = true;
        }
      }
      i++;
    } else {
      i++; // skip other control characters
    }
  }
}

/** Extract the current screen buffer as plain text. */
function extractScreen(st: TerminalState): string {
  const lines = st.screen.map(line => line.join("").trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Render a standalone PTY chunk into a fresh terminal and return the text. */
function renderTerminal(raw: string): string {
  const st = createTerminalState();
  renderInto(raw, st);
  return extractScreen(st);
}

/**
 * Detect whether the PTY output contains an interactive pager (e.g. copilot's
 * /help or /skills overlay) and strip the pager chrome (borders, scroll hint).
 * Returns the cleaned content and whether a pager was detected.
 */
function stripPager(text: string): { content: string; hasPager: boolean } {
  const hasPager = text.includes("esc close") || text.includes("┃");
  if (!hasPager) return { content: text, hasPager: false };

  // Remove the scroll hint line and all box border characters
  const cleaned = text
    .replace(/[↑↓]\/[↑↓] scroll[^\n]*/g, "")  // scroll hint
    .replace(/┃/g, "")                          // right-side box border
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { content: cleaned, hasPager: true };
}

/**
 * Find where non-overlapping new content starts in newLines by looking for the
 * longest suffix of prevLines that matches a prefix of newLines.
 * Returns the number of leading lines in newLines to skip.
 */
function findOverlapLen(prevLines: string[], newLines: string[]): number {
  const maxOverlap = Math.min(prevLines.length, newLines.length);
  for (let len = maxOverlap; len >= 2; len--) {
    const prevSuffix = prevLines.slice(prevLines.length - len);
    const newPrefix = newLines.slice(0, len);
    // Allow up to 10% mismatches to tolerate TUI status-bar contamination
    // (the TUI sometimes overwrites a pager row with status bar text between captures)
    const mismatches = prevSuffix.filter((line, i) => line.trim() !== newPrefix[i].trim()).length;
    if (mismatches <= Math.max(1, Math.floor(len * 0.1))) {
      return len;
    }
  }
  return 0;
}

/**
 * Scroll through a pager that is currently open in the PTY, collecting all
 * pages of content and merging them into a single string.
 * Uses a persistent TerminalState so differential pager renders (which skip
 * characters already on screen) are handled correctly across pages.
 * Sends Escape when done to dismiss the pager.
 */
async function collectPagerContent(
  cliProcess: CLIProcess,
  st: TerminalState,
  firstPageContent: string,
  maxPages = 30,
): Promise<string> {
  // PTY is 40 rows; pager content area is roughly 38 lines per screen
  const SCROLL_LINES = 38;
  const DOWN_ARROW = "\x1b[B";

  const allLines: string[] = firstPageContent.split("\n").filter(l => l.trim());
  // Guard against re-adding lines already collected (handles end-of-pager repeats)
  const seenLines = new Set<string>(allLines.map(l => l.trim()));
  let prevContent = firstPageContent;
  let prevLines = allLines.slice();

  for (let page = 0; page < maxPages; page++) {
    cliProcess.sendRaw(DOWN_ARROW.repeat(SCROLL_LINES));
    const rawPage = await cliProcess.captureOutput(400, 4_000);
    // Feed raw bytes into the SAME persistent state so differential rendering
    // (pager skipping unchanged cells) is handled correctly.
    renderInto(rawPage, st);
    const screenAfter = extractScreen(st);
    const { content: pageContent, hasPager: stillOpen } = stripPager(screenAfter);

    if (!stillOpen || pageContent === prevContent) {
      break;
    }

    const newLines = pageContent.split("\n").filter(l => l.trim());
    const skipLen = findOverlapLen(prevLines, newLines);
    const added = newLines.slice(skipLen).filter(l => !seenLines.has(l.trim()));
    if (added.length === 0) break;

    added.forEach(l => seenLines.add(l.trim()));
    allLines.push(...added);
    prevLines = newLines;
    prevContent = pageContent;
  }

  // Dismiss the pager
  cliProcess.sendRaw("\x1b");

  return allLines.join("\n");
}

// ── Message Handler ────────────────────────────────────────────────

function wsKey(channelKey: string, wsName: string): string {
  return `${channelKey}:${wsName}`;
}

/** Check whether any composite key starting with `channelKey:` is in the set. */
function anyChannelMatch(set: Set<string>, channelKey: string): boolean {
  for (const key of set) {
    if (key.startsWith(channelKey + ":")) return true;
  }
  return false;
}

export class MessageHandler {
  private options: MessageHandlerOptions;
  /** Composite-key queues: `${channelKey}:${wsName}` → items */
  private channelQueues = new Map<string, QueuedMessage[]>();
  /** Composite-key processing flags */
  private channelProcessing = new Set<string>();
  /** Composite-key cancellation flags */
  private channelCancels = new Set<string>();
  /** Currently processing promises per composite key — used for cancellation */
  private channelActive = new Map<string, { reject: (err: Error) => void }>();
  /** Composite-key callbacks for the currently in-flight prompt (used by user input delegation) */
  private activeCallbacks = new Map<string, MessageCallback>();
  /** sessionId → composite key for the in-flight prompt */
  private sessionChannels = new Map<string, string>();
  /** Composite-key pending user-input resolvers */
  private pendingInput = new Map<string, { resolve: (answer: string) => void }>();
  /** Composite-key hard-timer handles (reset on every session event, paused during ask_user) */
  private hardTimers = new Map<string, NodeJS.Timeout>();
  /** Composite-key hard-timer reject callbacks (paired with hardTimers) */
  private hardTimerRejects = new Map<string, (err: Error) => void>();

  constructor(options: MessageHandlerOptions) {
    this.options = options;
  }

  /**
   * Arm (or re-arm) the 1-hour hard timer for `qKey`. Pauses itself while a
   * pending ask_user is waiting on this qKey — so user response time is
   * unbounded. Called on every session event from processOne.
   */
  private armHardTimer(qKey: string): void {
    this.clearHardTimer(qKey);
    // No timeout while waiting for user input.
    if (this.pendingInput.has(qKey)) return;
    const reject = this.hardTimerRejects.get(qKey);
    if (!reject) return; // no prompt registered a reject for this qKey
    const t = setTimeout(() => {
      this.hardTimers.delete(qKey);
      this.hardTimerRejects.delete(qKey);
      reject(new Error("LLM not responding (1 hour timeout)"));
    }, LLM_HARD_TIMEOUT_MS);
    this.hardTimers.set(qKey, t);
  }

  /** Clear the hard timer for `qKey` if one is set. Does NOT touch the reject. */
  private clearHardTimer(qKey: string): void {
    const t = this.hardTimers.get(qKey);
    if (t) clearTimeout(t);
    this.hardTimers.delete(qKey);
  }

  /** Send a routed message on a channel. Returns when processing completes. */
  async handle(
    routed: RoutedMessage,
    channelKey: string,
    callback: MessageCallback,
  ): Promise<void> {
    // /max:* commands execute immediately — never queue, never block.
    // This lets users switch workspaces / cancel / skip even when
    // another workspace in the same channel is busy.
    if (routed.type === "max-command") {
      const wsName = getActiveWorkspace(channelKey);
      console.log(`[message-handler] Dispatching max-command: /max:${routed.name} ${routed.args.join(" ")}`.trimEnd() + ` → channel=${channelKey} ws=${wsName}`);
      const result = await executeMaxCommand(routed.name, routed.args, {
        senderId: channelKey,
        activeWorkspace: wsName,
        channelKey,
      }).catch((err) => {
        console.error(`[message-handler] max-command failed: /max:${routed.name} ${routed.args.join(" ")} — ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      });
      console.log(`[message-handler] max-command result (${result.reply.length} chars): ${result.reply.slice(0, 120)}`);
      callback(result.reply, true);

      // Enqueue first delegate prompt:
      // - Explicit goal (/max:delegate goal <text>): always enqueue — Copilot doesn't know the goal yet.
      // - Extracted goal (/max:delegate with no args): only enqueue if idle — user was already talking about it.
      if (result.delegateStartPrompt) {
        const qKey = wsKey(channelKey, wsName);
        const canEnqueue = !result.delegateStartOnlyIfIdle || !this.isChannelBusy(channelKey, wsName);
        if (canEnqueue) {
          const queue = this.channelQueues.get(qKey) ?? [];
          queue.push({
            routed: { type: "prompt", text: result.delegateStartPrompt, senderId: channelKey },
            callback,
            resolve: () => {},
            reject: (err: Error) => { console.error(`[delegate] First prompt failed: ${err.message}`); },
          });
          this.channelQueues.set(qKey, queue);
          this.processQueue(qKey, channelKey, wsName);
        }
      }

      return;
    }

    // prompt / cli-command: queue by channelKey + workspace composite key.
    // Different workspaces in the same channel are independent.
    const wsName = getActiveWorkspace(channelKey);
    const qKey = wsKey(channelKey, wsName);

    return new Promise((resolve, reject) => {
      const queue = this.channelQueues.get(qKey) ?? [];
      queue.push({ routed, callback, resolve, reject });
      this.channelQueues.set(qKey, queue);
      this.processQueue(qKey, channelKey, wsName);
    });
  }

  /** Returns true if a channel (optionally scoped to a workspace) has an in-flight message. */
  isChannelBusy(channelKey: string, wsName?: string): boolean {
    if (wsName) {
      return this.channelProcessing.has(wsKey(channelKey, wsName));
    }
    return anyChannelMatch(this.channelProcessing, channelKey);
  }

  /** Returns the number of queued (waiting) messages for a channel+workspace composite key.
   *  Excludes the message currently being processed (channelActive). */
  getQueueLength(channelKey: string, wsName: string): number {
    return this.channelQueues.get(wsKey(channelKey, wsName))?.length ?? 0;
  }

  /**
   * Smart cancel: if there are queued messages waiting, cancel ONLY the queue
   * (the in-flight request keeps running). If the queue is empty, cancel the
   * in-flight request. Returns a summary of what was cancelled, or null if
   * nothing matched.
   *
   * Rejected items get an Error with `silentCancel = true` so callers can
   * tell the difference between an intentional user-initiated cancel
   * (handled with a single reply by /max:cancel) and an unexpected
   * cancellation that should still surface to the user.
   */
  cancelChannel(channelId: string, wsName?: string): { cancelledQueued: number; cancelledActive: boolean } | null {
    const prefix = wsName ? wsKey(channelId, wsName) : `${channelId}:`;
    const match = (key: string) => wsName ? key === prefix : key.startsWith(prefix);

    // Find all matching composite keys
    const targetKeys: string[] = [];
    for (const key of this.channelQueues.keys()) { if (match(key)) targetKeys.push(key); }
    for (const key of this.channelActive.keys()) { if (match(key) && !targetKeys.includes(key)) targetKeys.push(key); }

    if (targetKeys.length === 0) return null;

    let totalQueued = 0;
    let anyActiveCancelled = false;
    const makeCancelledError = () => {
      const e = new Error("Cancelled");
      (e as Error & { silentCancel?: boolean }).silentCancel = true;
      return e;
    };

    for (const key of targetKeys) {
      const queue = this.channelQueues.get(key);
      if (queue && queue.length > 0) {
        // Queue non-empty: cancel queued items only, leave the in-flight request running.
        totalQueued += queue.length;
        for (const item of queue) item.reject(makeCancelledError());
        this.channelQueues.delete(key);
        // Do NOT touch channelCancels / channelActive — in-flight keeps going.
        continue;
      }
      // Queue empty (or absent): cancel the in-flight request.
      this.channelCancels.add(key);
      const active = this.channelActive.get(key);
      if (active) {
        active.reject(makeCancelledError());
        this.channelActive.delete(key);
        anyActiveCancelled = true;
      }
      // Tear down the hard timer / reject pair so it can't fire after cancel.
      this.clearHardTimer(key);
      this.hardTimerRejects.delete(key);
    }

    return { cancelledQueued: totalQueued, cancelledActive: anyActiveCancelled };
  }

  /** Flush all queues (e.g., on shutdown) */
  cancelAll(): void {
    for (const [key, queue] of this.channelQueues) {
      for (const item of queue) {
        item.reject(new Error("Shutting down"));
      }
      this.channelQueues.delete(key);
    }
    this.channelProcessing.clear();
    // Tear down every outstanding hard timer.
    for (const key of Array.from(this.hardTimers.keys())) {
      this.clearHardTimer(key);
      this.hardTimerRejects.delete(key);
    }
  }

  // ── User Input (ask_user) ────────────────────────────────────

  /**
   * Called by copilot-client's onUserInputRequest handler when the LLM
   * asks the user a question. Sends the question to the right channel
   * and returns a Promise that resolves when the user answers.
   */
  async handleUserInput(
    sessionId: string,
    question: string,
    choices?: string[],
    allowFreeform?: boolean,
  ): Promise<string> {
    const compositeKey = this.sessionChannels.get(sessionId);
    const callback = compositeKey ? this.activeCallbacks.get(compositeKey) : undefined;

    if (!compositeKey || !callback) {
      console.warn(`[message-handler] handleUserInput: no active channel for session=${sessionId.slice(0, 8)}… question="${question.slice(0, 80)}"`);
      // No active channel — fallback answer so the conversation continues
      const choiceList = choices ? ` (${choices.join(", ")})` : "";
      return `The user cannot be reached right now. Question was: "${question}"${choiceList}`;
    }

    // Send question to the channel
    callback(
      JSON.stringify({ type: "question", question, choices, allowFreeform }),
      false,
    );

    // Wait for the answer indefinitely until the user responds or the
    // channel cancels the pending ask_user request.
    return new Promise<string>((resolve) => {
      this.pendingInput.set(compositeKey, { resolve });
      // Pause the hard timer — ask_user has no timeout. The timer is
      // re-armed by answerUserInput() once the user responds.
      this.clearHardTimer(compositeKey);
    });
  }

  /**
   * Called by the /answer API endpoint when the user responds to
   * an ask_user question. Resolves the pending Promise in handleUserInput.
   * compositeKey is `${channelKey}:${wsName}`.
   */
  answerUserInput(compositeKey: string, answer: string): boolean {
    const pending = this.pendingInput.get(compositeKey);
    if (!pending) return false;
    this.pendingInput.delete(compositeKey);
    pending.resolve(answer);
    // Resume the hard timer now that the user has answered. The next
    // session event from the LLM continuing the turn will re-arm it.
    this.armHardTimer(compositeKey);
    return true;
  }

  // ── Queue processing ────────────────────────────────────────

  private async processQueue(qKey: string, channelId: string, wsName: string): Promise<void> {
    if (this.channelProcessing.has(qKey)) return;
    this.channelProcessing.add(qKey);

    try {
      const queue = this.channelQueues.get(qKey);
      while (queue && queue.length > 0) {
        // Check cancellation before each item
        if (this.channelCancels.has(qKey)) {
          // Reject remaining items
          for (const item of queue) {
            item.reject(new Error("Cancelled"));
          }
          this.channelQueues.delete(qKey);
          break;
        }

        const item = queue.shift()!;
        try {
          await new Promise<void>((resolve, reject) => {
            this.channelActive.set(qKey, { reject });
            this.processOne(item, channelId, wsName).then(resolve, reject).finally(() => {
              this.channelActive.delete(qKey);
            });
          });
          item.resolve();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/cancelled/i.test(msg)) {
            item.reject(new Error("Cancelled"));
          } else {
            item.reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      }
    } finally {
      this.channelProcessing.delete(qKey);
      this.channelCancels.delete(qKey);
      this.channelActive.delete(qKey);
    }
  }

  private async processOne(item: QueuedMessage, channelId: string, wsName: string): Promise<void> {
    const { routed } = item;
    console.log(`[mh:dbg] processOne ENTER ch=${channelId} ws=${wsName} type=${routed.type}`);
    mhDbg(`processOne ENTER ch=${channelId} ws=${wsName} type=${routed.type} text=${JSON.stringify((routed as any).text?.slice(0, 60))}`);
    // Wrap the channel's callback so every assistant reply (prompt / cli / max
    // command) carries the per-turn workspace tag. The wrapper is a no-op when
    // disabled by config.
    const callback = wrapCallbackWithWorkspaceTag(item.callback, wsName);
    const qKey = wsKey(channelId, wsName);

    switch (routed.type) {
      case "max-command": {
        // Should never reach here — max-commands are handled immediately in handle().
        // Defensive fallback.
        console.log(`[message-handler] Dispatching max-command: /max:${routed.name} ${routed.args.join(" ")}`.trimEnd() + ` → channel=${channelId} ws=${wsName}`);
        const result = await executeMaxCommand(routed.name, routed.args, {
          senderId: channelId,
          activeWorkspace: wsName,
          channelKey: channelId,
        });
        console.log(`[message-handler] max-command result (${result.reply.length} chars): ${result.reply.slice(0, 120)}`);
        callback(result.reply, true);
        break;
      }

      case "prompt": {
        // Mark workspace busy for the entire prompt lifecycle (including
        // retries, session.idle wait, hard timer). Must come before
        // getSessionForChannel so ensurePoolSlot's LRU eviction can see
        // us as busy and won't kick this workspace mid-prompt.
        markPoolBusy(wsName);
        try {
          await this.handleWithRetry(channelId, wsName, async () => {
            const { session, workspaceName, workingDir } = await this.options.getSessionForChannel(channelId, wsName);
            console.log(`[message-handler] Prompt → session ${session.sessionId.slice(0, 8)}… ws=${workspaceName} dir=${workingDir ?? "cwd"} channel=${channelId}`);
            console.log(`[message-handler] Prompt text (${routed.text.length} chars): ${routed.text.slice(0, 200)}`);
  
            // Check model capabilities and filter attachments.
            // Always propagate the warning to the prompt so the LLM can relay
            // it to the user when attachments were stripped (e.g. vision not
            // supported). Without this the warning was silently dropped when
            // every attachment got filtered, and the user only saw a confused
            // "I don't see the image" reply.
            const { filtered: safeAttachments, warning } = await filterAttachments(routed.attachments ?? []);
            const effectivePrompt = warning
              ? routed.text + warning
              : routed.text;
            if (routed.attachments && routed.attachments.length > 0) {
              console.log(`[message-handler] Attachments: ${routed.attachments.length} provided → ${safeAttachments.length} passed (${warning ? "vision not supported" : "all ok"})`);
            }
  
            // Store session→composite-key mapping so handleUserInput can find the right callback
            this.sessionChannels.set(session.sessionId, qKey);
            this.activeCallbacks.set(qKey, callback);
  
            // Debug: log all session events related to tools/permissions/errors
            // Track session.error events so we can report them to the user
            let sessionError: string | null = null;
            const unsubDebug = session.on((event: any) => {
              const t = event?.type ?? "";
              if (t === "session.error") {
                const msg = event?.data?.message ?? event?.message ?? "Unknown session error";
                sessionError = msg;
                // Log the full event data without truncation for debugging SDK-originated errors
                console.log(`[message-handler] Event session.error (full): ${JSON.stringify(event)}`);
              } else if (t.includes("tool") || t.includes("permission") || t.includes("error")) {
                console.log(`[message-handler] Event ${t}: ${JSON.stringify(event).slice(0, 500)}`);
              }
            });
  
            const t0 = Date.now();
            // Hard timer that resets on every session event but pauses while
            // the LLM is blocked on ask_user waiting for the user. There is
            // no "inactivity" timeout — only this 1-hour hard cap.
            let hardTimerWon = false;
            const hardTimerPromise = new Promise<never>((_, reject) => {
              this.hardTimerRejects.set(qKey, (err) => {
                hardTimerWon = true;
                reject(err);
              });
            });
            this.armHardTimer(qKey);
            const unsubReset = session.on(() => this.armHardTimer(qKey));
  
            // Collect every subscription we register so a single try/finally
            // can unsubscribe all of them, regardless of which side of the
            // race wins (idle / send-error / hard-timer / future errors).
            const cleanupFns: Array<() => void> = [unsubReset, unsubDebug];
  
            const fullText = await (async () => {
              try {
                return await Promise.race([
                  new Promise<string>((resolve, reject) => {
                    let fullText = "";
                    const unsubDelta = session.on("assistant.message_delta", (event) => {
                      const chunk = event.data.deltaContent;
                      if (chunk) {
                        fullText += chunk;
                        callback(fullText, false);
                      }
                    });
                    cleanupFns.push(unsubDelta);
  
                    const unsubIdle = session.on("session.idle", () => {
                      if (sessionError) {
                        reject(new Error(sessionError));
                        return;
                      }
                      console.log(`[message-handler] Prompt response (${Date.now() - t0}ms, ${fullText.length} chars): ${fullText.slice(0, 300)}`);
                      callback("", true);
                      resolve(fullText);
                    });
                    cleanupFns.push(unsubIdle);
  
                    const sendPayload: { prompt: string; attachments?: Attachment[] } = { prompt: effectivePrompt };
                    if (safeAttachments.length > 0) {
                      sendPayload.attachments = safeAttachments;
                    }
                    session.send(sendPayload).catch((err: unknown) => {
                      console.error(`[message-handler] Prompt send failed: ${err instanceof Error ? err.message : String(err)}`);
                      reject(err instanceof Error ? err : new Error(String(err)));
                    });
                  }),
                  hardTimerPromise,
                ]);
              } finally {
                // Release every subscription and map entry — success, idle,
                // send-error, hard-timer, or any future failure all go
                // through this single block.
                for (const fn of cleanupFns) {
                  try { fn(); } catch { /* best effort */ }
                }
                this.clearHardTimer(qKey);
                this.hardTimerRejects.delete(qKey);
                this.sessionChannels.delete(session.sessionId);
                this.activeCallbacks.delete(qKey);
  
                // If a stuck ask_user is waiting on this qKey, resolve it
                // with a fallback so the SDK's onUserInputRequest returns
                // and the session isn't permanently blocked.
                const stuck = this.pendingInput.get(qKey);
                if (stuck) {
                  this.pendingInput.delete(qKey);
                  stuck.resolve(ASK_USER_FALLBACK_ANSWER);
                }
  
                // On hard-timer timeout, invalidate the cached Copilot
                // session so the next prompt in this workspace gets a fresh
                // one instead of reusing the half-finished turn.
                if (hardTimerWon) {
                  try {
                    invalidateSession(workspaceName);
                    console.log(`[message-handler] Hard-timer timeout — invalidated Copilot session for ws=${workspaceName}`);
                  } catch (err) {
                    console.warn(`[message-handler] Failed to invalidate session after timeout: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
              }
            })();
        });

        // ── Delegate check (after Copilot responds) ──────────────
        if (config.delegateEnabled && delegateStore.isActive(qKey)) {
          await this.runDelegateOnce(channelId, wsName, qKey, callback);
        }
        } finally {
          markPoolIdle(wsName);
        }
        break;
      }

      case "cli-command": {
        // Mark workspace busy so concurrent cross-workspace activity (in
        // other channels or other qKeys) doesn't LRU-evict this workspace
        // mid-PTY-write. The PTY itself is a single resource — if two
        // cli-commands for DIFFERENT workspaces in the SAME channel run
        // concurrently their PTY outputs interleave. That race is a
        // separate concern; the busy flag here only protects the pool
        // entry, not the PTY.
        markPoolBusy(wsName);
        try {
          console.log(`[message-handler] Dispatching cli-command: ${routed.command.slice(0, 80)} → channel=${channelId}`);
          if (!this.options.cliProcess.isAlive()) {
            console.error(`[message-handler] CLI process not alive for command: ${routed.command.slice(0, 80)}`);
            throw new Error("CLI process is not running");
          }
          try {
            const t0 = Date.now();
            const rawOutput = await this.options.cliProcess.sendCommandAndWait(
              routed.command,
              CLI_COMMAND_TIMEOUT_MS,
              CLI_COMMAND_SETTLE_MS,
            );
            const st = createTerminalState();
            renderInto(rawOutput, st);
            const { content: firstPage, hasPager } = stripPager(extractScreen(st));
            const result = hasPager
              ? await collectPagerContent(this.options.cliProcess, st, firstPage)
              : firstPage;
            console.log(`[message-handler] cli-command response (${Date.now() - t0}ms, ${result.length} chars): ${result.slice(0, 120)}`);
            callback(result || `(command sent: ${routed.command})`, true);
          } catch (err) {
            console.error(`[message-handler] cli-command failed: ${routed.command.slice(0, 80)} — ${err instanceof Error ? err.message : String(err)}`);
            // Timeout or PTY error — still confirm the command was sent
            callback(`→ ${routed.command}\n(${err instanceof Error ? err.message : String(err)})`, true);
          }
        } finally {
          markPoolIdle(wsName);
        }
        break;
      }

      default:
        console.error(`[message-handler] Unknown routed message type: ${(routed as any).type}`);
        throw new Error(`Unknown routed message type: ${(routed as any).type}`);
    }
  }

  /**
   * Run a single delegate check after a Copilot response and enqueue
   * the next prompt if the goal is not yet achieved.
   *
   * The natural processQueue while-loop handles iteration: each enqueued
   * delegate prompt goes through processOne → Copilot responds →
   * delegate check again → loop continues or exits.
   */
  private async runDelegateOnce(
    channelId: string,
    wsName: string,
    qKey: string,
    callback: MessageCallback,
  ): Promise<void> {
    const maxIterations = config.delegateMaxIterations;
    const iterCount = delegateStore.incrementIteration(qKey);
    if (iterCount > maxIterations) {
      console.warn(`[delegate] Max iterations (${maxIterations}) reached for ws=${wsName}`);
      callback("⚠️ Delegate: 已达到最大循环次数，已退出委托模式。", true, { source: "delegate" });
      delegateStore.exit(qKey);
      return;
    }

    const goal = delegateStore.getGoal(qKey);
    if (!goal) return; // delegate exited externally

    const conversation = getRecentConversation(6); // last ~3 user+AI rounds
    const output = await delegateCheck(goal, conversation);
    const lines = output.split("\n");
    const firstLine = lines[0]?.trim() ?? "";
    const rest = lines.slice(1).join("\n").trim();

    if (firstLine === "完成") {
      console.log(`[delegate] Goal achieved for ws=${wsName}: ${rest || goal}`);
      callback(output, true, { source: "delegate" });
      delegateStore.exit(qKey);
      return;
    }

    // "继续" — forward the rest as a prompt to Copilot
    const promptText = rest || "请继续之前的目标。";
    console.log(`[delegate] Enqueuing continue prompt for ws=${wsName}: ${promptText.slice(0, 120)}`);
    callback(output, true, { source: "delegate-prompt" });

    // Enqueue delegate's prompt — processQueue while-loop picks it up
    const queue = this.channelQueues.get(qKey) ?? [];
    queue.push({
      routed: { type: "prompt", text: promptText, senderId: channelId },
      callback,
      resolve: () => {},
      reject: (err: Error) => { console.error(`[delegate] Delegate prompt failed: ${err.message}`); },
    });
    this.channelQueues.set(qKey, queue);
  }

  private async handleWithRetry(
    channelId: string,
    wsName: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    // The actual call-to-response timeout lives inside `fn()` via the
    // inner hard timer (armHardTimer → hardTimerPromise). We do NOT add
    // an outer wall-clock race here — that's the band-aid we removed.
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await fn();
        return;
      } catch (err) {
        // Don't retry cancelled messages
        if (/cancelled|abort/i.test(String(err))) return;

        if (isRecoverable(err) && attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
          console.error(`[message-handler] Recoverable error: ${String(err)}. Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms…`);
          await sleep(delay);
          continue;
        }

        console.error(`[message-handler] Error processing message: ${String(err)}`);
        throw err;
      }
    }
  }
}
