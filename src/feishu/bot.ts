import * as Lark from "@larksuiteoapi/node-sdk";
import { randomUUID } from "crypto";
import { config, persistFeishuAuthorizedOpenId, clearFeishuAuthorizedOpenId } from "../config.js";
import { route, RoutedMessage, executeMaxCommand, CommandResult, type Attachment } from "../command-router.js";
import { MessageHandler } from "../message-handler.js";
import { isMessageProcessed, markMessageProcessed, getActiveWorkspace } from "../store/db.js";
import { buildCardContent, buildTextContent, buildQuestionCard, chunkMessage } from "./formatter.js";
import { readFileSync } from "fs";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let client: Lark.Client | undefined;
let wsClient: Lark.WSClient | undefined;
let eventDispatcher: Lark.EventDispatcher | undefined;

interface PendingQuestion {
  messageId: string;
  chatId: string;
  questionId: string;
  question: string;
  choices: string[];
  allowFreeform: boolean;
  /** Which workspace issued this question. */
  wsName: string;
  cardMessageId?: string;
  cardSent?: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

/** Helper: build the composite key used by MessageHandler for ask_user routing. */
function feishuWsKey(openId: string, wsName: string): string {
  return `feishu:${openId}:${wsName}`;
}

/** openId → per-workspace held plain text messages waiting for pending ask_user resolution */
const heldMessages = new Map<string, Map<string, Array<{ messageId: string; chatId: string; text: string }>>>();

function holdMessage(openId: string, wsName: string, messageId: string, chatId: string, text: string): void {
  let wsMap = heldMessages.get(openId);
  if (!wsMap) { wsMap = new Map(); heldMessages.set(openId, wsMap); }
  const queue = wsMap.get(wsName) ?? [];
  queue.push({ messageId, chatId, text });
  wsMap.set(wsName, queue);
}

/** Drain held messages for a specific workspace only. */
function takeHeldMessages(openId: string, wsName: string): Array<{ messageId: string; chatId: string; text: string }> {
  const wsMap = heldMessages.get(openId);
  if (!wsMap) return [];
  const queue = wsMap.get(wsName) ?? [];
  wsMap.delete(wsName);
  if (wsMap.size === 0) heldMessages.delete(openId);
  return queue;
}

/** Check whether an openId has any held messages (for any workspace). */
function hasHeldMessages(openId: string): boolean {
  const wsMap = heldMessages.get(openId);
  if (!wsMap) return false;
  for (const q of wsMap.values()) { if (q.length > 0) return true; }
  return false;
}

/** One-time pairing token — generated on demand, cleared after use or expiry. */
let pairingToken: string | undefined;
let pairingTokenTimer: ReturnType<typeof setTimeout> | undefined;

const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generatePairingToken(): string {
  const words = ["alpha","bravo","charlie","delta","echo","foxtrot","golf","hotel",
    "india","juliet","kilo","lima","mike","november","oscar","papa","quebec",
    "romeo","sierra","tango","uniform","victor","whiskey","xray","yankee","zulu"];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(100 + Math.random() * 900);
  return `${pick()}-${pick()}-${num}`;
}

function activatePairingToken(): string {
  if (pairingTokenTimer) clearTimeout(pairingTokenTimer);
  pairingToken = generatePairingToken();
  pairingTokenTimer = setTimeout(() => {
    pairingToken = undefined;
    pairingTokenTimer = undefined;
    console.log("[max] Feishu pairing code expired.");
  }, PAIRING_TOKEN_TTL_MS);
  return pairingToken;
}

function invalidatePairingToken(): void {
  if (pairingTokenTimer) { clearTimeout(pairingTokenTimer); pairingTokenTimer = undefined; }
  pairingToken = undefined;
}

/** openId → pending questions (multiple workspaces can ask simultaneously) */
const pendingQuestions = new Map<string, PendingQuestion[]>();
function clearPending(openId: string, wsName: string): PendingQuestion | undefined {
  const list = pendingQuestions.get(openId);
  if (!list) return undefined;
  const idx = list.findIndex(p => p.wsName === wsName);
  if (idx === -1) return undefined;
  const [pending] = list.splice(idx, 1);
  if (list.length === 0) pendingQuestions.delete(openId);
  if (pending.cleanupTimer) clearTimeout(pending.cleanupTimer);
  return pending;
}

/** Get the pending question for a specific workspace, or the active workspace's pending. */
function getPendingFor(openId: string, wsName: string): PendingQuestion | undefined {
  const list = pendingQuestions.get(openId);
  if (!list) return undefined;
  return list.find(p => p.wsName === wsName);
}

/** Check whether an openId has any pending question (for any workspace). */
function hasAnyPending(openId: string): boolean {
  const list = pendingQuestions.get(openId);
  return list !== undefined && list.length > 0;
}

/** `${openId}:${wsName}` → thinking notice timer (independent per workspace) */
const thinkingTimers = new Map<string, ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>>();
function thinkingTimerKey(openId: string, wsName: string): string {
  return `${openId}:${wsName}`;
}
function clearThinkingTimer(openId: string, wsName: string): void {
  const key = thinkingTimerKey(openId, wsName);
  const existing = thinkingTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    clearInterval(existing);
    thinkingTimers.delete(key);
  }
}
function setThinkingTimer(openId: string, wsName: string, timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
  clearThinkingTimer(openId, wsName);
  thinkingTimers.set(thinkingTimerKey(openId, wsName), timer);
}

