import * as Lark from "@larksuiteoapi/node-sdk";
import { randomUUID } from "crypto";
import { config, persistFeishuAuthorizedOpenId, clearFeishuAuthorizedOpenId } from "../config.js";
import { route, RoutedMessage, executeMaxCommand, CommandResult } from "../command-router.js";
import { MessageHandler } from "../message-handler.js";
import { isMessageProcessed, markMessageProcessed } from "../store/db.js";
import { buildCardContent, buildTextContent, buildQuestionCard, chunkMessage } from "./formatter.js";

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
  cardMessageId?: string;
  cardSent?: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

/** openId → held plain text messages waiting for pending ask_user resolution */
const heldMessages = new Map<string, Array<{ messageId: string; chatId: string; text: string }>>();

function holdMessage(openId: string, messageId: string, chatId: string, text: string): void {
  const queue = heldMessages.get(openId) ?? [];
  queue.push({ messageId, chatId, text });
  heldMessages.set(openId, queue);
}

function takeHeldMessages(openId: string): Array<{ messageId: string; chatId: string; text: string }> {
  const queue = heldMessages.get(openId) ?? [];
  heldMessages.delete(openId);
  return queue;
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

/** openId → pending question waiting for user input */
const pendingQuestions = new Map<string, PendingQuestion>();
function clearPending(openId: string): PendingQuestion | undefined {
  const pending = pendingQuestions.get(openId);
  if (pending) {
    if (pending.cleanupTimer) clearTimeout(pending.cleanupTimer);
    pendingQuestions.delete(openId);
  }
  return pending;
}

/** openId → thinking notice timer (shared across messages for the same sender) */
const thinkingTimers = new Map<string, ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>>();
function clearThinkingTimer(openId: string): void {
  const existing = thinkingTimers.get(openId);
  if (existing) {
    clearTimeout(existing);
    clearInterval(existing);
    thinkingTimers.delete(openId);
  }
}
function setThinkingTimer(openId: string, timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
  clearThinkingTimer(openId);
  thinkingTimers.set(openId, timer);
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

async function drainHeldMessages(openId: string, messageHandler: MessageHandler): Promise<void> {
  const held = takeHeldMessages(openId);
  if (held.length === 0) return;
  console.log(`[feishu] drainHeldMessages: draining ${held.length} held message(s)`);
  for (const { messageId, chatId, text } of held) {
    const channelKey = `feishu:${openId}`;
    const routed = route(text, { senderId: openId, channelKey, messageId });
    clearThinkingTimer(openId);
    let thinkingSent = false;
    const sendThinking = () => {
      if (pendingQuestions.has(openId)) {
        console.log(`[feishu:drainHeld] sendThinking skipped (pending question) | pendingQ=true`);
        clearThinkingTimer(openId);
        return;
      }
      if (!messageHandler.isChannelBusy(channelKey)) {
        console.log(`[feishu:drainHeld] sendThinking skipped (channel no longer busy) | busy=false`);
        clearThinkingTimer(openId);
        return;
      }
      thinkingSent = true;
      console.log(`[feishu:drainHeld] sendThinking fired | thinkingSent=${thinkingSent} busy=true pendingQ=false`);
      void sendReply(messageId, chatId, "⏳ 正在思考...");
    };
    const resetThinkingTimer = (fromEarlySend: boolean = false) => {
      clearThinkingTimer(openId);
      if (fromEarlySend) {
        setThinkingTimer(openId, setInterval(sendThinking, 3 * 60 * 1000));
      } else {
        const initial = setTimeout(() => {
          sendThinking();
          if (!pendingQuestions.has(openId)) {
            setThinkingTimer(openId, setInterval(sendThinking, 3 * 60 * 1000));
          }
        }, 7000);
        setThinkingTimer(openId, initial);
      }
    };
    if (routed.type === "prompt" || routed.type === "cli-command") {
      if (messageHandler.isChannelBusy(channelKey)) {
        void sendReply(messageId, chatId, "⏳ 前一个请求正在处理中，已加入队列。");
      } else {
        resetThinkingTimer();
      }
    }
    try {
      await processMessage(routed, openId, messageId, chatId, messageHandler, resetThinkingTimer);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[feishu] drainHeldMessages error:", err);
      void sendReply(messageId, chatId, `❌ 处理挂起消息时发生错误：${errMsg}`);
    } finally {
      clearThinkingTimer(openId);
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
      pendingQuestions.delete(openId);
      pendingQuestions.set(openId, {
        messageId,
        chatId,
        questionId,
        question: question.question,
        choices: question.choices,
        allowFreeform: question.allowFreeform,
        cardSent: false,
      });
      console.log(`[feishu] new pending ask_user: allowFreeform=${question.allowFreeform} choices=[${question.choices.join(",")}] qid=${questionId.slice(0,8)}`);
      sendQuestionCard(messageId, chatId, question.question, question.choices, question.allowFreeform, questionId)
        .then(cardMessageId => {
          const pending = pendingQuestions.get(openId);
          if (pending) {
            pending.cardMessageId = cardMessageId;
            if (cardMessageId) pending.cardSent = true;
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

      // v1: only handle plain text messages.
      if (event.message.message_type !== "text") {
        await sendChunkedReply(
          event.message.message_id,
          event.message.chat_id,
          "_(Sorry — I can only read text messages right now.)_"
        );
        return;
      }

      const rawText = extractText(event.message.content);
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
        clearPending(senderOpenId);
        clearThinkingTimer(senderOpenId);
        heldMessages.delete(senderOpenId);
        messageHandler.cancelChannel(channelKey);
        await sendChunkedReply(
          event.message.message_id,
          event.message.chat_id,
          "⛔ 已取消当前操作。\n⛔ Current operation cancelled."
        );
        return;
      }

      // ── Pending question: route text as an answer ──────────────
      const pending = pendingQuestions.get(senderOpenId);
      if (pending) {
        if (text === "/max:skip") {
          clearPending(senderOpenId);
          messageHandler.answerUserInput(`feishu:${senderOpenId}`, "(User skipped the question.)");
          await drainHeldMessages(senderOpenId, messageHandler);
          return;
        }
        if (text.startsWith("/max:")) {
          // Cancel the question, answer with placeholder, then fall through to process the command.
          clearPending(senderOpenId);
          messageHandler.answerUserInput(`feishu:${senderOpenId}`, "(User sent a command instead of answering.)");
          // fall through
        } else {
          const answer = resolveChoiceAnswer(text, pending.choices);
          const isChoice = isValidChoiceAnswer(text, pending.choices);
          if (!pending.allowFreeform) {
            if (!pending.cardSent) {
              holdMessage(senderOpenId, event.message.message_id, event.message.chat_id, text);
              return;
            }
            if (!isChoice) {
              holdMessage(senderOpenId, event.message.message_id, event.message.chat_id, text);
              const newCardMessageId = await sendQuestionCard(
                event.message.message_id,
                event.message.chat_id,
                pending.question,
                pending.choices,
                pending.allowFreeform,
                pending.questionId,
              );
              if (newCardMessageId) {
                pending.cardMessageId = newCardMessageId;
                pending.cardSent = true;
              }
              return;
            }
          }
          if (!pending.cardSent) {
            // Card not yet delivered; hold this response until ask_user is active.
            holdMessage(senderOpenId, event.message.message_id, event.message.chat_id, text);
            return;
          }
          clearPending(senderOpenId);
          messageHandler.answerUserInput(`feishu:${senderOpenId}`, answer);
          await drainHeldMessages(senderOpenId, messageHandler);
          return;
        }
      }

      // For slow operations (prompts / CLI commands), notify the user.
      // If the channel is already busy the message is queued — notify immediately.
      // Otherwise wait 7 s; if Copilot hasn't replied by then, send a notice.
      // Each early-send from processMessage() resets this timer so the
      // thinking notice only appears when the AI is truly stalled.
      const channelKey = `feishu:${senderOpenId}`;
      const routed = route(text, { senderId: senderOpenId, channelKey, messageId: event.message.message_id });
      // Clear any leftover thinking timer from a previous message for this sender
      clearThinkingTimer(senderOpenId);
      let thinkingSent = false;
      const sendThinking = () => {
        if (pendingQuestions.has(senderOpenId)) {
          console.log(`[feishu:main] sendThinking skipped (pending question) | pendingQ=true`);
          clearThinkingTimer(senderOpenId);
          return;
        }
        if (!messageHandler.isChannelBusy(channelKey)) {
          console.log(`[feishu:main] sendThinking skipped (channel no longer busy) | busy=false`);
          clearThinkingTimer(senderOpenId);
          return;
        }
        thinkingSent = true;
        console.log(`[feishu:main] sendThinking fired | thinkingSent=${thinkingSent} busy=true pendingQ=false`);
        void sendReply(event.message.message_id, event.message.chat_id, "⏳ 正在思考...");
      };
      const resetThinkingTimer = (fromEarlySend: boolean = false) => {
        clearThinkingTimer(senderOpenId);
        if (fromEarlySend) {
          // Early-send replaces the 7s wait; skip directly to 3-min interval
          setThinkingTimer(senderOpenId, setInterval(sendThinking, 3 * 60 * 1000));
        } else {
          // Initial setup: wait 7s, then show "正在思考", then repeat every 3m
          const initial = setTimeout(() => {
            sendThinking();
            if (!pendingQuestions.has(senderOpenId)) {
              setThinkingTimer(senderOpenId, setInterval(sendThinking, 3 * 60 * 1000));
            }
          }, 7000);
          setThinkingTimer(senderOpenId, initial);
        }
      };

      if (routed.type === "prompt" || routed.type === "cli-command") {
        if (messageHandler.isChannelBusy(channelKey)) {
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
        );
      } catch (err) {
        clearThinkingTimer(senderOpenId);
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[feishu] processMessage error:", err);
        void sendReply(event.message.message_id, event.message.chat_id, `❌ 处理消息时发生错误：${errMsg}`);
        return;
      } finally {
        // Cancel any remaining thinking timer for this sender
        clearThinkingTimer(senderOpenId);
      }
      if (!pendingQuestions.has(senderOpenId) && heldMessages.has(senderOpenId)) {
        await drainHeldMessages(senderOpenId, messageHandler);
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
      if (!payload?.choice) return;
      const pending = pendingQuestions.get(openId);
      if (!pending) {
        await sendReply(evt.messageId, evt.chatId, "❌ 该问题已失效。请重新发起。");
        return;
      }
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
      clearPending(openId);
      void sendReply(evt.messageId, evt.chatId, `✅ 已选择：${payload.choice}`);
      messageHandler.answerUserInput(`feishu:${openId}`, payload.choice);
      await drainHeldMessages(openId, messageHandler);
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
