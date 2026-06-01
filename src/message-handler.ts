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
 * Timeout prevents hangs (default 10 min).
 */

import { CopilotSession } from "@github/copilot-sdk";
import { RoutedMessage, executeMaxCommand } from "./command-router.js";
import { CLIProcess } from "./cli-process.js";
import { getActiveWorkspace } from "./store/db.js";

// ── Types ──────────────────────────────────────────────────────────

export type MessageCallback = (text: string, done: boolean) => void;

export interface MessageHandlerOptions {
  port: number;
  getSessionForChannel: (channelId: string) => Promise<{ session: CopilotSession; workspaceName: string; workingDir?: string }>;
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
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const RECOVERABLE_PATTERNS = /connection|EADDR|ECONN|timeout|ENOTFOUND|socket hang up|pipe/i;
const CLI_COMMAND_TIMEOUT_MS = 15_000; // 15s for CLI slash command TUI output
const CLI_COMMAND_SETTLE_MS = 1_500;   // wait 1.5s for TUI to finish rendering

function isRecoverable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RECOVERABLE_PATTERNS.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

export class MessageHandler {
  private options: MessageHandlerOptions;
  private channelQueues = new Map<string, QueuedMessage[]>();
  private channelProcessing = new Set<string>();
  private channelCancels = new Set<string>();
  /** Currently processing promises per channel — used for cancellation */
  private channelActive = new Map<string, { reject: (err: Error) => void }>();
  /** Per-channel callbacks for the currently in-flight prompt (used by user input delegation) */
  private activeCallbacks = new Map<string, MessageCallback>();
  /** sessionId → channelKey for the in-flight prompt */
  private sessionChannels = new Map<string, string>();
  /** Per-channel pending user-input resolvers */
  private pendingInput = new Map<string, { resolve: (answer: string) => void }>();

  constructor(options: MessageHandlerOptions) {
    this.options = options;
  }