/** openId+text → last processed timestamp for content-based dedup.
 *  Prevents the same sender from triggering the same action twice
 *  (e.g. Feishu retrying /max:restart with a new message_id). */
const recentCommands = new Map<string, number>();
const CONTENT_DEDUP_TTL_MS = 60_000; // 60 seconds

function isRecentDuplicate(openId: string, text: string): boolean {
  const key = `${openId}::${text.trim()}`;
  const last = recentCommands.get(key);
  if (last && Date.now() - last < CONTENT_DEDUP_TTL_MS) {
    console.log(`[feishu] Skipping recent duplicate: openId=${openId} text="${text.trim().slice(0, 40)}"`);
    return true;
  }
  recentCommands.set(key, Date.now());
  // Prune stale entries periodically
  if (recentCommands.size > 100) {
    const cutoff = Date.now() - CONTENT_DEDUP_TTL_MS;
    for (const [k, ts] of recentCommands) {
      if (ts < cutoff) recentCommands.delete(k);
    }
  }
  return false;
}

/** Download a Feishu image by image_key to a temp file and return the path. */
async function downloadFeishuImage(imageKey: string, label: string): Promise<string | undefined> {
  if (!client) return undefined;
  try {
    const resp = await client.im.v1.image.get({ path: { image_key: imageKey } });
    if (!resp || typeof resp.writeFile !== "function") {
      console.warn("[feishu] Unexpected image download response:", typeof resp);
      return undefined;
    }
    const tmpPath = join(tmpdir(), `max-feishu-${label}-${Date.now()}.jpg`);
    await resp.writeFile(tmpPath);
    return tmpPath;
  } catch (err) {
    console.error(`[feishu] Failed to download image ${imageKey}:`, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

// ── File type helpers ─────────────────────────────────────

/** Extensions that are always safe to read as UTF-8 text. */
const TEXT_FILE_EXTENSIONS = new Set([
  "txt", "md", "json", "yaml", "yml", "xml", "html", "htm", "css", "scss", "sass", "less",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "pyw", "rb", "go", "rs", "java", "kt", "kts",
  "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx", "cs", "php", "swift", "scala", "sh",
  "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "graphql", "gql", "proto", "toml",
  "ini", "cfg", "conf", "env", "prisma", "vue", "svelte", "r", "lua", "dart", "elm",
  "ex", "exs", "hs", "erl", "hrl", "ml", "mli", "nim", "zig", "v", "csv", "tsv", "log",
  "rest", "text", "diff", "patch", "makefile", "dockerfile", "gemfile", "rakefile",
]);

function isTextFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_FILE_EXTENSIONS.has(ext);
}

/** Extract filename from Content-Disposition header if available. */
function extractFilenameFromHeaders(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  const cd = headers["content-disposition"] || headers["Content-Disposition"] || "";
  const match = cd.match(/filename[*]?=(?:UTF-8''|"(?:[^"]|[\\]")*")?([^;"]+)/i);
  return match?.[1]?.replace(/^["']|["']$/g, "");
}

/** Download a user-sent file from a Feishu message and return { tmpPath, filename }. */
async function downloadFeishuFile(
  messageId: string,
  fileKey: string,
  label: string,
): Promise<{ tmpPath: string; filename: string } | undefined> {
  if (!client) return undefined;
  try {
    const resp = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: "file" },
    });
    if (!resp || typeof resp.writeFile !== "function") {
      console.warn("[feishu] Unexpected file download response:", typeof resp);
      return undefined;
    }
    const filename = extractFilenameFromHeaders(resp.headers) || `feishu-file-${label}`;
    const ext = filename.split(".").pop()?.toLowerCase();
    const tmpPath = join(tmpdir(), `max-feishu-${label}-${Date.now()}.${ext || "bin"}`);
    await resp.writeFile(tmpPath);
    return { tmpPath, filename };
  } catch (err) {
    console.error(`[feishu] Failed to download file ${fileKey}:`, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

async function drainHeldMessages(openId: string, wsName: string, messageHandler: MessageHandler): Promise<void> {
  const held = takeHeldMessages(openId, wsName);
  if (held.length === 0) return;
  console.log(`[feishu] drainHeldMessages: draining ${held.length} held message(s) for ws=${wsName}`);
  for (const { messageId, chatId, text } of held) {
    const channelKey = `feishu:${openId}`;
    const routed = route(text, { senderId: openId, channelKey, messageId });
    clearThinkingTimer(openId, wsName);
    let thinkingSent = false;
    const sendThinking = () => {
      if (hasAnyPending(openId)) {
        console.log(`[feishu:drainHeld] sendThinking skipped (pending question) | pendingQ=true`);
        clearThinkingTimer(openId, wsName);
        return;
      }
      if (!messageHandler.isChannelBusy(channelKey, wsName)) {
        console.log(`[feishu:drainHeld] sendThinking skipped (ws not busy) | busy=false ws=${wsName}`);
        clearThinkingTimer(openId, wsName);
        return;
      }
      thinkingSent = true;
      console.log(`[feishu:drainHeld] sendThinking fired | thinkingSent=${thinkingSent} busy=true pendingQ=false ws=${wsName}`);
      void sendReply(messageId, chatId, "⏳ 正在思考...");
    };
    const resetThinkingTimer = (fromEarlySend: boolean = false) => {
      clearThinkingTimer(openId, wsName);
      if (fromEarlySend) {
        setThinkingTimer(openId, wsName, setInterval(sendThinking, 3 * 60 * 1000));
      } else {
        const initial = setTimeout(() => {
          sendThinking();
          if (!hasAnyPending(openId)) {
            setThinkingTimer(openId, wsName, setInterval(sendThinking, 3 * 60 * 1000));
          }
        }, 7000);
        setThinkingTimer(openId, wsName, initial);
      }
    };
    if (routed.type === "prompt" || routed.type === "cli-command") {
      if (messageHandler.isChannelBusy(channelKey, wsName)) {
        void sendReply(messageId, chatId, "⏳ 前一个请求正在处理中，已加入队列。");
      } else {
        resetThinkingTimer();
      }
    }
    try {
      await processMessage(routed, openId, messageId, chatId, messageHandler, resetThinkingTimer, wsName);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[feishu] drainHeldMessages error:", err);
      void sendReply(messageId, chatId, `❌ 处理挂起消息时发生错误：${errMsg}`);
    } finally {
      clearThinkingTimer(openId, wsName);
    }
  }
}

/** Try to parse a question event JSON emitted by ask_user tool. */
function tryParseQuestion(text: string): { question: string; choices: string[]; allowFreeform: boolean } | null {
  if (!text || text[0] !== "{") return null;
  try {
    const obj = JSON.parse(text);
    if (obj?.type === "question" && typeof obj.question === "string") {
      return {
        question: obj.question,
        choices: Array.isArray(obj.choices) ? obj.choices : [],
        allowFreeform: obj.allowFreeform !== false,
      };
    }
  } catch {
    // not JSON
  }
  return null;
}

/** Map a user text answer to a choice or free-form answer. */
function resolveChoiceAnswer(text: string, choices: string[]): string {
  const n = parseInt(text, 10);
  if (!isNaN(n) && n >= 1 && n <= choices.length) {
    return choices[n - 1];
  }
  return text;
}

function isValidChoiceAnswer(text: string, choices: string[]): boolean {
  const trimmed = text.trim();
  if (choices.length === 0) return false;
  const n = Number(trimmed);
  if (!Number.isNaN(n) && Number.isInteger(n) && n >= 1 && n <= choices.length) {
    return true;
  }
  return choices.some(choice => choice.trim().toLowerCase() === trimmed.toLowerCase());
}

function resolveDomain(domain: "feishu" | "lark"): Lark.Domain {
  return domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

/** Strip leading @mentions of any user from a Feishu message. */
function stripMentions(text: string): string {
  // Feishu emits mention placeholders like "@_user_1" / "@_all" interleaved
  // with plain text. Remove all leading mention tokens plus surrounding
  // whitespace; preserve any subsequent body verbatim.
  return text.replace(/^(?:\s*@[_\w]+\s*)+/, "").trim();
}

/** Decode the JSON message.content payload for a text message. */
function extractText(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

type MessageReceiveEvent = {
  sender: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
    sender_type?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: "p2p" | "group" | string;
    message_type: string;
    content: string;
  };
};

/** Early-send configuration. */
const EARLY_SEND_IDLE_MS = 5000;       // wait 5 s after last delta before early-send
const SENTENCE_END_RE = /[。.]\s*$/;   // ends with Chinese or English period

/** Route and process a message through the unified message handler.
 *  Handles all routed types: max-command, cli-command, prompt.
 *  When the LLM issues an ask_user question, registers a pending entry and
 *  sends an interactive question card; returns "" in that case.
 *  Implements incremental early-send: when the accumulated text ends with
 *  a sentence terminator and no new delta arrives for EARLY_SEND_IDLE_MS,
 *  the unsent portion is sent immediately.  Each early send resets the
 *  external thinking-notice timer via onEarlySend(). */
async function processMessage(
  routed: RoutedMessage,
  openId: string,
  messageId: string,
  chatId: string,
  messageHandler: MessageHandler,
  onEarlySend: (fromEarlySend: boolean) => void,
  wsName: string,
): Promise<string> {
  const channelKey = `feishu:${openId}`;

  let latestContent = "";
  let sentLength = 0;  // characters already delivered to the user
  let earlySendTimer: ReturnType<typeof setTimeout> | undefined;

  const flushUnsent = () => {
    const unsent = latestContent.slice(sentLength);
    if (!unsent) return;
    void sendChunkedReply(messageId, chatId, unsent);
    sentLength = latestContent.length;
    onEarlySend(true);   // reset the 3-min thinking timer
  };

  await messageHandler.handle(routed, channelKey, (responseText: string, done: boolean) => {
    if (done) {
      if (earlySendTimer) { clearTimeout(earlySendTimer); earlySendTimer = undefined; }
      if (responseText) latestContent = responseText; // capture max-command / cli-command one-shot result
      return; // caller sends the remainder
    }
    if (!responseText) return;
    const question = tryParseQuestion(responseText);
    if (question) {
      const questionId = randomUUID();
      // Add to the per-workspace pending list (replace any old entry for the same workspace).
      clearPending(openId, wsName);
      const pending: PendingQuestion = {
        messageId,
        chatId,
        questionId,
        question: question.question,
        choices: question.choices,
        allowFreeform: question.allowFreeform,
        wsName,
        cardSent: false,
      };
      const list = pendingQuestions.get(openId) ?? [];
      list.push(pending);
      pendingQuestions.set(openId, list);
      console.log(`[feishu] new pending ask_user: ws=${wsName} allowFreeform=${question.allowFreeform} choices=[${question.choices.join(",")}] qid=${questionId.slice(0,8)}`);
      sendQuestionCard(messageId, chatId, question.question, question.choices, question.allowFreeform, questionId)
        .then(cardMessageId => {
          const fresh = getPendingFor(openId, wsName);
          if (fresh) {
            fresh.cardMessageId = cardMessageId;
            if (cardMessageId) fresh.cardSent = true;
          }
        })
        .catch(err => console.error("[feishu] Failed to send question card:", err));
    } else {
      // Overwrite each time: streaming sends cumulative text; commands send once with done=true.
      latestContent = responseText;
      // Restart the idle timer — if the text looks like a complete sentence,
      // schedule an early send.
      if (earlySendTimer) clearTimeout(earlySendTimer);
      if (SENTENCE_END_RE.test(latestContent)) {
        earlySendTimer = setTimeout(flushUnsent, EARLY_SEND_IDLE_MS);
      }
    }
  });

  // Flush any remaining unsent text.
  if (earlySendTimer) clearTimeout(earlySendTimer);
  const remaining = latestContent.slice(sentLength);
  if (remaining.length > 0) {
    await sendChunkedReply(messageId, chatId, remaining);
  }

  console.log(`[feishu] processMessage → ${latestContent.length} chars (type=${routed.type}, sender=${openId})`);
  return latestContent;
}

// ── Deduplication ─────────────────────────────────────────────────

/** Returns true if this message_id was already processed (persistent, survives restarts). */
function isDuplicate(messageId: string): boolean {
  if (isMessageProcessed(messageId)) {
    console.log(`[feishu] ${new Date().toISOString()} Skipping duplicate message_id=${messageId}`);
    return true;
  }
  markMessageProcessed(messageId);
  return false;
}

async function sendChunkedReply(
  messageId: string,
  chatId: string,
  text: string
): Promise<void> {
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    await sendReply(messageId, chatId, chunk);
  }
}

/** Reply to a Feishu message; falls back to a direct send if reply is unavailable. */
async function sendReply(
  messageId: string,
  chatId: string,
  text: string
): Promise<void> {
  if (!client) return;
  const card = buildCardContent(text);

  try {
    await client.im.message.reply({
      path: { message_id: messageId },
      data: { content: card, msg_type: "interactive" },
    });
    return;
  } catch (err) {
    // Fall through to direct send. Common cause: parent message withdrawn
    // (codes 230011 / 231003) — pattern from openclaw extensions/feishu.
    if (!isWithdrawnReplyError(err)) {
      console.error("[max] Feishu reply failed, falling back to direct send:", err);
    }
  }

  try {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, content: card, msg_type: "interactive" },
    });
  } catch (err) {
    // Last resort: try plain text in case the card payload is the problem.
    try {
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, content: buildTextContent(text), msg_type: "text" },
      });
    } catch (err2) {
      console.error("[max] Feishu direct send failed:", err2 ?? err);
    }
  }
}

function isWithdrawnReplyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: number }).code;
  if (code === 230011 || code === 231003) return true;
  const response = (err as { response?: { data?: { code?: number } } }).response;
  return response?.data?.code === 230011 || response?.data?.code === 231003;
}

/** Send an interactive question card to the user. */
async function sendQuestionCard(
  messageId: string,
  chatId: string,
  question: string,
  choices: string[],
  allowFreeform: boolean,
  questionId: string,
): Promise<string | undefined> {
  if (!client) return undefined;
  const card = buildQuestionCard(question, choices, allowFreeform, questionId);
  try {
    const result = await client.im.message.reply({
      path: { message_id: messageId },
      data: { content: card, msg_type: "interactive" },
    });
    return (result as any)?.data?.message_id ?? (result as any)?.message_id;
  } catch (err) {
    if (!isWithdrawnReplyError(err)) {
      console.error("[feishu] Question card reply failed, falling back:", err);
    }
  }
  const result = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: chatId, content: card, msg_type: "interactive" },
  });
  return (result as any)?.data?.message_id ?? (result as any)?.message_id;
}

export function createBot(messageHandler: MessageHandler): { client: Lark.Client; wsClient: Lark.WSClient } {
  if (!config.feishuAppId || !config.feishuAppSecret) {
    throw new Error(
      "Feishu credentials are missing. Run 'max setup' and enter your Feishu App ID and App Secret."
    );
  }

  const domain = resolveDomain(config.feishuDomain);

  client = new Lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    appType: Lark.AppType.SelfBuild,
    domain,
  });

  wsClient = new Lark.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    domain,
    loggerLevel: Lark.LoggerLevel.warn,
  });

  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: unknown) => {
      try {
      const event = data as MessageReceiveEvent;
      const senderOpenId = event.sender?.sender_id?.open_id;

      // ── Authorization ─────────────────────────────────────
      if (!senderOpenId) return;
      if (event.message.chat_type !== "p2p") return; // group chats not supported

      if (config.feishuAuthorizedOpenId) {
        // Already paired — only the paired user is allowed
        if (senderOpenId !== config.feishuAuthorizedOpenId) return; // silently ignore
      } else {
        // Not yet paired — handle pairing flow
        if (event.message.message_type === "text") {
          const rawText = extractText(event.message.content);
          const text = stripMentions(rawText).trim();

          if (pairingToken && text === pairingToken) {
            // Correct code — register this user
            invalidatePairingToken();
            config.feishuAuthorizedOpenId = senderOpenId;
            persistFeishuAuthorizedOpenId(senderOpenId);
            console.log(`[max] Feishu user paired: ${senderOpenId}`);
            await sendChunkedReply(
              event.message.message_id,
              event.message.chat_id,
              "✅ 已配对！您现在可以与 Max 对话了。\n✅ Paired! You can now control Max."
            );
          } else {
            // Generate a new pairing code (or reuse unexpired one) and prompt
            const code = pairingToken ?? activatePairingToken();
            console.log(
              `\n[max] ⚡ Feishu pairing code: \x1b[1;33m${code}\x1b[0m\n` +
              `[max]    DM this code to the bot to pair. Expires in 5 minutes.\n`
            );
            await sendChunkedReply(
              event.message.message_id,
              event.message.chat_id,
              "🔒 请输入终端显示的配对码以完成授权。\n🔒 Please enter the pairing code shown in the terminal."
            );
          }
        }
        return; // don't process further until paired
      }

      // v1: group chats check already done above.

      // v1: handle plain text, image, and text-based file messages.
      if (event.message.message_type !== "text" && event.message.message_type !== "image" && event.message.message_type !== "file") {
        await sendChunkedReply(
          event.message.message_id,
          event.message.chat_id,
          "_(Sorry — I can only read text, images, and text-based files right now.)_"
        );
        return;
      }

      let rawText: string;
      let messageAttachments: Attachment[] = [];

      if (event.message.message_type === "image") {
        // Parse image_key from the message content
        const content = JSON.parse(event.message.content) as { image_key?: string };
        const imageKey = content.image_key;
        if (imageKey) {
          const tmpPath = await downloadFeishuImage(imageKey, "msg");
          if (tmpPath) {
            try {
              const buffer = readFileSync(tmpPath);
              const base64 = buffer.toString("base64");
              messageAttachments.push({
                type: "blob",
                data: base64,
                mimeType: "image/jpeg",
                displayName: "image.jpg",
              });
            } catch (err) {
              console.error("[feishu] Failed to read downloaded image:", err);
            }
            // Clean up temp file after reading
            void unlink(tmpPath).catch(() => {});
          } else {
            await sendChunkedReply(
              event.message.message_id,
              event.message.chat_id,
              "_(无法下载图片，请重试。)_"
            );
            return;
          }
        }
        rawText = "请描述这张图片。";
      } else if (event.message.message_type === "file") {
        // Parse file_key from the message content
        const content = JSON.parse(event.message.content) as { file_key?: string };
        const fileKey = content.file_key;
        if (!fileKey) {
          rawText = "";
        } else {
          const result = await downloadFeishuFile(
            event.message.message_id, fileKey, "file"
          );
          if (!result) {
            await sendChunkedReply(
              event.message.message_id,
              event.message.chat_id,
              "_(无法下载文件，请重试。)_"
            );
            return;
          }
          if (!isTextFile(result.filename)) {
            void unlink(result.tmpPath).catch(() => {});
            const ext = result.filename.split(".").pop()?.toLowerCase() ?? "";
            await sendChunkedReply(
              event.message.message_id,
              event.message.chat_id,
              `_(暂不支持 "${ext}" 文件类型。目前支持: ${[...TEXT_FILE_EXTENSIONS].slice(0, 10).join(", ")}… 等文本文件。)_`
            );
            return;
          }
          let fileContent: string;
          try {
            fileContent = readFileSync(result.tmpPath, "utf-8");
          } catch {
            void unlink(result.tmpPath).catch(() => {});
            await sendChunkedReply(
              event.message.message_id,
              event.message.chat_id,
              "_(文件无法以文本方式读取，可能包含二进制内容。)_"
            );
            return;
          }
          void unlink(result.tmpPath).catch(() => {});
          // Prepend file name and content to prompt
          rawText = `[文件: ${result.filename}]\n\n${fileContent}`;
        }
      } else {
        rawText = extractText(event.message.content);
      }

      const text = stripMentions(rawText);
      if (!text) return;

      // Skip duplicate messages (Feishu retries events if handler takes >3s)
      if (isDuplicate(event.message.message_id)) return;
      // Also skip recent duplicates by content (same sender, same text within 60s)
      if (isRecentDuplicate(senderOpenId, text)) return;
      console.log(`[feishu] ${new Date().toISOString()} Received message_id=${event.message.message_id} type=${event.message.message_type} text="${text.slice(0, 80)}"`);

      // ── /max:unpair ────────────────────────────────────────
      if (text.trim() === "/max:unpair") {
        clearFeishuAuthorizedOpenId();
        console.log("[max] Feishu user unpaired.");
        await sendChunkedReply(
          event.message.message_id,
          event.message.chat_id,
          "🔓 已解除配对。下次有人 DM 时 Max 会显示新的配对码。\n🔓 Unpaired. Max will show a new pairing code on the next DM."
        );
        return;
      }

      // ── /max:cancel ────────────────────────────────────────
      if (text.trim() === "/max:cancel") {
        const channelKey = `feishu:${senderOpenId}`;
        const activeWs = getActiveWorkspace(channelKey);
        clearPending(senderOpenId, activeWs);
        clearThinkingTimer(senderOpenId, activeWs);
        heldMessages.delete(senderOpenId); // clear all held for this user
        messageHandler.cancelChannel(channelKey, activeWs);
        await sendChunkedReply(
          event.message.message_id,
          event.message.chat_id,
          `⛔ 已取消当前操作 (${activeWs})。\n⛔ Current operation cancelled (${activeWs}).`
        );
        return;
      }

      // ── Pending question: route text as an answer ──────────────
      const channelKey = `feishu:${senderOpenId}`;
      const activeWs = getActiveWorkspace(channelKey);
      const activePending = getPendingFor(senderOpenId, activeWs);
      if (activePending) {
        if (text === "/max:skip") {
          clearPending(senderOpenId, activeWs);
          messageHandler.answerUserInput(feishuWsKey(senderOpenId, activeWs), "(User skipped the question.)");
          await drainHeldMessages(senderOpenId, activeWs, messageHandler);
          return;
        }
        if (text.startsWith("/max:")) {
          // Cancel the question, answer with placeholder, then fall through to process the command.
          clearPending(senderOpenId, activeWs);
          messageHandler.answerUserInput(feishuWsKey(senderOpenId, activeWs), "(User sent a command instead of answering.)");
          // fall through
        } else {
          const answer = resolveChoiceAnswer(text, activePending.choices);
          const isChoice = isValidChoiceAnswer(text, activePending.choices);
          if (!activePending.allowFreeform) {
            if (!activePending.cardSent) {
              holdMessage(senderOpenId, activeWs, event.message.message_id, event.message.chat_id, text);
              return;
            }
            if (!isChoice) {
              holdMessage(senderOpenId, activeWs, event.message.message_id, event.message.chat_id, text);
              const newCardMessageId = await sendQuestionCard(
                event.message.message_id,
                event.message.chat_id,
                activePending.question,
                activePending.choices,
                activePending.allowFreeform,
                activePending.questionId,
              );
              if (newCardMessageId) {
                activePending.cardMessageId = newCardMessageId;
                activePending.cardSent = true;
              }
              return;
            }
          }
          if (!activePending.cardSent) {
            holdMessage(senderOpenId, activeWs, event.message.message_id, event.message.chat_id, text);
            return;
          }
          clearPending(senderOpenId, activeWs);
          messageHandler.answerUserInput(feishuWsKey(senderOpenId, activeWs), answer);
          await drainHeldMessages(senderOpenId, activeWs, messageHandler);
          return;
        }
      } else if (hasAnyPending(senderOpenId)) {
        // Other workspace(s) have pending questions, but the active workspace doesn't.
        // Hold the message for the active ws in case it's meant for a pending question
        // after the user switches. Actually — if it doesn't start with /max:, treat it
        // as a regular prompt for the active workspace (don't hold).
        // Only hold if the message might be an answer to a non-active workspace's question.
      }

      // For slow operations (prompts / CLI commands), notify the user.
      // If the channel is already busy the message is queued — notify immediately.
      // Otherwise wait 7 s; if Copilot hasn't replied by then, send a notice.
      // Each early-send from processMessage() resets this timer so the
      // thinking notice only appears when the AI is truly stalled.
      const routed = route(text, { senderId: senderOpenId, channelKey, messageId: event.message.message_id });

      // Attach any image blobs from the incoming message
      if (routed.type === "prompt" && messageAttachments.length > 0) {
        routed.attachments = messageAttachments;
      }

      // Clear any leftover thinking timer for this sender + workspace
      clearThinkingTimer(senderOpenId, activeWs);
      let thinkingSent = false;
      const sendThinking = () => {
        if (hasAnyPending(senderOpenId)) {
          console.log(`[feishu:main] sendThinking skipped (pending question) | pendingQ=true`);
          clearThinkingTimer(senderOpenId, activeWs);
          return;
        }
        if (!messageHandler.isChannelBusy(channelKey, activeWs)) {
          console.log(`[feishu:main] sendThinking skipped (ws not busy) | busy=false ws=${activeWs}`);
          clearThinkingTimer(senderOpenId, activeWs);
          return;
        }
        thinkingSent = true;
        console.log(`[feishu:main] sendThinking fired | thinkingSent=${thinkingSent} busy=true pendingQ=false ws=${activeWs}`);
        void sendReply(event.message.message_id, event.message.chat_id, "⏳ 正在思考...");
      };
      const resetThinkingTimer = (fromEarlySend: boolean = false) => {
        clearThinkingTimer(senderOpenId, activeWs);
        if (fromEarlySend) {
          // Early-send replaces the 7s wait; skip directly to 3-min interval
          setThinkingTimer(senderOpenId, activeWs, setInterval(sendThinking, 3 * 60 * 1000));
        } else {
          // Initial setup: wait 7s, then show "正在思考", then repeat every 3m
          const initial = setTimeout(() => {
            sendThinking();
            if (!hasAnyPending(senderOpenId)) {
              setThinkingTimer(senderOpenId, activeWs, setInterval(sendThinking, 3 * 60 * 1000));
            }
          }, 7000);
          setThinkingTimer(senderOpenId, activeWs, initial);
        }
      };

      if (routed.type === "prompt" || routed.type === "cli-command") {
        if (messageHandler.isChannelBusy(channelKey, activeWs)) {
          void sendReply(event.message.message_id, event.message.chat_id, "⏳ 前一个请求正在处理中，已加入队列。");
        } else {
          resetThinkingTimer();
        }
      }

      // Route and process through unified message handler.
      // processMessage() handles all sending (early + final) internally.
      try {
        await processMessage(
          routed,
          senderOpenId,
          event.message.message_id,
          event.message.chat_id,
          messageHandler,
          resetThinkingTimer,
          activeWs,
        );
      } catch (err) {
        clearThinkingTimer(senderOpenId, activeWs);
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[feishu] processMessage error:", err);
        void sendReply(event.message.message_id, event.message.chat_id, `❌ 处理消息时发生错误：${errMsg}`);
        return;
      } finally {
        // Cancel any remaining thinking timer for this sender + workspace
        clearThinkingTimer(senderOpenId, activeWs);
      }
      if (!hasAnyPending(senderOpenId) && hasHeldMessages(senderOpenId)) {
        await drainHeldMessages(senderOpenId, activeWs, messageHandler);
      }
      } catch (err) {
        console.error(`[feishu] Unhandled error in message handler (msg_id=${(data as MessageReceiveEvent)?.message?.message_id ?? "unknown"}):`, err);
        // Don't rethrow — keeps the event handler alive
      }
    },

    "card.action.trigger": async (data: unknown) => {
      const evt = Lark.normalizeCardAction(data as Lark.RawCardActionEvent);
      if (!evt) return;
      const openId = evt.operator.openId;
      if (openId !== config.feishuAuthorizedOpenId) return;
      const payload = evt.action.value as { choice?: string; questionId?: string } | undefined;
      if (!payload?.choice || !payload?.questionId) return;

      // Find the pending question by questionId (unique across all workspaces).
      const list = pendingQuestions.get(openId);
      const pending = list?.find(p => p.questionId === payload.questionId);
      if (!pending) {
        await sendReply(evt.messageId, evt.chatId, "❌ 该问题已失效。请重新发起。");
        return;
      }
      // Re-check: the questionId in the card should match the pending entry we found.
      if (payload.questionId !== pending.questionId) {
        await sendReply(evt.messageId, evt.chatId, "⚠️ 你点击的是旧问题。请回答最新问题。已重新发送卡片。\n");
        const newCardMessageId = await sendQuestionCard(
          evt.messageId, evt.chatId, pending.question, pending.choices, pending.allowFreeform, pending.questionId,
        );
        if (newCardMessageId) {
          pending.cardMessageId = newCardMessageId;
          pending.cardSent = true;
        }
        return;
      }
      const wsName = pending.wsName;
      clearPending(openId, wsName);
      void sendReply(evt.messageId, evt.chatId, `✅ 已选择：${payload.choice}`);
      messageHandler.answerUserInput(feishuWsKey(openId, wsName), payload.choice);
      await drainHeldMessages(openId, wsName, messageHandler);
    },
  });

  // Wire up WS → dispatcher on start().
  eventDispatcher = dispatcher;

  return { client, wsClient };
}

