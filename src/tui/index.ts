import { readMultiline } from "@toiroakr/read-multiline";
import * as http from "http";
import { exec, execFile } from "child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { HISTORY_PATH, API_TOKEN_PATH, TUI_DEBUG_LOG_PATH, ensureMaxHome } from "../paths.js";
import type { Attachment } from "../command-router.js";

const API_BASE = process.env.MAX_API_URL || "http://127.0.0.1:7777";

// Load API auth token (if it exists)
let apiToken: string | null = null;
try {
  if (existsSync(API_TOKEN_PATH)) {
    apiToken = readFileSync(API_TOKEN_PATH, "utf-8").trim();
  }
} catch {
  console.error("Warning: Could not read API token from " + API_TOKEN_PATH + " — requests may fail.");
}

function authHeaders(): Record<string, string> {
  return apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
}

// ── ANSI helpers ──────────────────────────────────────────
const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  boldCyan: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
  bgDim: (s: string) => `\x1b[48;5;236m${s}\x1b[0m`,
  coral: (s: string) => `\x1b[38;2;255;127;80m${s}\x1b[0m`,
  boldWhite: (s: string) => `\x1b[1;97m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[38;2;14;165;233m${s}\x1b[0m`,
};

// ── Layout constants ─────────────────────────────────────
const LABEL_PAD = "          "; // 10-char indent for continuation lines
const MAX_LABEL = `  ${C.cyan("MAX")}     `;
const TUI_DEBUG_ENABLED = /^(1|true|yes|on)$/i.test((process.env.MAX_TUI_DEBUG || "").trim());
let debugWriteFailureReported = false;

