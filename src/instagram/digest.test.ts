import { afterEach, expect, test } from "bun:test";

import { parseChatbotJob, type ChatbotJob } from "../../contracts/worker-contract";
import type { DispatchResult } from "../chatbot/bridge";
import {
  buildInstagramAnswerJob,
  dispatchWhenFree,
  parseInstagramReplyRequest,
  type InstagramChatMessage,
  type InstagramReplyRequest,
} from "./chat";
import {
  INSTAGRAM_DIGEST_BATCH,
  INSTAGRAM_DIGEST_CONTEXT_MESSAGES,
  INSTAGRAM_DIGEST_IDLE_MS,
  InstagramDigester,
  parseDigestChanges,
} from "./digest";
import { INSTAGRAM_NOTE_LIMIT, InstagramHistoryStore } from "./history";

const THREAD = "340282366841710301281153810149369102554";
const START = Date.parse("2026-10-18T10:00:00Z");
const stores: InstagramHistoryStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function store() {
  let next = 0;
  const history = new InstagramHistoryStore(":memory:", {
    now: () => new Date(START),
    createNoteId: () => `n_${String(next++).padStart(8, "0")}`,
  });
  stores.push(history);
  return history;
}

function message(i: number, overrides: Partial<InstagramChatMessage> = {}) {
  return {
    id: `m${String(i).padStart(4, "0")}`,
    authorId: "111",
    author: "alice",
    text: `text ${i}`,
    timestamp: new Date(START + i * 1000).toISOString(),
    fromSelf: false,
    images: [],
    ...overrides,
  } satisfies InstagramChatMessage;
}

function accepted(content: string): DispatchResult {
  return {
    status: "accepted",
    jobId: "job",
    result: Promise.resolve({ ok: true, content }),
  } as unknown as DispatchResult;
}

function digester(
  history: InstagramHistoryStore,
  content: string,
  options: { now?: number; idle?: boolean } = {},
) {
  const jobs: ChatbotJob[] = [];
  const instance = new InstagramDigester(history, {
    dispatch: (job) => {
      jobs.push(job);
      return accepted(content);
    },
    workerIdle: () => options.idle ?? true,
    now: () => options.now ?? START + 60_000,
  });
  return { instance, jobs };
}

const NO_CHANGES = JSON.stringify({ changes: [] });

test("waits for a full batch or a quiet group before digesting", async () => {
  const history = store();
  history.record(THREAD, [message(1), message(2)]);
  const early = digester(history, NO_CHANGES);
  expect(await early.instance.digest(THREAD)).toBe("not_due");
  expect(early.jobs).toHaveLength(0);

  const quiet = digester(history, NO_CHANGES, {
    now: START + INSTAGRAM_DIGEST_IDLE_MS + 5_000,
  });
  expect(await quiet.instance.digest(THREAD)).toEqual({ applied: 0, digested: 2 });
  // 整理過的不會再整理一次
  expect(await quiet.instance.digest(THREAD)).toBe("not_due");
});

test("digests a full batch right away, with earlier messages as context only", async () => {
  const history = store();
  history.record(
    THREAD,
    Array.from({ length: 20 }, (_, i) => message(i)),
  );
  history.applyDigest(THREAD, [], { ts: Date.parse(message(19).timestamp), id: message(19).id });
  history.record(
    THREAD,
    Array.from({ length: INSTAGRAM_DIGEST_BATCH }, (_, i) => message(100 + i)),
  );
  const { instance, jobs } = digester(history, NO_CHANGES);
  await instance.digest(THREAD);

  const job = jobs[0]!;
  expect(job.purpose).toBe("chat_digest");
  if (job.purpose !== "chat_digest") return;
  expect(job.requesterUserId).toBe("ig:digest");
  expect(job.channelId).toBe(`ig:${THREAD}`);
  expect(job.digestFromMessageId).toBe(message(100).id);
  expect(job.messages).toHaveLength(INSTAGRAM_DIGEST_CONTEXT_MESSAGES + INSTAGRAM_DIGEST_BATCH);
  expect(job.messages[0]?.id).toBe(message(10).id);
  // 送出去的 job 要能通過 worker 那邊的檢查
  expect(parseChatbotJob(JSON.parse(JSON.stringify(job)))).not.toBeNull();
});

test("never takes a worker slot while anything else is running", async () => {
  const history = store();
  history.record(THREAD, Array.from({ length: INSTAGRAM_DIGEST_BATCH }, (_, i) => message(i)));
  const { instance, jobs } = digester(history, NO_CHANGES, { idle: false });
  expect(await instance.digest(THREAD)).toBe("worker_busy");
  expect(jobs).toHaveLength(0);
});

