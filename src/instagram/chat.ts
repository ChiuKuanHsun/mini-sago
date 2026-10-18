import { randomUUID, timingSafeEqual } from "node:crypto";

import type {
  AnswerJob,
  ChatbotAddressingMode,
  ChatbotAttachment,
  ChatbotMessage,
} from "../../contracts/worker-contract";
import { parseChatbotAnswerDecision } from "../../contracts/answer-contract";
import { macAgentBridge } from "../chatbot/bridge";
import { registerChatbotMcpSession } from "../chatbot/mcp";
import { ChatbotMediaRegistry } from "../chatbot/media-assets";

// IG 群組的訊息由筆電上的 instagrapi 轉接程式送進來 這裡只負責包成 AnswerJob
// 交給 worker 再把回覆的純文字交回去。發送、輪詢、冷卻都在轉接程式那端。
// 照 chatbot/voice-chat.ts 的做法 歷史訊息由呼叫端提供 不註冊任何 Discord 工具。
// 跟 Discord 共用的只有 bridge、MCP session 與媒體登記表 IG 的規則都留在這個資料夾。

export const INSTAGRAM_HISTORY_LIMIT = 30;
// 被 @ 的那則和它回覆的那則一定帶 其餘只留最近幾張 每張都要下載給模型看 太多會拖慢回覆
export const INSTAGRAM_HISTORY_IMAGE_LIMIT = 3;
const INSTAGRAM_TEXT_LIMIT = 2_000;
// 多圖貼文每一張都給她看 跟 worker 一次最多看的附件數一致
export const INSTAGRAM_IMAGES_PER_MESSAGE = 10;
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const INSTAGRAM_CDN_SUFFIXES = [".cdninstagram.com", ".fbcdn.net"];
const INSTAGRAM_ADDRESSING_MODES = new Set<ChatbotAddressingMode>([
  "mention",
  "reply",
  "continuation",
]);
const INSTAGRAM_REACTION_MAX_LENGTH = 16;

export type InstagramImage = {
  url: string;
  contentType: string;
};

export type InstagramChatMessage = {
  id: string;
  authorId: string;
  author: string;
  authorName?: string;
  text: string;
  timestamp: string;
  fromSelf: boolean;
  replyToId?: string;
  images: InstagramImage[];
};

export type InstagramReplyRequest = {
  threadId: string;
  threadTitle?: string;
  requestMessageId: string;
  // mention＝被 @、reply＝回覆她的訊息、continuation＝她剛回完的人接著講 沒有明確叫她
  addressingMode: ChatbotAddressingMode;
  messages: InstagramChatMessage[];
};

function stringField(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

export function isInstagramCdnUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      INSTAGRAM_CDN_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))
    );
  } catch {
    return false;
  }
}

function parseImages(value: unknown): InstagramImage[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > INSTAGRAM_IMAGES_PER_MESSAGE)
    return null;
  const images: InstagramImage[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const image = raw as Record<string, unknown>;
    const url = stringField(image.url, 2_000);
    const contentType = stringField(image.contentType, 40)?.toLowerCase();
    if (!url || !isInstagramCdnUrl(url)) return null;
    if (!contentType || !Object.hasOwn(IMAGE_EXTENSIONS, contentType)) return null;
    images.push({ url, contentType });
  }
  return images;
}

function parseMessage(value: unknown): InstagramChatMessage | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const id = stringField(body.id, 100);
  const authorId = stringField(body.authorId, 40);
  const author = stringField(body.author, 60);
  const timestamp = stringField(body.timestamp, 40);
  if (!id || !authorId || !author || !timestamp) return null;
  if (!/^\d+$/u.test(authorId) || Number.isNaN(Date.parse(timestamp)))
    return null;
  if (typeof body.text !== "string" || typeof body.fromSelf !== "boolean")
    return null;
  const images = parseImages(body.images);
  if (!images) return null;
  return {
    id,
    authorId,
    author,
    authorName: stringField(body.authorName, 100),
    text: body.text.slice(0, INSTAGRAM_TEXT_LIMIT),
    timestamp,
    fromSelf: body.fromSelf,
    replyToId: stringField(body.replyToId, 100),
    images,
  };
}

export function parseInstagramReplyRequest(
  value: unknown,
): InstagramReplyRequest | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const threadId = stringField(body.threadId, 100);
  const requestMessageId = stringField(body.requestMessageId, 100);
  if (!threadId || !/^\d+$/u.test(threadId) || !requestMessageId) return null;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null;
  const addressingMode = body.addressingMode ?? "mention";
  if (!INSTAGRAM_ADDRESSING_MODES.has(addressingMode as ChatbotAddressingMode))
    return null;

  const messages: InstagramChatMessage[] = [];
  for (const raw of body.messages.slice(-INSTAGRAM_HISTORY_LIMIT)) {
    const message = parseMessage(raw);
    if (!message) return null;
    messages.push(message);
  }
  const request = messages.find((message) => message.id === requestMessageId);
  if (!request || request.fromSelf) return null;

  return {
    threadId,
    threadTitle: stringField(body.threadTitle, 100),
    requestMessageId,
    addressingMode: addressingMode as ChatbotAddressingMode,
    messages,
  };
}

