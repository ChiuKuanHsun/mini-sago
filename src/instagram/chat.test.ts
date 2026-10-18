import { afterEach, expect, test } from "bun:test";

import {
  buildInstagramAnswerJob,
  buildInstagramMediaRegistry,
  handleInstagramReplyRequest,
  INSTAGRAM_HISTORY_IMAGE_LIMIT,
  INSTAGRAM_HISTORY_LIMIT,
  INSTAGRAM_IMAGES_PER_MESSAGE,
  isInstagramCdnUrl,
  parseInstagramReplyRequest,
  toInstagramPlainText,
  toInstagramReaction,
  type InstagramReplyRequest,
} from "./chat";

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
  expect(job.capabilities?.map((c) => c.id)).toEqual([
    "conversation",
    "message_reactions",
  ]);
  expect(job.addressingMode).toBe("mention");
});

const photo = (n: number) => ({
  url: `https://scontent-tpe1-1.cdninstagram.com/v/p${n}.jpg?oe=1`,
  contentType: "image/jpeg",
});

test("only accepts images hosted on Instagram's CDN", () => {
  expect(isInstagramCdnUrl(photo(1).url)).toBe(true);
  expect(isInstagramCdnUrl("https://scontent.xx.fbcdn.net/a.jpg")).toBe(true);
  expect(isInstagramCdnUrl("https://evilcdninstagram.com/a.jpg")).toBe(false);
  expect(isInstagramCdnUrl("http://scontent.cdninstagram.com/a.jpg")).toBe(false);
  expect(
    parseInstagramReplyRequest(
      body({
        messages: [
          message({ id: "m2", images: [{ url: "https://example.com/a.jpg", contentType: "image/jpeg" }] }),
        ],
      }),
    ),
  ).toBeNull();
  for (const contentType of ["text/html", "constructor", "image/svg+xml"]) {
    expect(
      parseInstagramReplyRequest(
        body({ messages: [message({ id: "m2", images: [{ ...photo(1), contentType }] })] }),
      ),
    ).toBeNull();
  }
});

test("attaches the request, its reply target, and only the newest history photos", () => {
  expect(INSTAGRAM_HISTORY_IMAGE_LIMIT).toBe(3);
  const history = Array.from({ length: 6 }, (_, i) =>
    message({ id: `h${i}`, text: "[傳了一張照片或影片]", images: [photo(i)] }),
  );
  const input = parseInstagramReplyRequest(
    body({
      requestMessageId: "req",
      messages: [
        ...history,
        message({ id: "req", text: "@nino 這張呢", images: [photo(9)], replyToId: "h0" }),
      ],
    }),
  ) as InstagramReplyRequest;
  const job = buildInstagramAnswerJob(input, "token");

  expect(job.requestMessage?.attachments.map((a) => a.url)).toEqual([photo(9).url]);
  expect(job.requestMessage?.attachments[0]?.filename).toBe("instagram-req-0.jpg");
  expect(job.requestMessage?.attachments[0]?.contentType).toBe("image/jpeg");
  expect(job.requestMessage?.referencedMessage?.attachments.map((a) => a.url)).toEqual([
    photo(0).url,
  ]);
  const withImages = job.messages
    .filter((m) => m.attachments.length > 0)
    .map((m) => m.id);
  expect(withImages).toEqual(["h0", "h3", "h4", "h5"]);
});

test("registers the attached photos so the worker can read them through core", () => {
  const input = parseInstagramReplyRequest(
    body({
      messages: [
        message({ id: "m1", text: "[傳了一張照片或影片]", images: [photo(1)] }),
        message({ id: "m2", images: [photo(2)] }),
      ],
    }),
  ) as InstagramReplyRequest;
  const registry = buildInstagramMediaRegistry(input);
  expect(registry.get("m1-0")?.filename).toBe("instagram-m1-0.jpg");
  expect(registry.get("m2-0")?.contentType).toBe("image/jpeg");
  expect(registry.get("m3-0")).toBeUndefined();
});

test("passes how she was addressed through to the worker", () => {
  for (const mode of ["mention", "reply", "continuation"] as const) {
    const input = parseInstagramReplyRequest(body({ addressingMode: mode }));
    expect(input?.addressingMode).toBe(mode);
    expect(buildInstagramAnswerJob(input!, "t").addressingMode).toBe(mode);
  }
  expect(parseInstagramReplyRequest(body({ addressingMode: "dm" }))).toBeNull();
  expect(parseInstagramReplyRequest(body({ addressingMode: 1 }))).toBeNull();
});

test("keeps only standard Unicode emoji as Instagram reactions", () => {
  for (const emoji of ["❤️", "👍", "🙄", "👍🏽", "🇹🇼", "🧑‍💻"]) {
    expect(toInstagramReaction(emoji)).toBe(emoji);
  }
  expect(toInstagramReaction(" 😂 ")).toBe("😂");
  for (const bad of [undefined, "", "<:nino:123>", "ok", "1", "#", "👍 nice", "❤️".repeat(20)]) {
    expect(toInstagramReaction(bad)).toBeUndefined();
  }
});

test("accepts every photo of a shared carousel up to the worker's limit", () => {
  expect(INSTAGRAM_IMAGES_PER_MESSAGE).toBe(10);
  const carousel = (n: number) => Array.from({ length: n }, (_, i) => photo(i));
  const ten = parseInstagramReplyRequest(
    body({ messages: [message({ id: "m2", images: carousel(10) })] }),
  ) as InstagramReplyRequest;
  expect(buildInstagramAnswerJob(ten, "t").requestMessage?.attachments).toHaveLength(10);
  expect(
    parseInstagramReplyRequest(
      body({ messages: [message({ id: "m2", images: carousel(11) })] }),
    ),
  ).toBeNull();
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
    status: "answered",
    reply: "幹嘛啦",
    reaction: "🙄",
  }));
  expect(await replied.json()).toEqual({ reply: "幹嘛啦", reaction: "🙄" });

  const reactionOnly = await handleInstagramReplyRequest(post(body()), async () => ({
    status: "answered",
    reaction: "👍",
  }));
  expect(await reactionOnly.json()).toEqual({ reply: null, reaction: "👍" });

  const silent = await handleInstagramReplyRequest(post(body()), async () => ({
    status: "silent",
  }));
  expect(await silent.json()).toEqual({ reply: null, reaction: null });

  const unavailable = await handleInstagramReplyRequest(post(body()), async () => ({
    status: "unavailable",
  }));
  expect(unavailable.status).toBe(503);

  const failed = await handleInstagramReplyRequest(post(body()), async () => ({
    status: "failed",
  }));
  expect(failed.status).toBe(502);
});
