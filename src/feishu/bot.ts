import * as Lark from "@larksuiteoapi/node-sdk";
import { config, persistFeishuAuthorizedOpenId } from "../config.js";
import { route, RoutedMessage, executeMaxCommand, CommandResult } from "../command-router.js";
import { MessageHandler } from "../message-handler.js";
import { buildCardContent, buildTextContent, buildQuestionCard, chunkMessage } from "./formatter.js";

let client: Lark.Client | undefined;
let wsClient: Lark.WSClient | undefined;
let eventDispatcher: Lark.EventDispatcher | undefined;

interface PendingQuestion {
  messageId: string;
  chatId: string;
  choices: string[];
  allowFreeform: boolean;
  cleanupTimer: ReturnType<typeof setTimeout>;
}

/** openId → pending question waiting for user input */
const pendingQuestions = new Map<string, PendingQuestion>();

function clearPending(openId: string): PendingQuestion | undefined {
  const pending = pendingQuestions.get(openId);
  if (pending) {
    clearTimeout(pending.cleanupTimer);
    pendingQuestions.delete(openId);
  }
  return pending;
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
        allowFreeform: obj.allow_freeform !== false,
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

/** Route and process a message through the unified message handler.
 *  Handles all routed types: max-command, cli-command, prompt.
 *  When the LLM issues an ask_user question, registers a pending entry and
 *  sends an interactive question card; returns "" in that case. */
async function processMessage(
  text: string,
  openId: string,
  messageId: string,
  chatId: string,
  messageHandler: MessageHandler,
): Promise<string> {
  const channelKey = `feishu:${openId}`;
  const result = route(text, { senderId: openId, channelKey });

  let latestContent = "";
  await messageHandler.handle(result, channelKey, (responseText: string, _done: boolean) => {
    if (!responseText) return;
    const question = tryParseQuestion(responseText);
    if (question) {
      const cleanupTimer = setTimeout(() => pendingQuestions.delete(openId), 5 * 60 * 1000 + 5000);
      pendingQuestions.set(openId, { messageId, chatId, ...question, cleanupTimer });
      sendQuestionCard(messageId, chatId, question.question, question.choices, question.allowFreeform)
        .catch(err => console.error("[feishu] Failed to send question card:", err));
    } else {
      // Overwrite each time: streaming sends cumulative text; commands send once with done=true.
      latestContent = responseText;
    }
  });

  console.log(`[feishu] processMessage → ${latestContent.length} chars (type=${result.type}, sender=${openId})`);
  return latestContent;
}

// ── Deduplication ─────────────────────────────────────────────────

const RECENT_MESSAGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const recentMessages = new Map<string, number>(); // message_id → timestamp

/** Returns true if this message_id was already processed recently. */
function isDuplicate(messageId: string): boolean {
  const cutoff = Date.now() - RECENT_MESSAGE_TTL_MS;
  // Purge expired entries
  for (const [id, ts] of recentMessages) {
    if (ts < cutoff) recentMessages.delete(id);
  }
  if (recentMessages.has(messageId)) {
    console.log(`[feishu] Skipping duplicate message ${messageId}`);
    return true;
  }
  recentMessages.set(messageId, Date.now());
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
): Promise<void> {
  if (!client) return;
  const card = buildQuestionCard(question, choices, allowFreeform);
  try {
    await client.im.message.reply({
      path: { message_id: messageId },
      data: { content: card, msg_type: "interactive" },
    });
    return;
  } catch (err) {
    if (!isWithdrawnReplyError(err)) {
      console.error("[feishu] Question card reply failed, falling back:", err);
    }
  }
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: chatId, content: card, msg_type: "interactive" },
  });
}

export function createBot(messageHandler: MessageHandler): { client: Lark.Client; wsClient: Lark.WSClient } {
  if (!config.feishuAppId || !config.feishuAppSecret) {
    throw new Error(
      "Feishu credentials are missing. Run 'max setup' and enter your Feishu App ID and App Secret."
    );
  }
  if (!config.feishuAuthorizedOpenId && !config.feishuSecretCode) {
    throw new Error(
      "Feishu is not configured. Run 'max setup' and set a secret code to authorize yourself."
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
      const event = data as MessageReceiveEvent;
      const senderOpenId = event.sender?.sender_id?.open_id;

      // ── Authorization ─────────────────────────────────────
      if (!senderOpenId) return;
      if (event.message.chat_type !== "p2p") return; // group chats not supported

      if (config.feishuAuthorizedOpenId) {
        // Registered: strict single-user check
        if (senderOpenId !== config.feishuAuthorizedOpenId) return;
      } else if (config.feishuSecretCode) {
        // Waiting for first-time registration via secret code
        if (event.message.message_type === "text") {
          const rawText = extractText(event.message.content);
          const text = stripMentions(rawText);
          if (text === config.feishuSecretCode) {
            config.feishuAuthorizedOpenId = senderOpenId;
            persistFeishuAuthorizedOpenId(senderOpenId);
            console.log(`[max] Feishu user registered: ${senderOpenId}`);
            await sendChunkedReply(
              event.message.message_id,
              event.message.chat_id,
              "✅ 已授权！您现在可以与 Max 对话了。\n✅ Authorized! You can now control Max."
            );
          }
        }
        return; // don't process further until registered
      } else {
        return;
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

      // ── Pending question: route text as an answer ──────────────
      const pending = pendingQuestions.get(senderOpenId);
      if (pending) {
        if (text === "/max:skip") {
          clearPending(senderOpenId);
          messageHandler.answerUserInput(`feishu:${senderOpenId}`, "(User skipped the question.)");
          return;
        }
        if (text.startsWith("/max:")) {
          // Cancel the question, answer with placeholder, then fall through to process the command.
          clearPending(senderOpenId);
          messageHandler.answerUserInput(`feishu:${senderOpenId}`, "(User sent a command instead of answering.)");
          // fall through
        } else {
          const answer = resolveChoiceAnswer(text, pending.choices);
          clearPending(senderOpenId);
          messageHandler.answerUserInput(`feishu:${senderOpenId}`, answer);
          return;
        }
      }

      // Route and process through unified message handler
      const fullText = await processMessage(
        text,
        senderOpenId,
        event.message.message_id,
        event.message.chat_id,
        messageHandler,
      );

      if (fullText.length > 0) {
        await sendChunkedReply(event.message.message_id, event.message.chat_id, fullText);
      }
    },

    "card.action.trigger": async (data: unknown) => {
      const evt = Lark.normalizeCardAction(data as Lark.RawCardActionEvent);
      if (!evt) return;
      const openId = evt.operator.openId;
      if (openId !== config.feishuAuthorizedOpenId) return;
      const choice = (evt.action.value as { choice?: string } | undefined)?.choice;
      if (!choice) return;
      const pending = pendingQuestions.get(openId);
      if (pending) {
        clearPending(openId);
        messageHandler.answerUserInput(`feishu:${openId}`, choice);
      }
    },
  });

  // Wire up WS → dispatcher on start().
  eventDispatcher = dispatcher;

  return { client, wsClient };
}

export async function startBot(): Promise<void> {
  if (!wsClient || !eventDispatcher) throw new Error("Feishu bot not created");
  console.log("[max] Feishu bot starting...");
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