// IG 的表情只能是一般 Unicode emoji Discord 的自訂表情 <:name:id> 在這裡不存在
export function toInstagramReaction(value: string | undefined) {
  const emoji = value?.trim();
  if (!emoji || emoji.length > INSTAGRAM_REACTION_MAX_LENGTH) return undefined;
  const onlyEmoji =
    /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f)+$/u;
  // 國旗由區域指示符號組成 不算 Extended_Pictographic 要另外認
  const hasPicture = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
  return onlyEmoji.test(emoji) && hasPicture.test(emoji)
    ? emoji
    : undefined;
}

// IG 只顯示純文字 模型偶爾還是會照 Discord 的習慣輸出 Markdown 這裡把常見的拆掉。
export function toInstagramPlainText(text: string) {
  return text
    .replace(/<\/?self-introduction>/gu, "")
    .replace(/```[^\n]*\n?([\s\S]*?)```/gu, "$1")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gu, "$1 $2")
    // 只拆 ** 不拆 __ IG 帳號名稱常有連續底線
    .replace(/\*\*(.+?)\*\*/gu, "$1")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/^>\s?/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function imageAttachments(message: InstagramChatMessage): ChatbotAttachment[] {
  return message.images.map((image, index) => ({
    id: `${message.id}-${index}`,
    filename: `instagram-${message.id}-${index}.${IMAGE_EXTENSIONS[image.contentType]}`,
    contentType: image.contentType,
    // IG 不提供大小 worker 下載時會照實際位元組數檢查上限
    size: 0,
    url: image.url,
  }));
}

// 決定哪些訊息的圖片要交給模型：被 @ 的那則、它回覆的那則，加上最近幾張。
function messagesWithVisibleImages(input: InstagramReplyRequest) {
  const request = input.messages.find(
    (message) => message.id === input.requestMessageId,
  );
  const visible = new Set<string>(
    [request?.id, request?.replyToId].filter((id): id is string => !!id),
  );
  let budget = INSTAGRAM_HISTORY_IMAGE_LIMIT;
  for (const message of [...input.messages].reverse()) {
    if (budget <= 0) break;
    if (message.images.length === 0 || visible.has(message.id)) continue;
    visible.add(message.id);
    budget -= message.images.length;
  }
  return visible;
}

function chatbotMessage(
  message: InstagramChatMessage,
  channelId: string,
  channelName: string,
  withImages: boolean,
): Omit<ChatbotMessage, "referencedMessage"> {
  return {
    id: message.id,
    role: message.fromSelf ? "assistant" : "user",
    author: message.author,
    ...(message.authorName && message.authorName !== message.author
      ? { authorAliases: [message.authorName] }
      : {}),
    timestamp: message.timestamp,
    content: message.text,
    attachments: withImages ? imageAttachments(message) : [],
    channelId,
    channelName,
  };
}

export function buildInstagramMessages(input: InstagramReplyRequest) {
  const channelId = `ig:${input.threadId}`;
  const channelName = input.threadTitle
    ? `Instagram group: ${input.threadTitle}`
    : "Instagram group";
  const visible = messagesWithVisibleImages(input);
  const base = new Map(
    input.messages.map((message) => [
      message.id,
      chatbotMessage(message, channelId, channelName, visible.has(message.id)),
    ]),
  );
  return input.messages.map((message): ChatbotMessage => {
    const referenced = message.replyToId
      ? base.get(message.replyToId)
      : undefined;
    return {
      ...base.get(message.id)!,
      ...(referenced ? { referencedMessage: referenced } : {}),
    };
  });
}