export async function startBot(): Promise<void> {
  if (!wsClient || !eventDispatcher) throw new Error("Feishu bot not created");
  if (config.feishuAuthorizedOpenId) {
    console.log("[max] Feishu bot starting (already paired)...");
  } else {
    console.log("[max] Feishu bot starting (not yet paired — DM the bot to get a pairing code)...");
  }
  // WSClient.start is fire-and-forget — it manages its own reconnect loop.
  try {
    wsClient.start({ eventDispatcher });
    console.log("[max] Feishu websocket loop started; waiting for incoming events");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/invalid|unauthorized|app_id|secret/i.test(message)) {
      console.error(
        "[max] ⚠️ Feishu app credentials are invalid. Run 'max setup' and re-enter your Feishu App ID and App Secret."
      );
    } else {
      console.error("[max] ❌ Feishu bot failed to start:", message);
    }
  }
}

export async function stopBot(): Promise<void> {
  // Lark WSClient does not expose a clean stop in all versions; best-effort.
  const anyClient = wsClient as unknown as { stop?: () => void; close?: () => void };
  try {
    anyClient.stop?.();
    anyClient.close?.();
  } catch {
    /* best effort */
  }
  wsClient = undefined;
  client = undefined;
  eventDispatcher = undefined;
}

/** Send an unsolicited message to the authorized Feishu user. */
export async function sendProactiveMessage(text: string): Promise<void> {
  if (!client || !config.feishuAuthorizedOpenId) return;
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    try {
      await client.im.message.create({
        params: { receive_id_type: "open_id" },
        data: {
          receive_id: config.feishuAuthorizedOpenId,
          content: buildCardContent(chunk),
          msg_type: "interactive",
        },
      });
    } catch (err) {
      try {
        await client.im.message.create({
          params: { receive_id_type: "open_id" },
          data: {
            receive_id: config.feishuAuthorizedOpenId,
            content: buildTextContent(chunk),
            msg_type: "text",
          },
        });
      } catch (err2) {
        console.error("[max] Feishu proactive send failed:", err2 ?? err);
      }
    }
  }
}
