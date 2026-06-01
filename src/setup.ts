import * as readline from "readline";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { CopilotClient } from "@github/copilot-sdk";
import { ensureMaxHome, ENV_PATH, MAX_HOME } from "./paths.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const FALLBACK_MODELS = [
  { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6", desc: "Fast, great for most tasks" },
  { id: "gpt-5.1", label: "GPT-5.1", desc: "OpenAI's fast model" },
  { id: "gpt-4.1", label: "GPT-4.1", desc: "Free included model" },
];

async function fetchModels(): Promise<{ id: string; label: string; desc: string }[]> {
  let client: CopilotClient | undefined;
  try {
    client = new CopilotClient({ autoStart: true });
    await client.start();
    const models = await client.listModels();
    return models
      .filter((m) => m.policy?.state === "enabled" && !m.name.includes("(Internal only)"))
      .map((m) => {
        const mult = m.billing?.multiplier;
        const desc =
          mult === 0 || mult === undefined ? "Included with Copilot" : `Premium (${mult}x)`;
        return { id: m.id, label: m.name, desc };
      });
  } catch {
    return [];
  } finally {
    try { await client?.stop(); } catch { /* best-effort */ }
  }
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function askRequired(
  rl: readline.Interface,
  prompt: string,
  requiredMsg?: string,
): Promise<string> {
  while (true) {
    const answer = (await ask(rl, prompt)).trim();
    if (answer) return answer;
    console.log(requiredMsg ?? `${YELLOW}  This field is required. Please enter a value.${RESET}`);
  }
}

async function askYesNo(
  rl: readline.Interface,
  question: string,
  defaultYes = false,
): Promise<boolean> {
  const hint = defaultYes ? "(Y/n)" : "(y/N)";
  const answer = (await ask(rl, `${question} ${hint} `)).trim().toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

async function askPicker(
  rl: readline.Interface,
  label: string,
  options: { id: string; label: string; desc: string }[],
  defaultId: string,
  pickerPrompt?: (n: number) => string,
): Promise<string> {
  console.log(`${BOLD}${label}${RESET}\n`);
  const defaultIdx = Math.max(0, options.findIndex((o) => o.id === defaultId));
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIdx ? `${GREEN}▸${RESET}` : " ";
    const tag = i === defaultIdx ? ` ${DIM}(default)${RESET}` : "";
    console.log(`  ${marker} ${CYAN}${i + 1}${RESET}  ${options[i].label}${tag}`);
    console.log(`       ${DIM}${options[i].desc}${RESET}`);
  }
  console.log();
  const prompt = pickerPrompt
    ? pickerPrompt(options.length)
    : `  Pick a number ${DIM}(1-${options.length}, Enter for default)${RESET}: `;
  const input = await ask(rl, prompt);
  const num = parseInt(input.trim(), 10);
  if (num >= 1 && num <= options.length) return options[num - 1].id;
  return options[defaultIdx].id;
}

// ── i18n ─────────────────────────────────────────────────────────────────────
type Lang = "en" | "zh";

const en = {
  configDir: (p: string) => `${DIM}Config directory: ${p}${RESET}`,
  pressEnter: `${DIM}Press Enter to continue...${RESET}`,
  pressEnterDone: `  ${DIM}Press Enter when done (or skip)...${RESET}`,
  required: `${YELLOW}  This field is required. Please enter a value.${RESET}`,
  invalidUserId: `${YELLOW}  That doesn't look like a valid user ID. It should be a positive number.${RESET}`,

  intro: {
    title: `${BOLD}Meet Max${RESET}`,
    desc: [
      `Max is your personal AI assistant — an always-on daemon that runs on`,
      `your machine. Talk to him in plain English and he'll handle the rest.`,
    ],
    capTitle: `${CYAN}What Max can do out of the box:${RESET}`,
    caps: [
      `  • Have conversations and answer questions`,
      `  • Spin up Copilot CLI sessions to code, debug, and run commands`,
      `  • Manage multiple background tasks simultaneously`,
      `  • See and attach to any Copilot session on your machine`,
    ],
    talkTitle: `${CYAN}How to talk to Max:${RESET}`,
    talkLines: [
      `  • ${BOLD}Terminal${RESET} — ${CYAN}max tui${RESET} — always available, no setup needed`,
      `  • ${BOLD}Telegram${RESET} — control Max from your phone (optional)`,
      `  • ${BOLD}Feishu${RESET}   — for users in mainland China (optional)`,
    ],
  },

  telegram: {
    title: `${BOLD}━━━ Telegram Setup (optional) ━━━${RESET}`,
    desc: [
      `Telegram lets you talk to Max from your phone — send messages,`,
      `dispatch coding tasks, and get notified when background work finishes.`,
    ],
    question: "Would you like to set up Telegram?",
    skip: `\n${DIM}  Skipping Telegram. You can always set it up later with: max setup${RESET}\n`,
    step1Title: `\n${BOLD}Step 1: Create a Telegram bot${RESET}\n`,
    step1: [
      `  1. Open Telegram and search for ${BOLD}@BotFather${RESET}`,
      `  2. Send ${CYAN}/newbot${RESET} and follow the prompts`,
      `  3. Copy the bot token (looks like ${DIM}123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11${RESET})`,
    ],
    tokenPrompt: (current: string) =>
      `  Bot token${current ? ` ${DIM}(current: ${current.slice(0, 12)}...)${RESET}` : ""}: `,
    step2Title: `\n${BOLD}Step 2: Lock down your bot${RESET}\n`,
    step2: [
      `${YELLOW}  ⚠  IMPORTANT: Your bot is currently open to anyone on Telegram.${RESET}`,
      `  Max uses your Telegram user ID to ensure only YOU can control it.`,
      `  Without this, anyone who finds your bot could send it commands.`,
      ``,
      `  To get your user ID:`,
      `  1. Search for ${BOLD}@userinfobot${RESET} on Telegram`,
      `  2. Send it any message`,
      `  3. It will reply with your user ID (a number like ${DIM}123456789${RESET})`,
    ],
    userIdPrompt: (current: string) =>
      `  Your user ID${current ? ` ${DIM}(current: ${current})${RESET}` : ""}: `,
    locked: (id: string) =>
      `\n${GREEN}  ✓ Telegram locked down — only user ${id} can control Max.${RESET}`,
    step3Title: `\n${BOLD}Step 3: Disable group joins (recommended)${RESET}\n`,
    step3: [
      `  For extra security, prevent your bot from being added to groups:`,
      `  1. Go back to ${BOLD}@BotFather${RESET}`,
      `  2. Send ${CYAN}/mybots${RESET} → select your bot → ${CYAN}Bot Settings${RESET} → ${CYAN}Allow Groups?${RESET}`,
      `  3. Set to ${BOLD}Disable${RESET}`,
    ],
  },

  feishu: {
    title: `${BOLD}━━━ Feishu Setup (optional) ━━━${RESET}`,
    desc: [
      `Feishu (飞书) is the chat app available in mainland China. If you can't`,
      `use Telegram, this lets you talk to Max from your phone instead.`,
    ],
    question: "Would you like to set up Feishu?",
    skip: `\n${DIM}  Skipping Feishu. You can always set it up later with: max setup${RESET}\n`,
    step1Title: `\n${BOLD}Step 1: Choose your Feishu region${RESET}\n`,
    regionLines: [
      `  ${CYAN}1${RESET}  ${BOLD}Feishu${RESET} — mainland China (open.feishu.cn) ${DIM}(default)${RESET}`,
      `  ${CYAN}2${RESET}  ${BOLD}Lark${RESET}   — international (open.larksuite.com)`,
    ],
    regionPrompt: `  Pick a number ${DIM}(1-2, Enter for default)${RESET}: `,
    step2Title: `\n${BOLD}Step 2: Create a self-built app${RESET}\n`,
    step2: (url: string) => [
      `  1. Open ${CYAN}${url}${RESET} and sign in`,
      `  2. Go to ${BOLD}Developer Console${RESET} → ${BOLD}Create Custom App${RESET}`,
      `  3. Under ${BOLD}Add features${RESET}, enable ${BOLD}Bot${RESET}`,
      `  4. Under ${BOLD}Event Subscriptions${RESET}, switch transport to ${BOLD}Long connection (WebSocket)${RESET}`,
      `  5. Subscribe to the event ${CYAN}im.message.receive_v1${RESET}`,
      `  6. Under ${BOLD}Permissions & Scopes${RESET}, grant:`,
      `       ${CYAN}im:message${RESET}, ${CYAN}im:message:send_as_bot${RESET}`,
      `  7. ${BOLD}Create a version${RESET} of the app and publish it (or enable test mode)`,
      `  8. Copy the ${BOLD}App ID${RESET} and ${BOLD}App Secret${RESET} from the ${BOLD}Credentials & Basic Info${RESET} page`,
    ],
    appIdPrompt: (current: string) =>
      `  App ID${current ? ` ${DIM}(current: ${current.slice(0, 8)}...)${RESET}` : ""}: `,
    appSecretPrompt: (current: string) =>
      `  App Secret${current ? ` ${DIM}(current set)${RESET}` : ""}: `,
    step3Title: `\n${BOLD}Step 3: Pair your Feishu account${RESET}\n`,
    step3: [
      `  When your bot receives a DM from an unpaired user, it generates a`,
      `  one-time ${BOLD}pairing code${RESET} valid for 5 minutes and prints it in the terminal.`,
      `  Send that code back to the bot and Max will authorize you automatically.`,
      `  Only one account can be paired at a time. Use /max:unpair to reset.`,
    ],
    chatName: "Feishu",
  },

  model: {
    title: `\n${BOLD}━━━ Default Model ━━━${RESET}\n`,
    fetching: `${DIM}Fetching available models from Copilot...${RESET}`,
    fetchFailed: `${YELLOW}  Could not fetch models (Copilot CLI may not be authenticated yet).${RESET}`,
    fetchFallback: `${DIM}  Showing a curated list — you can switch anytime after setup.${RESET}\n`,
    fetchSuccess: (n: number) => `${GREEN}  ✓ Found ${n} models${RESET}\n`,
    switchHint: `${DIM}You can switch models anytime by telling Max "switch to gpt-4.1"${RESET}\n`,
    pickerLabel: "Choose a default model:",
    pickerPrompt: (n: number) =>
      `  Pick a number ${DIM}(1-${n}, Enter for default)${RESET}: `,
    chosen: (label: string) => `\n${GREEN}  ✓ Using ${label}${RESET}\n`,
  },

  done: {
    ready: `${GREEN}${BOLD}✅ Max is ready!${RESET}`,
    configSaved: (p: string) => `${DIM}Config saved to ${p}${RESET}`,
    getStarted: `${BOLD}Get started:${RESET}`,
    step1: [`  ${CYAN}1.${RESET} Make sure Copilot CLI is authenticated:`, `     ${BOLD}copilot login${RESET}`],
    step2: [`  ${CYAN}2.${RESET} Start Max:`, `     ${BOLD}max start${RESET}`],
    step3Label: (label: string) => `  ${CYAN}3.${RESET} ${label}`,
    step3Cmd: (cmd: string) => `     ${BOLD}${cmd}${RESET}`,
    thingsToTry: `${BOLD}Things to try:${RESET}`,
    tryLines: [
      `  ${DIM}"Start working on the auth bug in ~/dev/myapp"${RESET}`,
      `  ${DIM}"What sessions are running?"${RESET}`,
      `  ${DIM}"Switch to gpt-4.1"${RESET}`,
    ],
    chatLabelNone: "Connect via terminal:",
    chatLabelOne: (dest: string) => `Open ${dest} and message your bot!`,
    chatLabelMulti: (dests: string[]) => `Open ${dests.join(" or ")} and message your bot!`,
    chatCommandNone: "max tui",
    chatCommandChat: "(message your bot in chat)",
  },
};

const zh: typeof en = {
  configDir: (p: string) => `${DIM}配置目录：${p}${RESET}`,
  pressEnter: `${DIM}按回车继续...${RESET}`,
  pressEnterDone: `  ${DIM}完成后按回车（或跳过）...${RESET}`,
  required: `${YELLOW}  此项为必填，请输入内容。${RESET}`,
  invalidUserId: `${YELLOW}  用户 ID 格式不正确，应为正整数。${RESET}`,

  intro: {
    title: `${BOLD}认识 Max${RESET}`,
    desc: [
      `Max 是您的个人 AI 助手 — 一个始终运行在本机的后台服务。`,
      `用自然语言与它交流，剩下的交给它来处理。`,
    ],
    capTitle: `${CYAN}Max 开箱即用的功能：${RESET}`,
    caps: [
      `  • 对话与问答`,
      `  • 启动 Copilot CLI 会话，进行编程、调试、执行命令`,
      `  • 同时管理多个后台任务`,
      `  • 查看并接管本机上的任意 Copilot 会话`,
    ],
    talkTitle: `${CYAN}与 Max 交流的方式：${RESET}`,
    talkLines: [
      `  • ${BOLD}终端${RESET}     — ${CYAN}max tui${RESET} — 随时可用，无需配置`,
      `  • ${BOLD}Telegram${RESET} — 通过手机控制 Max（可选）`,
      `  • ${BOLD}飞书${RESET}     — 中国大陆用户可用（可选）`,
    ],
  },

  telegram: {
    title: `${BOLD}━━━ Telegram 配置（可选）━━━${RESET}`,
    desc: [
      `Telegram 可让您在手机上向 Max 发送消息、分配编程任务，`,
      `并在后台工作完成时收到通知。`,
    ],
    question: "是否配置 Telegram？",
    skip: `\n${DIM}  已跳过 Telegram。可随时通过 max setup 进行配置。${RESET}\n`,
    step1Title: `\n${BOLD}步骤 1：创建 Telegram 机器人${RESET}\n`,
    step1: [
      `  1. 打开 Telegram，搜索 ${BOLD}@BotFather${RESET}`,
      `  2. 发送 ${CYAN}/newbot${RESET} 并按提示操作`,
      `  3. 复制机器人令牌（格式如 ${DIM}123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11${RESET}）`,
    ],
    tokenPrompt: (current: string) =>
      `  机器人令牌${current ? ` ${DIM}（当前：${current.slice(0, 12)}...）${RESET}` : ""}：`,
    step2Title: `\n${BOLD}步骤 2：锁定机器人${RESET}\n`,
    step2: [
      `${YELLOW}  ⚠  重要：您的机器人目前对所有 Telegram 用户开放。${RESET}`,
      `  Max 使用您的 Telegram 用户 ID 确保只有您能控制它。`,
      `  若不设置，任何找到您机器人的人都可以向它发送命令。`,
      ``,
      `  获取用户 ID 的方法：`,
      `  1. 在 Telegram 搜索 ${BOLD}@userinfobot${RESET}`,
      `  2. 发送任意消息`,
      `  3. 它会回复您的用户 ID（如 ${DIM}123456789${RESET}）`,
    ],
    userIdPrompt: (current: string) =>
      `  您的用户 ID${current ? ` ${DIM}（当前：${current}）${RESET}` : ""}：`,
    locked: (id: string) =>
      `\n${GREEN}  ✓ 已锁定 Telegram — 只有用户 ${id} 可以控制 Max。${RESET}`,
    step3Title: `\n${BOLD}步骤 3：禁止加入群组（推荐）${RESET}\n`,
    step3: [
      `  为了额外安全，禁止机器人被添加到群组：`,
      `  1. 返回 ${BOLD}@BotFather${RESET}`,
      `  2. 发送 ${CYAN}/mybots${RESET} → 选择您的机器人 → ${CYAN}Bot Settings${RESET} → ${CYAN}Allow Groups?${RESET}`,
      `  3. 设为 ${BOLD}Disable${RESET}`,
    ],
  },

  feishu: {
    title: `${BOLD}━━━ 飞书配置（可选）━━━${RESET}`,
    desc: [
      `飞书（Feishu）是中国大陆广泛使用的即时通讯应用。`,
      `如果您无法使用 Telegram，可以用飞书通过手机与 Max 交流。`,
    ],
    question: "是否配置飞书？",
    skip: `\n${DIM}  已跳过飞书。可随时通过 max setup 进行配置。${RESET}\n`,
    step1Title: `\n${BOLD}步骤 1：选择地区${RESET}\n`,
    regionLines: [
      `  ${CYAN}1${RESET}  ${BOLD}飞书${RESET} — 中国大陆 (open.feishu.cn)${DIM}（默认）${RESET}`,
      `  ${CYAN}2${RESET}  ${BOLD}Lark${RESET} — 国际版 (open.larksuite.com)`,
    ],
    regionPrompt: `  请选择 ${DIM}(1-2，回车默认)${RESET}：`,
    step2Title: `\n${BOLD}步骤 2：创建自建应用${RESET}\n`,
    step2: (url: string) => [
      `  1. 打开 ${CYAN}${url}${RESET} 并登录`,
      `  2. 进入 ${BOLD}开发者后台${RESET} → ${BOLD}创建企业自建应用${RESET}`,
      `  3. 在 ${BOLD}添加应用能力${RESET} 中启用 ${BOLD}机器人${RESET}`,
      `  4. 在 ${BOLD}事件订阅${RESET} 中，将传输方式改为 ${BOLD}长连接（WebSocket）${RESET}`,
      `  5. 订阅事件 ${CYAN}im.message.receive_v1${RESET}`,
      `  6. 在 ${BOLD}权限管理${RESET} 中授予：`,
      `       ${CYAN}im:message${RESET}、${CYAN}im:message:send_as_bot${RESET}`,
      `  7. ${BOLD}创建版本${RESET}并发布（或开启测试模式）`,
      `  8. 从 ${BOLD}凭证与基础信息${RESET} 页面复制 ${BOLD}App ID${RESET} 和 ${BOLD}App Secret${RESET}`,
    ],
    appIdPrompt: (current: string) =>
      `  App ID${current ? ` ${DIM}（当前：${current.slice(0, 8)}...）${RESET}` : ""}：`,
    appSecretPrompt: (current: string) =>
      `  App Secret${current ? ` ${DIM}（已设置）${RESET}` : ""}：`,
    step3Title: `\n${BOLD}步骤 3：配对飞书账号${RESET}\n`,
    step3: [
      `  当机器人收到未配对用户的私信时，会生成一个有效期 5 分钟的配对码，`,
      `  并打印在终端中。将该码回复给机器人，Max 将自动完成授权。`,
      `  每次只能配对一个账号。使用 /max:unpair 可重置配对。`,
    ],
    chatName: "飞书",
  },

  model: {
    title: `\n${BOLD}━━━ 默认模型 ━━━${RESET}\n`,
    fetching: `${DIM}正在从 Copilot 获取可用模型...${RESET}`,
    fetchFailed: `${YELLOW}  无法获取模型列表（Copilot CLI 可能尚未完成认证）。${RESET}`,
    fetchFallback: `${DIM}  显示预设列表 — 配置完成后可随时切换。${RESET}\n`,
    fetchSuccess: (n: number) => `${GREEN}  ✓ 找到 ${n} 个模型${RESET}\n`,
    switchHint: `${DIM}您可以随时告诉 Max "切换到 gpt-4.1" 来更换模型${RESET}\n`,
    pickerLabel: "选择默认模型：",
    pickerPrompt: (n: number) =>
      `  请输入编号 ${DIM}(1-${n}，回车选择默认)${RESET}：`,
    chosen: (label: string) => `\n${GREEN}  ✓ 已选择 ${label}${RESET}\n`,
  },

  done: {
    ready: `${GREEN}${BOLD}✅ Max 已就绪！${RESET}`,
    configSaved: (p: string) => `${DIM}配置已保存至 ${p}${RESET}`,
    getStarted: `${BOLD}快速开始：${RESET}`,
    step1: [`  ${CYAN}1.${RESET} 确保 Copilot CLI 已完成认证：`, `     ${BOLD}copilot login${RESET}`],
    step2: [`  ${CYAN}2.${RESET} 启动 Max：`, `     ${BOLD}max start${RESET}`],
    step3Label: (label: string) => `  ${CYAN}3.${RESET} ${label}`,
    step3Cmd: (cmd: string) => `     ${BOLD}${cmd}${RESET}`,
    thingsToTry: `${BOLD}试试这些：${RESET}`,
    tryLines: [
      `  ${DIM}"开始修复 ~/dev/myapp 中的 auth bug"${RESET}`,
      `  ${DIM}"当前有哪些会话在运行？"${RESET}`,
      `  ${DIM}"切换到 gpt-4.1"${RESET}`,
    ],
    chatLabelNone: "通过终端连接：",
    chatLabelOne: (dest: string) => `打开 ${dest} 给您的机器人发消息！`,
    chatLabelMulti: (dests: string[]) => `打开 ${dests.join(" 或 ")} 给机器人发消息！`,
    chatCommandNone: "max tui",
    chatCommandChat: "（在聊天中给机器人发消息）",
  },
};

const S: Record<Lang, typeof en> = { en, zh };

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Banner (always bilingual)
  console.log(`
${BOLD}╔══════════════════════════════════════════╗
║           🤖  Max Setup                  ║
╚══════════════════════════════════════════╝${RESET}
`);

  // Language selection
  console.log(`Language / 语言\n`);
  console.log(`  ${CYAN}1${RESET}  English`);
  console.log(`  ${CYAN}2${RESET}  中文（简体）`);
  console.log();
  const langInput = (
    await ask(rl, `  Pick / 请选择 ${DIM}(1-2, Enter for English / 回车默认英文)${RESET}: `)
  ).trim();
  const lang: Lang = langInput === "2" ? "zh" : "en";
  const L = S[lang];

  console.log(`\n${L.configDir(MAX_HOME)}\n`);

  ensureMaxHome();

  // Load existing values if any
  const existing: Record<string, string> = {};
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) existing[match[1]] = match[2];
    }
  }

  // ── Intro ────────────────────────────────────────────────
  console.log(L.intro.title);
  for (const line of L.intro.desc) console.log(line);
  console.log();
  console.log(L.intro.capTitle);
  for (const line of L.intro.caps) console.log(line);
  console.log();
  console.log(L.intro.talkTitle);
  for (const line of L.intro.talkLines) console.log(line);
  console.log();

  await ask(rl, L.pressEnter);
  console.log();

  // ── Telegram ─────────────────────────────────────────────
  console.log(`\n${L.telegram.title}\n`);
  for (const line of L.telegram.desc) console.log(line);
  console.log();

  let telegramToken = existing.TELEGRAM_BOT_TOKEN || "";
  let userId = existing.AUTHORIZED_USER_ID || "";

  const setupTelegram = await askYesNo(rl, L.telegram.question);

  if (setupTelegram) {
    console.log(L.telegram.step1Title);
    for (const line of L.telegram.step1) console.log(line);
    console.log();

    telegramToken = await askRequired(rl, L.telegram.tokenPrompt(telegramToken), L.required);

    console.log(L.telegram.step2Title);
    for (const line of L.telegram.step2) console.log(line);
    console.log();

    while (true) {
      const userIdInput = await askRequired(rl, L.telegram.userIdPrompt(userId), L.required);
      const parsed = parseInt(userIdInput, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        userId = userIdInput;
        break;
      }
      console.log(L.invalidUserId);
    }

    console.log(L.telegram.locked(userId));

    console.log(L.telegram.step3Title);
    for (const line of L.telegram.step3) console.log(line);
    console.log();

    await ask(rl, L.pressEnterDone);
  } else {
    console.log(L.telegram.skip);
  }

  // ── Feishu ───────────────────────────────────────────────
  console.log(`\n${L.feishu.title}\n`);
  for (const line of L.feishu.desc) console.log(line);
  console.log();

  let feishuAppId = existing.FEISHU_APP_ID || "";
  let feishuAppSecret = existing.FEISHU_APP_SECRET || "";
  let feishuDomain = (existing.FEISHU_DOMAIN as "feishu" | "lark" | undefined) || "feishu";

  const setupFeishu = await askYesNo(rl, L.feishu.question);

  if (setupFeishu) {
    console.log(L.feishu.step1Title);
    for (const line of L.feishu.regionLines) console.log(line);
    console.log();
    const domainInput = (await ask(rl, L.feishu.regionPrompt)).trim();
    feishuDomain = domainInput === "2" ? "lark" : "feishu";
    const consoleUrl =
      feishuDomain === "lark"
        ? "https://open.larksuite.com"
        : "https://open.feishu.cn";

    console.log(L.feishu.step2Title);
    for (const line of L.feishu.step2(consoleUrl)) console.log(line);
    console.log();

    feishuAppId = await askRequired(rl, L.feishu.appIdPrompt(feishuAppId), L.required);
    feishuAppSecret = await askRequired(rl, L.feishu.appSecretPrompt(feishuAppSecret), L.required);

    console.log(L.feishu.step3Title);
    for (const line of L.feishu.step3) console.log(line);
    console.log();
  } else {
    console.log(L.feishu.skip);
  }

  // ── Model ────────────────────────────────────────────────
  console.log(L.model.title);
  console.log(L.model.fetching);

  let models = await fetchModels();
  if (models.length === 0) {
    console.log(L.model.fetchFailed);
    console.log(L.model.fetchFallback);
    models = FALLBACK_MODELS;
  } else {
    console.log(L.model.fetchSuccess(models.length));
  }

  console.log(L.model.switchHint);

  const currentModel = existing.COPILOT_MODEL || "claude-sonnet-4.6";
  const model = await askPicker(
    rl,
    L.model.pickerLabel,
    models,
    currentModel,
    L.model.pickerPrompt,
  );
  const modelLabel = models.find((m) => m.id === model)?.label || model;
  console.log(L.model.chosen(modelLabel));

  // ── Write config ─────────────────────────────────────────
  const apiPort = existing.API_PORT || "7777";
  const lines: string[] = [];
  if (telegramToken) lines.push(`TELEGRAM_BOT_TOKEN=${telegramToken}`);
  if (userId) lines.push(`AUTHORIZED_USER_ID=${userId}`);
  if (feishuAppId) lines.push(`FEISHU_APP_ID=${feishuAppId}`);
  if (feishuAppSecret) lines.push(`FEISHU_APP_SECRET=${feishuAppSecret}`);
  if (existing.FEISHU_AUTHORIZED_OPEN_ID) lines.push(`FEISHU_AUTHORIZED_OPEN_ID=${existing.FEISHU_AUTHORIZED_OPEN_ID}`);
  if (feishuAppId || feishuAppSecret) lines.push(`FEISHU_DOMAIN=${feishuDomain}`);
  lines.push(`API_PORT=${apiPort}`);
  lines.push(`COPILOT_MODEL=${model}`);

  writeFileSync(ENV_PATH, lines.join("\n") + "\n");

  // ── Done ─────────────────────────────────────────────────
  const chatDestinations: string[] = [];
  if (telegramToken && userId) chatDestinations.push("Telegram");
  if (feishuAppId && feishuAppSecret) {
    chatDestinations.push(feishuDomain === "lark" ? "Lark" : L.feishu.chatName);
  }

  const chatLabel =
    chatDestinations.length === 0 ? L.done.chatLabelNone :
    chatDestinations.length === 1 ? L.done.chatLabelOne(chatDestinations[0]) :
    L.done.chatLabelMulti(chatDestinations);
  const chatCommand =
    chatDestinations.length === 0 ? L.done.chatCommandNone : L.done.chatCommandChat;

  console.log(`
${L.done.ready}
${L.done.configSaved(ENV_PATH)}

${L.done.getStarted}

${L.done.step1.join("\n")}

${L.done.step2.join("\n")}

${L.done.step3Label(chatLabel)}
${L.done.step3Cmd(chatCommand)}

${L.done.thingsToTry}

${L.done.tryLines.join("\n")}
`);

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