export function buildInstagramAnswerJob(
  input: InstagramReplyRequest,
  mcpAccessToken: string,
): AnswerJob {
  const messages = buildInstagramMessages(input);
  const requestMessage = messages.find(
    (message) => message.id === input.requestMessageId,
  )!;
  const requester = input.messages.find(
    (message) => message.id === input.requestMessageId,
  )!;
  return {
    id: randomUUID(),
    // 加上 ig: 前綴 永遠不會等於 owner 的 Discord ID 所以 IG 上的人一律是一般成員。
    requesterUserId: `ig:${requester.authorId}`,
    purpose: "answer",
    channelId: `ig:${input.threadId}`,
    requestMessageId: input.requestMessageId,
    request: requestMessage.content,
    requestMessage,
    messages: messages.filter(
      (message) => message.id !== input.requestMessageId,
    ),
    mcpAccessToken,
    addressingMode: input.addressingMode,
    capabilities: [
      {
        id: "conversation",
        category: "conversation",
        availability: "available",
        description:
          "This conversation is an Instagram group chat, not Discord. Reply in the requester's language, as a short chat message (usually one to three sentences unless they ask for detail). Photos, stickers, and the cover image of shared Reels or posts are attached as images when available; older ones appear only as a bracketed placeholder such as [分享了 @someone 的 Reels]. Messages authored by \"Meta AI\" come from Instagram's built-in AI assistant that members can summon; it is not a group member and not you. Instagram shows plain text only: no Markdown, headings, bold, tables, code blocks, embeds, or Discord mentions. Refer to people by their Instagram username. No Discord tools, server memory, reminders, or files are available here.",
      },
      {
        id: "message_reactions",
        category: "conversation",
        availability: "available",
        description:
          "React to the current Instagram message with one standard Unicode emoji when a reaction communicates something the reply does not. Custom or Discord-only emoji are not available.",
      },
    ],
    executionRoute: "chat",
  };
}

export type InstagramReplyResult =
  | { status: "answered"; reply?: string; reaction?: string }
  | { status: "silent" }
  | { status: "unavailable" }
  | { status: "failed" };

// answer job 的附件 worker 不自己下載 而是經由 MCP 向 core 的媒體登記表要
// 沒登記的圖 worker 只會拿到 Media is unavailable 所以要跟 Discord 一樣先登記。
export function buildInstagramMediaRegistry(input: InstagramReplyRequest) {
  const registry = new ChatbotMediaRegistry(fetch, (url) =>
    isInstagramCdnUrl(url.toString()),
  );
  registry.registerMessages(buildInstagramMessages(input));
  return registry;
}

export async function respondToInstagramMessage(
  input: InstagramReplyRequest,
): Promise<InstagramReplyResult> {
  const history = buildInstagramMessages(input).filter(
    (message) => message.id !== input.requestMessageId,
  );
  const mcpSession = registerChatbotMcpSession({
    mediaRegistry: buildInstagramMediaRegistry(input),
    resolveContext: async () => ({
      history: { status: "complete", messages: history },
      search: { status: "not_requested", results: [] },
      members: { status: "not_requested", results: [] },
      previousTrace: { status: "not_requested" },
    }),
  });
  try {
    const dispatch = macAgentBridge.dispatch(
      buildInstagramAnswerJob(input, mcpSession.token),
      ["chat"],
    );
    if (dispatch.status !== "accepted") return { status: "unavailable" };
    const result = await dispatch.result;
    if (!result.ok) return { status: "failed" };
    const decision = parseChatbotAnswerDecision(result.content);
    const reply = decision.reply ? toInstagramPlainText(decision.reply) : "";
    const reaction = toInstagramReaction(decision.reactionEmoji);
    if (!reply && !reaction) return { status: "silent" };
    return {
      status: "answered",
      ...(reply ? { reply } : {}),
      ...(reaction ? { reaction } : {}),
    };
  } catch (error) {
    console.warn(
      `Could not prepare Instagram reply: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return { status: "failed" };
  } finally {
    mcpSession.revoke();
  }
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function configuredSecret() {
  const secret = process.env.MINISAGO_INSTAGRAM_BRIDGE_SECRET?.trim();
  return secret && Buffer.byteLength(secret) >= 32 ? secret : undefined;
}

export async function handleInstagramReplyRequest(
  request: Request,
  respond: typeof respondToInstagramMessage = respondToInstagramMessage,
) {
  const secret = configuredSecret();
  if (!secret) return new Response("Not configured.\n", { status: 503 });

  const token = /^Bearer (.+)$/u.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (!token || !safeEqual(token, secret)) {
    return new Response("Unauthorized.\n", { status: 401 });
  }

  let input: InstagramReplyRequest | null = null;
  try {
    input = parseInstagramReplyRequest(await request.json());
  } catch {
    // 壞掉的 JSON 跟其他不合格的內容一樣處理。
  }
  if (!input) return new Response("Invalid request.\n", { status: 400 });

  const result = await respond(input);
  switch (result.status) {
    case "answered":
      return Response.json({
        reply: result.reply ?? null,
        reaction: result.reaction ?? null,
      });
    case "silent":
      return Response.json({ reply: null, reaction: null });
    case "unavailable":
      return Response.json({ error: "worker_unavailable" }, { status: 503 });
    case "failed":
      return Response.json({ error: "reply_failed" }, { status: 502 });
  }
}