test("applies valid changes and skips the rest", async () => {
  const history = store();
  history.applyDigest(THREAD, [{ action: "add", content: "舊筆記" }], { ts: 0, id: "" });
  history.record(THREAD, Array.from({ length: INSTAGRAM_DIGEST_BATCH }, (_, i) => message(i)));
  const content = JSON.stringify({
    changes: [
      { action: "add", noteId: null, content: "  shao_1_0_0_9 的「性轉」梗：\n10/18 開始  " },
      { action: "replace", noteId: "n_00000000", content: "舊筆記（更新）" },
      { action: "remove", noteId: "n_missing", content: null },
      { action: "add", noteId: null, content: "x".repeat(201) },
      { action: "add", noteId: null, content: "隱藏​字" },
    ],
  });
  const { instance } = digester(history, content);
  expect(await instance.digest(THREAD)).toEqual({ applied: 2, digested: INSTAGRAM_DIGEST_BATCH });
  expect(history.notes(THREAD).map((note) => note.content).sort()).toEqual([
    "shao_1_0_0_9 的「性轉」梗： 10/18 開始",
    "舊筆記（更新）",
  ]);
});

test("stops adding once the notes are full", () => {
  const history = store();
  const many = Array.from({ length: INSTAGRAM_NOTE_LIMIT + 3 }, (_, i) => ({
    action: "add" as const,
    content: `note ${i}`,
  }));
  expect(history.applyDigest(THREAD, many, { ts: 0, id: "" })).toBe(INSTAGRAM_NOTE_LIMIT);
  expect(history.notes(THREAD)).toHaveLength(INSTAGRAM_NOTE_LIMIT);
});

test("keeps the messages for a retry when the worker fails, then backs off", async () => {
  const history = store();
  history.record(THREAD, Array.from({ length: INSTAGRAM_DIGEST_BATCH }, (_, i) => message(i)));
  const failing = new InstagramDigester(history, {
    dispatch: () =>
      ({
        status: "accepted",
        jobId: "job",
        result: Promise.resolve({ ok: false, error: "boom" }),
      }) as unknown as DispatchResult,
    workerIdle: () => true,
    now: () => START,
  });
  expect(await failing.digest(THREAD)).toBe("failed");
  expect(await failing.digest(THREAD)).toBe("backing_off");
  expect(history.undigested(THREAD, 100)).toHaveLength(INSTAGRAM_DIGEST_BATCH);
});

test("parses only well-formed changes", () => {
  expect(parseDigestChanges("not json")).toBeNull();
  expect(parseDigestChanges("{}")).toBeNull();
  expect(
    parseDigestChanges(
      JSON.stringify({
        changes: [
          { action: "add", noteId: null, content: "a" },
          { action: "replace", noteId: null, content: "b" },
          { action: "remove", noteId: "n_1", content: null },
          { action: "explode" },
        ],
      }),
    ),
  ).toEqual([
    { action: "add", content: "a" },
    { action: "remove", noteId: "n_1" },
  ]);
});

test("hands the notes to her with every reply", () => {
  const history = store();
  history.applyDigest(THREAD, [{ action: "add", content: "允成永遠遲到" }], { ts: 0, id: "" });
  const input = parseInstagramReplyRequest(
    { threadId: THREAD, requestMessageId: message(1).id, messages: [message(1)] },
    history,
  ) as InstagramReplyRequest;
  const job = buildInstagramAnswerJob(input, "token");
  expect(job.serverMemory?.entries).toEqual([{ id: "n_00000000", content: "允成永遠遲到" }]);
  expect(job.capabilities?.map((c) => c.id)).toContain("group_notes");
  expect(parseChatbotJob(JSON.parse(JSON.stringify(job)))).not.toBeNull();

  const empty = buildInstagramAnswerJob({ ...input, notes: [] }, "token");
  expect(empty.serverMemory).toBeUndefined();
  expect(empty.capabilities?.map((c) => c.id)).not.toContain("group_notes");
});

test("waits for a free worker slot instead of failing the reply", async () => {
  const results: DispatchResult[] = [
    { status: "busy" },
    { status: "busy" },
    accepted("{}"),
  ];
  let waited = 0;
  const result = await dispatchWhenFree(
    () => results.shift()!,
    async () => {
      waited += 1;
    },
  );
  expect(result.status).toBe("accepted");
  expect(waited).toBe(2);

  const offline = await dispatchWhenFree(
    () => ({ status: "offline" }),
    async () => {
      throw new Error("should not wait when offline");
    },
  );
  expect(offline.status).toBe("offline");
});
