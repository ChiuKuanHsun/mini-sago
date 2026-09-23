import { randomUUID, timingSafeEqual } from "node:crypto";

import type {
  AnswerJob,
  ChatbotMessage,
} from "../../contracts/worker-contract";
import { parseChatbotAnswerDecision } from "../../contracts/answer-contract";
import { macAgentBridge } from "./bridge";
import { registerChatbotMcpSession } from "./mcp";

// IG 群組的訊息由筆電上的 instagrapi 轉接程式送進來 這裡只負責包成 AnswerJob
// 交給 worker 再把回覆的純文字交回去。發送、輪詢、冷卻都在轉接程式那端。
// 照 voice-chat.ts 的做法 歷史訊息由呼叫端提供 不註冊任何 Discord 工具。

export const INSTAGRAM_HISTORY_LIMIT = 30;
const INSTAGRAM_TEXT_LIMIT = 2_000;

export type InstagramChatMessage = {
  id: string;
  authorId: string;
  author: string;
  authorName?: string;
  text: string;
  timestamp: string;
  fromSelf: boolean;
  replyToId?: string;
};

export type InstagramReplyRequest = {
  threadId: string;
  threadTitle?: string;
  requestMessageId: string;
  messages: InstagramChatMessage[];
};

function stringField(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
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
  return {
    id,
    authorId,
    author,
    authorName: stringField(body.authorName, 100),
    text: body.text.slice(0, INSTAGRAM_TEXT_LIMIT),
    timestamp,
    fromSelf: body.fromSelf,
    replyToId: stringField(body.replyToId, 100),
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
    messages,
  };
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

function chatbotMessage(
  message: InstagramChatMessage,
  channelId: string,
  channelName: string,
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
    attachments: [],
    channelId,
    channelName,
  };
}

export function buildInstagramMessages(input: InstagramReplyRequest) {
  const channelId = `ig:${input.threadId}`;
  const channelName = input.threadTitle
    ? `Instagram group: ${input.threadTitle}`
    : "Instagram group";
  const base = new Map(
    input.messages.map((message) => [
      message.id,
      chatbotMessage(message, channelId, channelName),
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
    addressingMode: "mention",
    capabilities: [
      {
        id: "conversation",
        category: "conversation",
        availability: "available",
        description:
          "This conversation is an Instagram group chat, not Discord. Reply in the requester's language, as a short chat message (usually one to three sentences unless they ask for detail). Instagram shows plain text only: no Markdown, headings, bold, tables, code blocks, embeds, reactions, or Discord mentions. Refer to people by their Instagram username. No Discord tools, server memory, reminders, or files are available here.",
      },
    ],
    executionRoute: "chat",
  };
}

export type InstagramReplyResult =
  | { status: "replied"; reply: string }
  | { status: "silent" }
  | { status: "unavailable" }
  | { status: "failed" };

export async function respondToInstagramMessage(
  input: InstagramReplyRequest,
): Promise<InstagramReplyResult> {
  const history = buildInstagramMessages(input).filter(
    (message) => message.id !== input.requestMessageId,
  );
  const mcpSession = registerChatbotMcpSession({
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
    const reply = parseChatbotAnswerDecision(result.content).reply;
    const text = reply ? toInstagramPlainText(reply) : "";
    return text ? { status: "replied", reply: text } : { status: "silent" };
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
    case "replied":
      return Response.json({ reply: result.reply });
    case "silent":
      return Response.json({ reply: null });
    case "unavailable":
      return Response.json({ error: "worker_unavailable" }, { status: 503 });
    case "failed":
      return Response.json({ error: "reply_failed" }, { status: 502 });
  }
}