function previewForDebug(text: string, max = 120): string {
  return text
    .slice(0, max)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

function debugLog(event: string, data: Record<string, unknown> = {}): void {
  if (!TUI_DEBUG_ENABLED) return;
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...data,
  };
  try {
    appendFileSync(TUI_DEBUG_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    if (debugWriteFailureReported) return;
    debugWriteFailureReported = true;
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n[max] failed to write TUI debug log: ${msg}\n`);
  }
}

// ── Markdown → ANSI rendering ────────────────────────────

/** Render a single line of markdown to ANSI (used by both streaming and batch). */
function renderLine(line: string, inCodeBlock: boolean): string {
  if (inCodeBlock) {
    return `  ${C.dim("│")} ${line}`;
  }
  if (/^[-*_]{3,}\s*$/.test(line)) return C.dim("──────────────────────────────────");
  if (line.startsWith("### ")) return C.coral(line.slice(4));
  if (line.startsWith("## ")) return C.boldWhite(line.slice(3));
  if (line.startsWith("# ")) return C.boldWhite(line.slice(2));
  if (line.startsWith("> ")) return `${C.dim("│")} ${C.dim(line.slice(2))}`;
  if (/^ {2,}[-*] /.test(line)) return `    ◦ ${line.replace(/^ +[-*] /, "")}`;
  if (/^[-*] /.test(line)) return `  • ${line.slice(2)}`;
  if (/^\d+\. /.test(line)) return `  ${line}`;
  return line;
}

/** Apply inline formatting (bold, code, links, etc.) to already-rendered text. */
function applyInlineFormatting(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, `\x1b[1;3m$1\x1b[0m`)
    .replace(/\*\*(.+?)\*\*/g, `\x1b[1m$1\x1b[0m`)
    .replace(/~~(.+?)~~/g, `\x1b[9m$1\x1b[0m`)
    .replace(/`([^`]+)`/g, C.yellow("$1"))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => `${t} ${C.dim(`(${u})`)}`);
}

/** Strip ANSI escape sequences to measure visible text width. */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Get the visual column width of a single character (CJK/Hangul = 2, others = 1). */
function getCharVisualWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115F) ||
    (code >= 0x2E80 && code <= 0x303E) ||
    (code >= 0x3040 && code <= 0x33FF) ||
    (code >= 0x3400 && code <= 0x4DBF) ||
    (code >= 0x4E00 && code <= 0x9FFF) ||
    (code >= 0xA000 && code <= 0xA4CF) ||
    (code >= 0xAC00 && code <= 0xD7AF) ||
    (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0xFE10 && code <= 0xFE1F) ||
    (code >= 0xFE30 && code <= 0xFE4F) ||
    (code >= 0xFF00 && code <= 0xFF60) ||
    (code >= 0xFFE0 && code <= 0xFFE6)
  ) {
    return 2;
  }
  return 1;
}

/** Get the total visual column width of a string, accounting for CJK double-width characters. */
function getVisualWidth(str: string): number {
  const plain = str.replace(/\x1b\[[0-9;]*m/g, "");
  let width = 0;
  for (const char of plain) width += getCharVisualWidth(char);
  return width;
}

/** Wrap ANSI-formatted text at word boundaries to fit within maxWidth visible columns. */
function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0 || getVisualWidth(text) <= maxWidth) return [text];

  const RESET = "\x1b[0m";
  const lines: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (getVisualWidth(remaining) <= maxWidth) {
      lines.push(remaining);
      break;
    }

    let visCount = 0;
    let i = 0;
    let lastSpaceI = -1;
    const ansiStack: string[] = [];
    let ansiAtSpace: string[] = [];

    while (i < remaining.length && visCount < maxWidth) {
      const match = remaining.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        if (match[0] === RESET) ansiStack.length = 0;
        else ansiStack.push(match[0]);
        i += match[0].length;
      } else {
        if (remaining[i] === " ") {
          lastSpaceI = i;
          ansiAtSpace = [...ansiStack];
        }
        visCount += getCharVisualWidth(remaining[i]);
        i++;
      }
    }

    let breakI: number;
    let openAnsi: string[];
    if (lastSpaceI > 0) {
      breakI = lastSpaceI;
      openAnsi = ansiAtSpace;
    } else {
      breakI = i;
      openAnsi = [...ansiStack];
    }

    let line = remaining.slice(0, breakI);
    remaining = remaining.slice(breakI + (remaining[breakI] === " " ? 1 : 0));

    if (openAnsi.length > 0) {
      line += RESET;
      if (remaining.length > 0) remaining = openAnsi.join("") + remaining;
    }

    lines.push(line);
  }

  return lines;
}

/** Render a complete markdown document to ANSI (used for proactive/background messages). */
function renderMarkdown(text: string): string {
  let inCodeBlock = false;
  const rendered = text.split("\n").map((line: string) => {
    if (/^```/.test(line)) {
      if (inCodeBlock) { inCodeBlock = false; return ""; }
      inCodeBlock = true;
      const lang = line.slice(3).trim();
      return lang ? C.dim(lang) : "";
    }
    return renderLine(line, inCodeBlock);
  });
  return applyInlineFormatting(rendered.join("\n"));
}

/** Write a rendered message with a role label (MAX/SYS). */
function writeLabeled(role: "max" | "sys", text: string): void {
  const label = role === "max"
    ? MAX_LABEL
    : `  ${C.dim("SYS")}     `;
  const availWidth = (process.stdout.columns || 80) - 10;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const prefix = i === 0 ? label : LABEL_PAD;
    const isCodeLine = stripAnsi(lines[i]).startsWith("  \u2502 ");
    if (isCodeLine) {
      process.stdout.write(prefix + lines[i] + "\n");
    } else {
      const wrapped = wrapText(lines[i], availWidth);
      process.stdout.write(prefix + wrapped.join("\n" + LABEL_PAD) + "\n");
    }
  }
}

// ── Streaming markdown renderer ──────────────────────────
let streamLineBuffer = "";
let inStreamCodeBlock = false;
let streamIsFirstLine = true;

/** Get the prefix for the current stream line (label or padding). */
function streamPrefix(): string {
  return streamIsFirstLine ? MAX_LABEL : LABEL_PAD;
}

function stripLeadingStreamNewlines(text: string): string {
  if (!streamIsFirstLine || streamLineBuffer.length > 0) return text;
  const stripped = text.replace(/^(?:\r?\n)+/, "");
  if (stripped.length !== text.length) {
    debugLog("stream-strip-leading-newlines", {
      requestId: activeRequestId,
      removedChars: text.length - stripped.length,
      originalPreview: previewForDebug(text),
    });
  }
  return stripped;
}

/** Clear the current visual line (handles terminal wrapping). */
function clearVisualLine(charCount: number): void {
  const cols = process.stdout.columns || 80;
  const up = Math.ceil(Math.max(charCount, 1) / cols) - 1;
  debugLog("clear-visual-line", { requestId: activeRequestId, charCount, cols, up });
  if (up > 0) process.stdout.write(`\x1b[${up}A`);
  process.stdout.write(`\r\x1b[J`);
}

/** Render a buffered line and write it with the appropriate prefix. */
function writeRenderedStreamLine(line: string): void {
  const prefix = streamPrefix();
  if (/^```/.test(line)) {
    if (inStreamCodeBlock) {
      inStreamCodeBlock = false;
    } else {
      inStreamCodeBlock = true;
      const lang = line.slice(3).trim();
      process.stdout.write(prefix + (lang ? C.dim(lang) : ""));
    }
  } else {
    const rendered = applyInlineFormatting(renderLine(line, inStreamCodeBlock));
    if (inStreamCodeBlock) {
      process.stdout.write(prefix + rendered);
    } else {
      const availWidth = (process.stdout.columns || 80) - 10;
      const wrapped = wrapText(rendered, availWidth);
      process.stdout.write(prefix + wrapped.join("\n" + LABEL_PAD));
    }
  }
  process.stdout.write("\n");
  streamIsFirstLine = false;
}

/** Process a chunk of streaming text, rendering complete lines with labels. */
function writeStreamChunk(newText: string): void {
  debugLog("stream-chunk", {
    requestId: activeRequestId,
    length: newText.length,
    preview: previewForDebug(newText),
    startsWithNewline: /^(?:\r?\n)/.test(newText),
  });
  let pos = 0;
  while (pos < newText.length) {
    const nl = newText.indexOf("\n", pos);

    if (nl === -1) {
      // No newline — buffer and write raw with prefix if at line start
      const partial = newText.slice(pos);
      if (streamLineBuffer.length === 0) {
        process.stdout.write(streamPrefix());
      }
      streamLineBuffer += partial;
      process.stdout.write(partial);
      return;
    }

    // Got a complete line
    const segment = newText.slice(pos, nl);
    const hadPartial = streamLineBuffer.length > 0;
    streamLineBuffer += segment;

    if (hadPartial) {
      // Clear the partially-written raw text (use visual width for CJK double-width chars)
      clearVisualLine(10 + getVisualWidth(streamLineBuffer));
    }

    if (streamLineBuffer.length === 0 && !hadPartial) {
      // Empty line
      process.stdout.write(streamPrefix() + "\n");
      streamIsFirstLine = false;
    } else {
      writeRenderedStreamLine(streamLineBuffer);
    }

    streamLineBuffer = "";
    pos = nl + 1;
  }
}

/** Flush any remaining partial line and reset streaming state. */
function flushStreamState(): void {
  if (streamLineBuffer.length > 0) {
    clearVisualLine(10 + getVisualWidth(streamLineBuffer));
    writeRenderedStreamLine(streamLineBuffer);
  }
  streamLineBuffer = "";
  inStreamCodeBlock = false;
  streamIsFirstLine = true;
}

// ── Thinking indicator ────────────────────────────────────
let thinkingTimer: ReturnType<typeof setInterval> | undefined;
let thinkingFrame = 0;
let thinkingVisible = false;
const thinkingFrames = ["Thinking", "Thinking.", "Thinking..", "Thinking..."];

function startThinking(): void {
  stopThinking("restart-thinking");
  thinkingFrame = 0;
  thinkingVisible = true;
  isThinking = true;
  // Write thinking on its own line; cursor sits on the blank line below.
  // No prompt is shown and input is blocked (isThinking flag) until stopThinking.
  process.stdout.write(`\n${MAX_LABEL}${C.dim(thinkingFrames[0])}\n`);
  debugLog("thinking-start", {
    requestId: activeRequestId,
    frame: thinkingFrames[0],
    msSinceSubmit: activeRequestStartedAt > 0 ? Date.now() - activeRequestStartedAt : null,
  });
  thinkingTimer = setInterval(() => {
    thinkingFrame = (thinkingFrame + 1) % thinkingFrames.length;
    // Go up to the Thinking line, rewrite it, come back down.
    process.stdout.write(
      `\x1b[1A\r\x1b[2K${MAX_LABEL}${C.dim(thinkingFrames[thinkingFrame])}\n`,
    );
    debugLog("thinking-tick", {
      requestId: activeRequestId,
      frameIndex: thinkingFrame,
      frame: thinkingFrames[thinkingFrame],
    });
  }, 400);
}

function stopThinking(reason = "unspecified"): void {
  const hadTimer = Boolean(thinkingTimer);
  const wasVisible = thinkingVisible;
  if (thinkingTimer) {
    clearInterval(thinkingTimer);
    thinkingTimer = undefined;
  }
  if (thinkingVisible) {
    // Cursor is on the line below thinking; go up one line and clear to end of screen.
    process.stdout.write(`\x1b[1A\r\x1b[J`);
    thinkingVisible = false;
  }
  isThinking = false;
  debugLog("thinking-stop", {
    requestId: activeRequestId,
    reason,
    hadTimer,
    wasVisible,
  });
}

// ── State ─────────────────────────────────────────────────
let connectionId: string | undefined;
let isStreaming = false;
let isThinking = false;
let streamedContent = "";
let lastResponse = "";
let activeRequestId = 0;
let activeRequestStartedAt = 0;

// ── Persistent history ────────────────────────────────────
const MAX_HISTORY = 1000;

function saveHistoryLine(line: string): void {
  try {
    appendFileSync(HISTORY_PATH, line + "\n");
  } catch { /* ignore */ }
}

function trimHistoryFile(): void {
  try {
    if (!existsSync(HISTORY_PATH)) return;
    const lines = readFileSync(HISTORY_PATH, "utf-8").split("\n").filter(Boolean);
    if (lines.length > MAX_HISTORY) {
      writeFileSync(HISTORY_PATH, lines.slice(-MAX_HISTORY).join("\n") + "\n");
    }
  } catch { /* ignore */ }
}

// ── Readline setup ────────────────────────────────────────
ensureMaxHome();
debugLog("session-start", {
  pid: process.pid,
  cwd: process.cwd(),
  stdinIsTTY: Boolean(process.stdin.isTTY),
  stdoutIsTTY: Boolean(process.stdout.isTTY),
  columns: process.stdout.columns || null,
  logPath: TUI_DEBUG_LOG_PATH,
});

// Resolver to trigger the next readMultiline call after a response finishes.
let resolveNextPrompt: (() => void) | null = null;

// ── Welcome banner ────────────────────────────────────────
function showBanner(): void {
  console.clear();
  console.log();
  console.log();
  console.log(C.boldWhite("    ██      ██     █████     ██   ██"));
  console.log(C.boldWhite("    ███    ███    ██   ██     ██ ██"));
  console.log(C.boldWhite("    ██ ████ ██    ███████      ███"));
  console.log(C.boldWhite("    ██  ██  ██    ██   ██     ██ ██"));
  console.log(C.boldWhite("    ██      ██    ██   ██    ██   ██") + "  " + C.coral("●"));
  console.log();
  console.log(C.dim("    personal AI assistant for developers"));
  console.log();
}

function showStatus(model?: string, skillCount?: number): void {
  const parts: string[] = [];
  if (model) parts.push(`${C.dim("model:")} ${C.cyan(model)}`);
  if (skillCount !== undefined) parts.push(`${C.dim("skills:")} ${C.cyan(String(skillCount))}`);
  if (parts.length) console.log(`    ${parts.join("    ")}`);
  console.log();
}

function fetchStartupInfo(): void {
  let model = "unknown";
  let skillCount = 0;
  let done = 0;
  const check = () => {
    done++;
    if (done === 2) showStatus(model, skillCount);
  };

  apiGetSilent("/model", (data: any) => { model = data?.model || "unknown"; check(); });
  apiGetSilent("/skills", (data: any) => { skillCount = Array.isArray(data) ? data.length : 0; check(); });
}

// ── SSE connection ────────────────────────────────────────
function connectSSE(): void {
  const url = new URL("/stream", API_BASE);

  http.get(url, { headers: authHeaders() }, (res) => {
    console.log(C.green("  ● ") + C.dim("max — connected"));
    fetchStartupInfo();
    let buffer = "";

    res.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6));

            if (event.type === "connected") {
              connectionId = event.connectionId;
              debugLog("sse-connected", { connectionId });
            } else if (event.type === "delta") {
              const full = event.content || "";
              const baseLength = isStreaming ? streamedContent.length : 0;
              if (!isStreaming) {
                stopThinking("first-delta");
                isStreaming = true;
                streamedContent = "";
                streamLineBuffer = "";
                inStreamCodeBlock = false;
                streamIsFirstLine = true;
                debugLog("stream-first-delta", {
                  requestId: activeRequestId,
                  msSinceSubmit: activeRequestStartedAt > 0 ? Date.now() - activeRequestStartedAt : null,
                  fullLength: full.length,
                  newLength: full.length,
                  startsWithNewline: /^(?:\r?\n)/.test(full),
                });
              }
              // Content is cumulative — only print the new part
              const newText = full.slice(baseLength);
              if (newText) {
                const normalized = stripLeadingStreamNewlines(newText);
                debugLog("stream-delta", {
                  requestId: activeRequestId,
                  fullLength: full.length,
                  rawLength: newText.length,
                  normalizedLength: normalized.length,
                  preview: previewForDebug(normalized),
                });
                if (normalized) writeStreamChunk(normalized);
                streamedContent = full;
              }
            } else if (event.type === "cancelled") {
              stopThinking("cancelled-event");
              isStreaming = false;
              streamedContent = "";
              streamLineBuffer = "";
              inStreamCodeBlock = false;
              streamIsFirstLine = true;
            } else if (event.type === "question") {
              // LLM is asking the user a question via ask_user
              stopThinking("question-event");
              isStreaming = false;
              streamedContent = "";
              streamLineBuffer = "";
              inStreamCodeBlock = false;
              streamIsFirstLine = true;

              process.stdout.write("\n");
              process.stdout.write(`  ${C.yellow("💬")} ${C.bold(event.question)}\n`);
              if (Array.isArray(event.choices) && event.choices.length > 0) {
                event.choices.forEach((c: string, i: number) => {
                  process.stdout.write(`  ${C.dim(`${i + 1}.`)} ${c}\n`);
                });
                const hint = event.allowFreeform !== false
                  ? `  ${C.dim("(type a number, or anything else for a custom answer)")}\n`
                  : `  ${C.dim("(type a number to choose)")}\n`;
                process.stdout.write(hint);
              }
              process.stdout.write("\n");

              // Collect user answer (one-shot, not a regular prompt)
              readMultiline(`  ${C.yellow("›")} `, { prefix: "", helpFooter: false, inlinePrompt: true }).then(([answer]: [string, any]) => {
                const trimmed = answer.trim();
                let resolved = trimmed;
                // If choices provided and user typed a number, resolve to the choice text
                if (Array.isArray(event.choices) && /^\d+$/.test(trimmed)) {
                  const idx = parseInt(trimmed, 10) - 1;
                  if (idx >= 0 && idx < event.choices.length) {
                    resolved = event.choices[idx];
                  }
                }
                debugLog("question-answered", { question: event.question, answer: resolved });
                sendAnswer(resolved);
              });
            } else if (event.type === "message") {
              debugLog("stream-message", {
                requestId: activeRequestId,
                isStreaming,
                contentLength: typeof event.content === "string" ? event.content.length : 0,
              });
              if (isStreaming) {
                // Streaming is done — flush remaining and re-prompt
                flushStreamState();
                isStreaming = false;
                lastResponse = streamedContent;
                streamedContent = "";
                process.stdout.write("\n\n\n");
              } else {
                // Proactive/background message — render with label
                stopThinking("message-event");
                lastResponse = event.content;
                const rendered = renderMarkdown(event.content);
                process.stdout.write("\n");
                writeLabeled("max", rendered);
                process.stdout.write("\n\n");
              }
              activeRequestStartedAt = 0;
              // Signal the REPL loop to show the next prompt
              if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
            }
          } catch (err) {
            debugLog("sse-event-parse-error", {
              linePreview: previewForDebug(line),
              error: err instanceof Error ? err.message : String(err),
            });
            // Malformed event, ignore
          }
        }
      }
    });

    res.on("end", () => {
      stopThinking("sse-end");
      debugLog("sse-end");
      console.log(C.yellow("\n    ⚠ disconnected — reconnecting..."));
      isStreaming = false;
      streamedContent = "";
      setTimeout(connectSSE, 2000);
    });

    res.on("error", (err) => {
      stopThinking("sse-error");
      debugLog("sse-error", { error: err.message });
      console.error(C.red(`\n    ✗ connection error — retrying...`));
      isStreaming = false;
      streamedContent = "";
      setTimeout(connectSSE, 3000);
    });
  }).on("error", (err) => {
    debugLog("sse-connect-error", { error: err.message });
    console.error(C.red(`    ✗ cannot connect to daemon`));
    console.error(C.dim("      start with: max start"));
    setTimeout(connectSSE, 5000);
  });
}