  /** Send a routed message on a channel. Returns when processing completes. */
  async handle(
    routed: RoutedMessage,
    channelKey: string,
    callback: MessageCallback,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const queue = this.channelQueues.get(channelKey) ?? [];
      queue.push({ routed, callback, resolve, reject });
      this.channelQueues.set(channelKey, queue);
      this.processQueue(channelKey);
    });
  }

  /** Cancel all in-flight and queued messages for a channel */
  cancelChannel(channelId: string): void {
    this.channelCancels.add(channelId);
    const active = this.channelActive.get(channelId);
    if (active) {
      active.reject(new Error("Cancelled"));
      this.channelActive.delete(channelId);
    }
    // Clear queued items
    const queue = this.channelQueues.get(channelId);
    if (queue) {
      for (const item of queue) {
        item.reject(new Error("Cancelled"));
      }
      this.channelQueues.delete(channelId);
    }
  }

  /** Flush all queues (e.g., on shutdown) */
  cancelAll(): void {
    for (const [channelId, queue] of this.channelQueues) {
      for (const item of queue) {
        item.reject(new Error("Shutting down"));
      }
      this.channelQueues.delete(channelId);
    }
    this.channelProcessing.clear();
  }

  // ── User Input (ask_user) ────────────────────────────────────

  /**
   * Called by copilot-client's onUserInputRequest handler when the LLM
   * asks the user a question. Sends the question to the TUI channel
   * and returns a Promise that resolves when the user answers via
   * the /answer API endpoint.
   */
  async handleUserInput(
    sessionId: string,
    question: string,
    choices?: string[],
    allowFreeform?: boolean,
  ): Promise<string> {
    const channelKey = this.sessionChannels.get(sessionId);
    const callback = channelKey ? this.activeCallbacks.get(channelKey) : undefined;

    if (!channelKey || !callback) {
      // No active channel — fallback answer so the conversation continues
      const choiceList = choices ? ` (${choices.join(", ")})` : "";
      return `The user cannot be reached right now. Question was: "${question}"${choiceList}`;
    }

    // Send question to the channel
    callback(
      JSON.stringify({ type: "question", question, choices, allowFreeform }),
      false,
    );

    // Wait for the answer
    return new Promise<string>((resolve) => {
      this.pendingInput.set(channelKey, { resolve });
      // Timeout after 5 minutes to avoid hanging forever
      setTimeout(() => {
        if (this.pendingInput.has(channelKey)) {
          this.pendingInput.delete(channelKey);
          resolve("(The user did not respond in time.)");
        }
      }, 5 * 60 * 1000);
    });
  }

  /**
   * Called by the /answer API endpoint when the TUI user responds to
   * an ask_user question. Resolves the pending Promise in handleUserInput.
   */
  answerUserInput(channelKey: string, answer: string): boolean {
    const pending = this.pendingInput.get(channelKey);
    if (!pending) return false;
    this.pendingInput.delete(channelKey);
    pending.resolve(answer);
    return true;
  }

  // ── Queue processing ────────────────────────────────────────

  private async processQueue(channelId: string): Promise<void> {
    if (this.channelProcessing.has(channelId)) return;
    this.channelProcessing.add(channelId);

    try {
      const queue = this.channelQueues.get(channelId);
      while (queue && queue.length > 0) {
        // Check cancellation before each item
        if (this.channelCancels.has(channelId)) {
          // Reject remaining items
          for (const item of queue) {
            item.reject(new Error("Cancelled"));
          }
          this.channelQueues.delete(channelId);
          break;
        }

        const item = queue.shift()!;
        try {
          await new Promise<void>((resolve, reject) => {
            this.channelActive.set(channelId, { reject });
            this.processOne(item, channelId).then(resolve, reject).finally(() => {
              this.channelActive.delete(channelId);
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
      this.channelProcessing.delete(channelId);
      this.channelCancels.delete(channelId);
      this.channelActive.delete(channelId);
    }
  }

  private async processOne(item: QueuedMessage, channelId: string): Promise<void> {
    const { routed, callback } = item;

    switch (routed.type) {
      case "max-command": {
        console.log(`[message-handler] Dispatching max-command: /max:${routed.name} ${routed.args.join(" ")}`.trimEnd() + ` → channel=${channelId}`);
        const wsName = getActiveWorkspace(channelId);
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
        await this.handleWithRetry(channelId, async () => {
          const { session, workspaceName, workingDir } = await this.options.getSessionForChannel(channelId);
          console.log(`[message-handler] Prompt → session ${session.sessionId.slice(0, 8)}… ws=${workspaceName} dir=${workingDir ?? "cwd"} channel=${channelId}`);
          console.log(`[message-handler] Prompt text (${routed.text.length} chars): ${routed.text.slice(0, 200)}`);

          // Store session→channel mapping so handleUserInput can find the right callback
          this.sessionChannels.set(session.sessionId, channelId);
          this.activeCallbacks.set(channelId, callback);

          // Debug: log all session events related to tools/permissions/errors
          const unsubDebug = session.on((event: any) => {
            const t = event?.type ?? "";
            if (t.includes("tool") || t.includes("permission") || t.includes("error") || t.includes("session.error")) {
              console.log(`[message-handler] Event ${t}: ${JSON.stringify(event).slice(0, 500)}`);
            }
          });

          const t0 = Date.now();
          const fullText = await new Promise<string>((resolve, reject) => {
            let fullText = "";
            const unsubDelta = session.on("assistant.message_delta", (event) => {
              const chunk = event.data.deltaContent;
              if (chunk) {
                fullText += chunk;
                callback(fullText, false);
              }
            });
            const unsubIdle = session.on("session.idle", () => {
              unsubDelta();
              unsubIdle();
              unsubDebug();
              this.sessionChannels.delete(session.sessionId);
              this.activeCallbacks.delete(channelId);
              console.log(`[message-handler] Prompt response (${Date.now() - t0}ms, ${fullText.length} chars): ${fullText.slice(0, 300)}`);
              callback("", true);
              resolve(fullText);
            });

            session.send({ prompt: routed.text }).catch((err: unknown) => {
              unsubDelta();
              unsubIdle();
              unsubDebug();
              this.sessionChannels.delete(session.sessionId);
              this.activeCallbacks.delete(channelId);
              console.error(`[message-handler] Prompt send failed: ${err instanceof Error ? err.message : String(err)}`);
              reject(err instanceof Error ? err : new Error(String(err)));
            });
          });
        });
        break;
      }

      case "cli-command": {
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
        break;
      }

      default:
        throw new Error(`Unknown routed message type: ${(routed as any).type}`);
    }
  }

  private async handleWithRetry(
    channelId: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const timeout = this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
        await Promise.race([
          fn(),
          sleep(timeout).then(() => { throw new Error("Message processing timed out"); }),
        ]);
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
