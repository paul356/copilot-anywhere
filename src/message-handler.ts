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
          const clean = stripAnsi(rawOutput);
          console.log(`[message-handler] cli-command response (${Date.now() - t0}ms, ${clean.length} chars): ${clean.slice(0, 120)}`);
          callback(clean || `(command sent: ${routed.command})`, true);
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