// ── API helpers ───────────────────────────────────────────
function sendMessage(prompt: string, requestId: number, attachments?: Attachment[]): void {
  const body = JSON.stringify({ prompt, connectionId, attachments });
  const url = new URL("/message", API_BASE);
  debugLog("message-send-start", {
    requestId,
    promptLength: prompt.length,
    attachmentCount: attachments?.length ?? 0,
    connectionId: connectionId || null,
  });

  const req = http.request(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...authHeaders(),
      },
    },
    (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        debugLog("message-send-end", {
          requestId,
          statusCode: res.statusCode || null,
          responseLength: data.length,
          responsePreview: previewForDebug(data),
        });
        if (res.statusCode !== 200) {
          stopThinking("message-post-error");
          console.error(C.red(`  Error: ${data}`));
          if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
        }
      });
    }
  );

  req.on("error", (err) => {
    stopThinking("message-request-error");
    debugLog("message-send-error", { requestId, error: err.message });
    console.error(C.red(`  Failed to send: ${err.message}`));
    if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
  });

  req.write(body);
  req.end();
  debugLog("message-send-dispatched", { requestId, byteLength: Buffer.byteLength(body) });
}

/** Silent GET — no re-prompt (used for startup info) */
function apiGetSilent(path: string, cb: (data: any) => void): void {
  const url = new URL(path, API_BASE);
  http.get(url, { headers: authHeaders() }, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try { cb(JSON.parse(data)); } catch { /* ignore */ }
    });
  }).on("error", () => { cb(null); });
}

