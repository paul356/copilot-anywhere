/**
 * Delegate (attention proxy) core logic.
 *
 * Two functions:
 *   1. extractGoal() — from user messages, extract the user's goal
 *   2. check() — compare goal vs recent conversation, return "完成" or "继续\n..."
 *
 * Both call an external LLM. Supports openai-compatible and anthropic APIs.
 */

import { config } from "./config.js";

// ── Types ──────────────────────────────────────────────────────────

type ProviderType = "openai" | "anthropic";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature: number;
}

interface ChatCompletionResponse {
  choices: { message: { content: string } }[];
}

/** Anthropic messages API request body */
interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

interface AnthropicResponse {
  content: { type: string; text: string }[];
}

// ── Internal helpers ───────────────────────────────────────────────

const DELEGATE_TIMEOUT_MS = 30_000; // 30s per LLM call

/**
 * Call the external LLM with the given messages.
 * Dispatches to openai-compatible or anthropic API based on provider type.
 * Returns the content string, or throws on error/timeout.
 */
async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const baseUrl = config.delegateBaseUrl!;
  const apiKey = config.delegateApiKey!;
  const model = config.delegateModel!;
  const maxTokens = config.delegatePromptLength;
  const providerType = config.delegateProviderType as ProviderType;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELEGATE_TIMEOUT_MS);

  try {
    if (providerType === "anthropic") {
      return await callAnthropic(baseUrl, apiKey, model, maxTokens, systemPrompt, userPrompt, controller.signal);
    }
    // Default: openai-compatible
    return await callOpenAI(baseUrl, apiKey, model, maxTokens, systemPrompt, userPrompt, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI-compatible chat completion */
async function callOpenAI(
  baseUrl: string,
  apiKey: string,
  model: string,
  maxTokens: number,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";

  const body: ChatCompletionRequest = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature: 0.3,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown");
    throw new Error(`Delegate LLM returned ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!content) throw new Error("Delegate LLM returned empty response");
  return content;
}

/** Anthropic Messages API */
async function callAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  maxTokens: number,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const url = baseUrl.replace(/\/+$/, "") + "/messages";

  const body: AnthropicRequest = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown");
    throw new Error(`Delegate LLM returned ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as AnthropicResponse;
  const content = data.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  if (!content) throw new Error("Delegate LLM returned empty response");
  return content;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Extract the user's goal from recent user messages.
 * Only reads role=user messages — AI responses are excluded (they add noise).
 *
 * Returns the extracted goal text, or a fallback message if extraction fails.
 */
export async function extractGoal(userMessages: string[]): Promise<string> {
  const systemPrompt = [
    "You are a goal extractor. A user has been chatting with an AI coding assistant.",
    "From the following recent user messages, extract what the user ultimately wants to achieve.",
    "The goal should be an objective, verifiable description — not implementation steps.",
    "Output ONLY the goal text, nothing else. Keep it under 100 characters.",
  ].join(" ");

  const userPrompt = userMessages.join("\n---\n");

  try {
    const result = await callLLM(systemPrompt, userPrompt);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[delegate] extractGoal failed: ${msg}`);
    return "(could not extract goal)";
  }
}

/**
 * Check whether the goal has been achieved given the recent conversation.
 *
 * Output format (two-line):
 *   完成
 *   <完成任务后的告知信息>
 *
 *   or:
 *
 *   继续
 *   <下一步需要 Copilot 完成的任务>
 *
 * The caller reads the first line to decide the branch, and strips it
 * before forwarding the rest to Copilot when the verdict is "继续".
 *
 * On error/timeout, returns "继续\n请继续之前的目标。" as a safe fallback.
 */
export async function check(goal: string, conversation: string): Promise<string> {
  const promptLength = config.delegatePromptLength;

  const systemPrompt = [
    "You are a Delegate (attention proxy). The user has set a goal for an AI coding assistant.",
    "You cannot read code or project files — you only see the conversation text.",
    `Current goal: ${goal}`,
    "",
    "Instructions:",
    "- First line must be exactly '完成' (goal achieved) or '继续' (still in progress).",
    "- If the goal was a question and the AI has already provided the answer, output '完成' — the goal is achieved.",
    "- If the AI's response already addresses the user's original request, output '完成'.",
    "- If '完成': second line onward briefly informs the user the goal is done.",
    "- If '继续': second line onward is a prompt for the AI assistant — list what tasks remain.",
    "- Keep the prompt under " + promptLength + " tokens. Be concise.",
    "- Do NOT give implementation steps — only describe what's left to do.",
  ].join("\n");

  const userPrompt = `Recent conversation:\n\n${conversation}`;

  try {
    const result = await callLLM(systemPrompt, userPrompt);
    // Validate first line
    const firstLine = result.split("\n")[0].trim();
    if (firstLine !== "完成" && firstLine !== "继续") {
      console.warn(`[delegate] check() unexpected first line: "${firstLine}", falling back to "继续"`);
      return "继续\n请继续之前的目标。";
    }
    console.log(`[delegate] check() verdict=${firstLine} (${result.length}ch)`);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[delegate] check() failed: ${msg}`);
    return "继续\n请继续之前的目标。";
  }
}
