import { afterEach, expect, test } from "bun:test";

import {
  handleInstagramObserveRequest,
  handleInstagramReplyRequest,
  INSTAGRAM_CONTEXT_LIMIT,
  parseInstagramReplyRequest,
  type InstagramChatMessage,
  type InstagramReplyRequest,
} from "./chat";
import { InstagramHistoryStore } from "./history";

const SECRET = "s".repeat(32);
const THREAD = "340282366841710301281153810149369102554";
const originalSecret = process.env.MINISAGO_INSTAGRAM_BRIDGE_SECRET;
const stores: InstagramHistoryStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  if (originalSecret === undefined)
    delete process.env.MINISAGO_INSTAGRAM_BRIDGE_SECRET;
  else process.env.MINISAGO_INSTAGRAM_BRIDGE_SECRET = originalSecret;
});

function store(now = "2026-10-18T12:00:00Z") {
  const history = new InstagramHistoryStore(":memory:", {
    now: () => new Date(now),
  });
  stores.push(history);
  return history;
}

const at = (minute: number) =>
  `2026-10-18T10:${String(minute).padStart(2, "0")}:00Z`;

function message(
  id: string,
  minute: number,
  overrides: Partial<InstagramChatMessage> = {},
): InstagramChatMessage {
  return {
    id,
    authorId: "111",
    author: "alice",
    text: `text ${id}`,
    timestamp: at(minute),
    fromSelf: false,
    images: [],
    ...overrides,
  };
}

function post(path: string, payload: unknown) {
  return new Request(`http://core/api/internal/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(payload),
  });
}

test("returns stored messages up to a point in time, oldest first, without images", () => {
  const history = store();
  history.record(THREAD, [
    message("a", 1, {
      images: [{ url: "https://x.cdninstagram.com/a.jpg", contentType: "image/jpeg" }],
      authorName: "Alice Chen",
      replyToId: "z",
    }),
    message("b", 2, { fromSelf: true, author: "nino" }),
    message("c", 3),
  ]);
  history.record("999", [message("other", 2)]);

  const before = history.before(THREAD, at(2), 10);
  expect(before.map((m) => m.id)).toEqual(["a", "b"]);
  expect(before[0]).toEqual({
    ...message("a", 1),
    authorName: "Alice Chen",
    replyToId: "z",
  });
  expect(before[1]?.fromSelf).toBe(true);
  expect(history.before(THREAD, at(3), 2).map((m) => m.id)).toEqual(["b", "c"]);
});

test("keeps the longer text when the same message arrives again", () => {
  const history = store();
  history.record(THREAD, [message("a", 1, { text: "[分享了一則貼文]\n貼文說明：好吃" })]);
  history.record(THREAD, [message("a", 1, { text: "[分享了一則貼文]" })]);
  expect(history.before(THREAD, at(1), 1)[0]?.text).toBe("[分享了一則貼文]\n貼文說明：好吃");
});

test("forgets messages past the retention period", () => {
  const history = new InstagramHistoryStore(":memory:", {
    now: () => new Date("2026-10-18T12:00:00Z"),
    retentionDays: 1,
  });
  stores.push(history);
  history.record(THREAD, [
    message("old", 0, { timestamp: "2026-10-16T12:00:00Z" }),
    message("new", 0),
  ]);
  expect(history.before(THREAD, at(0), 10).map((m) => m.id)).toEqual(["new"]);
});

test("adds stored history in front of what the bridge sent, never past the request", () => {
  const history = store();
  history.record(THREAD, [
    message("s1", 1),
    message("s2", 2),
    // 轉接程式送的那則有圖 存的沒有
    message("live1", 3),
    message("later", 9),
  ]);
  const photo = { url: "https://x.cdninstagram.com/p.jpg", contentType: "image/jpeg" };
  const input = parseInstagramReplyRequest(
    {
      threadId: THREAD,
      requestMessageId: "req",
      messages: [
        { ...message("live1", 3), images: [photo] },
        message("req", 4, { text: "@nino 記得嗎" }),
      ],
    },
    history,
  ) as InstagramReplyRequest;

  expect(input.messages.map((m) => m.id)).toEqual(["s1", "s2", "live1", "req"]);
  expect(input.messages[2]?.images).toEqual([photo]);
  // 被叫的那一批也會存進去
  expect(history.before(THREAD, at(4), 10).map((m) => m.id)).toContain("req");
});

test("caps the merged history", () => {
  const history = store();
  const many = Array.from({ length: INSTAGRAM_CONTEXT_LIMIT + 10 }, (_, i) =>
    message(`m${i}`, 0, { timestamp: new Date(Date.parse(at(0)) + i * 1000).toISOString() }),
  );
  history.record(THREAD, many);
  const last = many.at(-1)!;
  const input = parseInstagramReplyRequest(
    { threadId: THREAD, requestMessageId: last.id, messages: [last] },
    history,
  ) as InstagramReplyRequest;
  expect(input.messages).toHaveLength(INSTAGRAM_CONTEXT_LIMIT);
  expect(input.messages.at(-1)?.id).toBe(last.id);
});

test("still answers from what the bridge sent when the history store fails", () => {
  const broken = {
    record() {
      throw new Error("disk full");
    },
    before() {
      return [];
    },
  };
  const input = parseInstagramReplyRequest(
    { threadId: THREAD, requestMessageId: "req", messages: [message("req", 4)] },
    broken,
  );
  expect(input?.messages.map((m) => m.id)).toEqual(["req"]);
});

test("stores observed messages and rejects bad ones", async () => {
  process.env.MINISAGO_INSTAGRAM_BRIDGE_SECRET = SECRET;
  const history = store();
  const ok = await handleInstagramObserveRequest(
    post("instagram-observe", { threadId: THREAD, messages: [message("a", 1)] }),
    history,
  );
  expect(await ok.json()).toEqual({ stored: 1 });
  expect(history.before(THREAD, at(1), 10).map((m) => m.id)).toEqual(["a"]);

  for (const bad of [
    { threadId: "abc", messages: [] },
    { threadId: THREAD, messages: [{ id: "x" }] },
    { threadId: THREAD, messages: Array.from({ length: 101 }, (_, i) => message(`m${i}`, 1)) },
  ]) {
    expect(
      (await handleInstagramObserveRequest(post("instagram-observe", bad), history)).status,
    ).toBe(400);
  }

  const unauthorized = new Request("http://core/api/internal/instagram-observe", {
    method: "POST",
    body: "{}",
  });
  expect((await handleInstagramObserveRequest(unauthorized, history)).status).toBe(401);
});

test("the reply endpoint reads stored history", async () => {
  process.env.MINISAGO_INSTAGRAM_BRIDGE_SECRET = SECRET;
  const history = store();
  history.record(THREAD, [message("yesterday-joke", 1, { text: "允成又遲到了" })]);
  let seen: InstagramReplyRequest | undefined;
  await handleInstagramReplyRequest(
    post("instagram-reply", {
      threadId: THREAD,
      requestMessageId: "req",
      messages: [message("req", 5)],
    }),
    async (input) => {
      seen = input;
      return { status: "silent" };
    },
    history,
  );
  expect(seen?.messages.map((m) => m.text)).toEqual(["允成又遲到了", "text req"]);
});