/** GET a JSON endpoint and call back with parsed result. */
function apiGet(path: string, cb: (data: any) => void): void {
  const url = new URL(path, API_BASE);
  http.get(url, { headers: authHeaders() }, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try { cb(JSON.parse(data)); } catch { console.log(data); }
      if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
    });
  }).on("error", (err) => {
    console.error(C.red(`  Error: ${err.message}`));
    if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
  });
}

/** POST a JSON endpoint and call back with parsed result. */
function apiPost(path: string, body: Record<string, unknown>, cb: (data: any) => void): void {
  const json = JSON.stringify(body);
  const url = new URL(path, API_BASE);
  const req = http.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json), ...authHeaders() },
  }, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try { cb(JSON.parse(data)); } catch { console.log(data); }
      if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
    });
  });
  req.on("error", (err) => {
    console.error(C.red(`  Error: ${err.message}`));
    if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
  });
  req.write(json);
  req.end();
}

/** DELETE an endpoint and call back with parsed result. */
function apiDelete(path: string, cb: (data: any) => void): void {
  const url = new URL(path, API_BASE);
  const req = http.request(url, {
    method: "DELETE",
    headers: authHeaders(),
  }, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try { cb(JSON.parse(data)); } catch { console.log(data); }
      if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
    });
  });
  req.on("error", (err) => {
    console.error(C.red(`  Error: ${err.message}`));
    if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
  });
  req.end();
}

