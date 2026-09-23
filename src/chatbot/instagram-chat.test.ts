import { afterEach, expect, test } from "bun:test";

import {
  buildInstagramAnswerJob,
  handleInstagramReplyRequest,
  INSTAGRAM_HISTORY_LIMIT,
  parseInstagramReplyRequest,
  toInstagramPlainText,
  type InstagramReplyRequest,
} from "./instagram-chat";

const SECRET = "s".repeat(32);
const originalSecret = process.env.MINISAGO_INSTAGRAM_BRIDGE_SECRET;

afterEach(() => {
  if (originalSecret === undefined)
    delete process.env.MINISAGO_INSTAGRAM_BRIDGE_SECRET;
  else process.env.MINISAGO_INSTAGRAM_BRIDGE_SECRET = originalSecret;
});

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    authorId: "111",
    author: "alice",
    text: "@nino hi",
    timestamp: "2026-09-23T12:00:00Z",
    fromSelf: false,
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "340282366841710301281153810149369102554",
    threadTitle: "group",
    requestMessageId: "m2",
    messages: [
      message({ id: "m1", text: "earlier", authorName: "Alice Chen" }),
      message({ id: "m2", replyToId: "m1" }),
    ],
    ...overrides,
  };
}

function post(payload: unknown, token: string | null = SECRET) {
  return new Request("http://core/api/internal/instagram-reply", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

test("parses a valid request and keeps only the newest history", () => {
  const many = Array.from({ length: INSTAGRAM_HISTORY_LIMIT + 5 }, (_, i) =>
    message({ id: `m${i}` }),
  );
  const parsed = parseInstagramReplyRequest(
    body({ messages: many, requestMessageId: `m${many.length - 1}` }),
  );
  expect(parsed?.messages).toHaveLength(INSTAGRAM_HISTORY_LIMIT);
  expect(parsed?.messages[0]?.id).toBe("m5");
});

test("rejects requests she should never answer", () => {
  expect(parseInstagramReplyRequest(body({ requestMessageId: "missing" }))).toBeNull();
  expect(
    parseInstagramReplyRequest(
      body({ messages: [message({ id: "m2", fromSelf: true })] }),
    ),
  ).toBeNull();
  expect(parseInstagramReplyRequest(body({ threadId: "abc" }))).toBeNull();
  expect(
    parseInstagramReplyRequest(body({ messages: [message({ id: "m2", authorId: "x" })] })),
  ).toBeNull();
  expect(parseInstagramReplyRequest(body({ messages: [] }))).toBeNull();
});

test("never treats an Instagram user as the Discord owner", () => {
  const input = parseInstagramReplyRequest(body()) as InstagramReplyRequest;
  const job = buildInstagramAnswerJob(input, "token");
  expect(job.requesterUserId).toBe("ig:111");
  expect(job.channelId).toBe(`ig:${input.threadId}`);
  expect(job.executionRoute).toBe("chat");
  expect(job.streamReply).toBeUndefined();
});

test("builds history, aliases, and the replied-to message", () => {
  const input = parseInstagramReplyRequest(body()) as InstagramReplyRequest;
  const job = buildInstagramAnswerJob(input, "token");
  expect(job.request).toBe("@nino hi");
  expect(job.messages.map((m) => m.id)).toEqual(["m1"]);
  expect(job.messages[0]?.authorAliases).toEqual(["Alice Chen"]);
  expect(job.requestMessage?.referencedMessage?.content).toBe("earlier");
  expect(job.capabilities?.map((c) => c.id)).toEqual(["conversation"]);
});

test("strips Markdown that Instagram cannot render", () => {
  expect(
    toInstagramPlainText(
      "# 標題\n**重點** 看 `code` 和 [這裡](https://example.com)\n> 引用\n\n\n\n```ts\nconst a = 1;\n```",
    ),
  ).toBe("標題\n重點 看 code 和 這裡 https://example.com\n引用\n\nconst a = 1;");
  expect(toInstagramPlainText("a__b__c 你好")).toBe("a__b__c 你好");
  expect(toInstagramPlainText("<self-introduction>我是二乃</self-introduction>")).toBe(
    "我是二乃",
  );
});

test("refuses to run without a long enough secret", async () => {
  delete process.env.MINISAGO_INSTAGRAM_BRIDGE_SECRET;
  expect((await handleInstagramReplyRequest(post(body()))).status).toBe(503);
  process.env.MINISAGO_INSTAGRAM_BRIDGE_SECRET = "short";
  expect((await handleInstagramReplyRequest(post(body()))).status).toBe(503);
});

test("rejects a missing or wrong token before reading the body", async () => {
  process.env.MINISAGO_INSTAGRAM_BRIDGE_SECRET = SECRET;
  let called = false;
  const respond = async () => {
    called = true;
    return { status: "silent" as const };
  };
  expect((await handleInstagramReplyRequest(post(body(), null), respond)).status).toBe(401);
  expect(
    (await handleInstagramReplyRequest(post(body(), "t".repeat(32)), respond)).status,
  ).toBe(401);
  expect(called).toBe(false);
});

test("maps each outcome to a response", async () => {
  process.env.MINISAGO_INSTAGRAM_BRIDGE_SECRET = SECRET;
  expect((await handleInstagramReplyRequest(post("{not json"))).status).toBe(400);

  const replied = await handleInstagramReplyRequest(post(body()), async () => ({
    status: "replied",
    reply: "幹嘛啦",
  }));
  expect(await replied.json()).toEqual({ reply: "幹嘛啦" });

  const silent = await handleInstagramReplyRequest(post(body()), async () => ({
    status: "silent",
  }));
  expect(await silent.json()).toEqual({ reply: null });

  const unavailable = await handleInstagramReplyRequest(post(body()), async () => ({
    status: "unavailable",
  }));
  expect(unavailable.status).toBe(503);

  const failed = await handleInstagramReplyRequest(post(body()), async () => ({
    status: "failed",
  }));
  expect(failed.status).toBe(502);
});