/** POST an answer to an ask_user question from the LLM. */
function sendAnswer(answer: string): void {
  debugLog("answer-send", { connectionId, answerLength: answer.length });
  if (!connectionId) {
    console.error(C.red("  Failed to answer: not connected.\n"));
    if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
    return;
  }
  const json = JSON.stringify({ connectionId, answer });
  const url = new URL("/answer", API_BASE);
  const req = http.request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
      ...authHeaders(),
    },
  }, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try {
        const result = JSON.parse(data);
        if (!result.ok) {
          console.error(C.red(`  Failed to send answer: no pending question.\n`));
        }
      } catch { /* ignore */ }
      debugLog("answer-sent", { ok: true });
      // resolveNextPrompt is called by the message event handler after streaming completes
    });
  });
  req.on("error", (err) => {
    console.error(C.red(`  Failed to send answer: ${err.message}\n`));
    if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; } // Restore prompt on error — LLM will timeout without the answer
  });
  req.write(json);
  req.end();
}

function sendCancel(): void {
  stopThinking("user-cancel");
  debugLog("cancel-send", { requestId: activeRequestId, isStreaming });
  if (!connectionId) {
    console.error(C.red("  Failed to cancel: not connected."));
    if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
    return;
  }
  const json = JSON.stringify({ connectionId });
  const url = new URL("/cancel", API_BASE);
  const req = http.request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
      ...authHeaders(),
    },
  }, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      if (isStreaming) process.stdout.write("\n");
      isStreaming = false;
      streamedContent = "";
      console.log(C.dim("    ⛔ cancelled\n"));
      if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
    });
  });
  req.on("error", (err) => {
    console.error(C.red(`  Failed to cancel: ${err.message}`));
    if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
  });
  req.write(json);
  req.end();
}

// ── Command handlers ──────────────────────────────────────
function cmdHelp(): void {
  console.log();
  console.log(C.boldWhite("    MAX COMMANDS"));
  console.log();
  console.log(`    ${C.coral("/max:help")}              show this help`);
  console.log(`    ${C.coral("/max:copy")}              copy last response`);
  console.log(`    ${C.coral("/max:image <path>")}      send an image to the model`);
  console.log(`    ${C.coral("/max:restart")}           restart daemon`);
  console.log(`    ${C.coral("/max:clear")}             clear Max conversation and screen`);
  console.log(`    ${C.coral("/quit")}  ${C.coral("/exit")}          exit`);
  console.log();
  console.log(C.dim("    enter=submit  alt+enter=newline  esc=cancel"));
  console.log(C.dim("    all other /commands are forwarded to Copilot"));
  console.log(C.dim("    press escape to cancel a running response"));
  console.log(C.dim("    set MAX_TUI_DEBUG=1 to write lifecycle logs to ~/.max/tui-debug.log"));
  console.log();
}

// ── Input processor (called when user submits a line) ──
function processUserInput(trimmed: string): void {
    if (isThinking) {
      if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
      return;
    }
    if (!trimmed) {
      debugLog("input-empty-line");
      if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
      return;
    }
    debugLog("input-line", {
      length: trimmed.length,
      isCommand: trimmed.startsWith("/"),
      preview: previewForDebug(trimmed),
    });

    // Save to persistent history (skip commands)
    if (!trimmed.startsWith("/")) {
      saveHistoryLine(trimmed);

      // Re-echo user input with YOU label, accounting for terminal wrapping
      const cols = process.stdout.columns || 80;
      const promptVisualLen = 4; // "  › " is 4 visible chars
      const inputVisualLen = promptVisualLen + trimmed.length;
      const wrappedLines = Math.ceil(Math.max(inputVisualLen, 1) / cols);
      // Move up enough lines to cover all wrapped lines
      if (wrappedLines > 1) {
        process.stdout.write(`\x1b[${wrappedLines}A\r\x1b[J`);
      } else {
        process.stdout.write(`\x1b[1A\r\x1b[J`);
      }

      // Print with YOU label, wrapping long text with LABEL_PAD
      const label = `  ${C.coral("YOU")}     `;
      const contentWidth = cols - 10; // 10 = label visual width
      if (contentWidth > 0 && trimmed.length > contentWidth) {
        const lines: string[] = [];
        for (let i = 0; i < trimmed.length; i += contentWidth) {
          lines.push(trimmed.slice(i, i + contentWidth));
        }
        for (let i = 0; i < lines.length; i++) {
          console.log((i === 0 ? label : LABEL_PAD) + lines[i]);
        }
      } else {
        console.log(label + trimmed);
      }
      debugLog("input-rendered-you-label", {
        columns: cols,
        wrappedLines,
        contentWidth,
      });
    }

    if (trimmed === "/quit" || trimmed === "/exit" || trimmed === "/max:quit" || trimmed === "/max:exit") {
      trimHistoryFile();
      console.log(C.dim("\n    bye.\n"));
      process.exit(0);
    }

    if (trimmed === "/max:help") { cmdHelp(); if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; } return; }

    if (trimmed === "/max:restart") {
      apiPost("/restart", {}, () => {
        console.log(C.yellow("  ⏳ Max is restarting...\n"));
      });
      return;
    }

    if (trimmed === "/max:clear") {
      // Send to daemon to actually clear the SDK session. The
      // previous local `console.clear()` was a stub — the SDK
      // session stayed alive and the LLM still saw all 23 turns
      // on the next prompt. Daemon's `clear` handler calls
      // `destroyAndInvalidateSession`; response comes back via
      // SSE in the `message` event.
      //
      // We also clear the visible TUI screen so the user gets the
      // "fresh slate" UX that terminal users expect. Chat channels
      // don't need this because they have no terminal to clear.
      // console.clear() runs first so the user doesn't see the old
      // chat history while waiting for the daemon's response.
      console.clear();
      activeRequestId += 1;
      activeRequestStartedAt = Date.now();
      startThinking();
      sendMessage("/max:clear", activeRequestId);
      return;
    }

    if (trimmed === "/max:copy") {
      if (!lastResponse) {
        console.log(C.dim("  No response to copy.\n"));
        if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
        return;
      }
      const tryClipboard = (cmds: [string, string[]][], idx: number) => {
        if (idx >= cmds.length) {
          console.log(C.dim("  Clipboard tool not found (install xclip or xsel).\n"));
          if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
          return;
        }
        const [cmd, args] = cmds[idx];
        const proc = execFile(cmd, args, (err: Error | null) => {
          if (err) {
            tryClipboard(cmds, idx + 1);
          } else {
            console.log(C.dim("  ✓ Copied to clipboard.\n"));
            if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
          }
        });
        proc.stdin?.write(lastResponse);
        proc.stdin?.end();
      };
      tryClipboard([
        ["pbcopy", []],
        ["xclip", ["-selection", "clipboard"]],
        ["xsel", ["--clipboard", "--input"]],
      ], 0);
      return;
    }

    // ── /max:image <path> [prompt] ──────────────────────────
    if (trimmed.startsWith("/max:image ")) {
      const rest = trimmed.slice("/max:image ".length).trim();
      if (!rest) {
        console.log(C.dim("  Usage: /max:image <path> [prompt]\n"));
        if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
        return;
      }

      const spaceIdx = rest.indexOf(" ");
      const imgPath = spaceIdx > 0 ? rest.slice(0, spaceIdx) : rest;
      const userPrompt = spaceIdx > 0 ? rest.slice(spaceIdx + 1).trim() : "";

      const resolved = imgPath.startsWith("~")
        ? imgPath.replace(/^~/, process.env.HOME || "/home")
        : imgPath;

      if (!existsSync(resolved)) {
        console.log(C.red(`  File not found: ${imgPath}\n`));
        if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
        return;
      }

      let buffer: Buffer;
      try {
        buffer = readFileSync(resolved);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(C.red(`  Failed to read file: ${msg}\n`));
        if (resolveNextPrompt) { resolveNextPrompt(); resolveNextPrompt = null; }
        return;
      }
      const base64 = buffer.toString("base64");

      const ext = imgPath.split(".").pop()?.toLowerCase() ?? "";
      const mimeMap: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
      };
      const mimeType = mimeMap[ext] || "image/png";

      const displayName = imgPath.split("/").pop() || "image";
      const attachment: Attachment = { type: "blob", data: base64, mimeType, displayName };
      const prompt = userPrompt || "请描述这张图片。";

      console.log(`${`  ${C.coral("YOU")}     `}${C.dim(`[图片: ${displayName}]`)} ${prompt}`);
      saveHistoryLine(trimmed);

      activeRequestId += 1;
      activeRequestStartedAt = Date.now();
      startThinking();
      sendMessage(prompt, activeRequestId, [attachment]);
      return;
    }

    // Send message to daemon
    activeRequestId += 1;
    activeRequestStartedAt = Date.now();
    debugLog("request-dispatch", {
      requestId: activeRequestId,
      inputLength: trimmed.length,
      columns: process.stdout.columns || null,
    });
    startThinking();
    sendMessage(trimmed, activeRequestId);
  }

// ── Main ──────────────────────────────────────────────────
showBanner();
console.log(C.dim("    connecting..."));
connectSSE();

setTimeout(() => {
  // Listen for ESC to cancel in-flight messages
  if (process.stdin.isTTY) {
    process.stdin.on("keypress", (_str: string, key: any) => {
      if (key && key.name === "escape") {
        sendCancel();
      }
    });
  }

  // Main REPL loop: readMultiline is called only when not thinking.
  (async () => {
    while (true) {
      const [text, result] = await readMultiline(`  ${C.coral("›")} `, { prefix: "", helpFooter: false, inlinePrompt: true });
      if (result?.kind === "cancel" || result?.kind === "eof") {
        trimHistoryFile();
        console.log(C.dim("\n    bye.\n"));
        process.exit(0);
      }
      const trimmed = text.trim();
      if (!trimmed) continue;
      processUserInput(trimmed);
      // Wait for the response to finish before showing the next prompt
      await new Promise<void>((resolve) => { resolveNextPrompt = resolve; });
    }
  })();
}, 1000);
