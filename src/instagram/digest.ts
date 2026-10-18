import { randomUUID } from "node:crypto";

import type {
  ChatDigestJob,
  ChatbotJob,
} from "../../contracts/worker-contract";
import { macAgentBridge, type DispatchResult } from "../chatbot/bridge";
import { buildInstagramMessages } from "./chat";
import {
  getInstagramHistory,
  type InstagramHistoryStore,
  type InstagramNoteChange,
} from "./history";

// 聊天室筆記：在背景把一段段聊天整理成梗、綽號、進行中的事，被叫時一起交給她。
// 只在 worker 完全閒著時跑，避免佔掉回覆用的名額（worker 一次只跑 2 個 job）。

// 累積這麼多則新訊息就整理一次
export const INSTAGRAM_DIGEST_BATCH = 40;
// 不到一批 但群組安靜這麼久了也整理
export const INSTAGRAM_DIGEST_IDLE_MS = 15 * 60 * 1000;
// 一次最多讀的新訊息 更多的留到下一次
export const INSTAGRAM_DIGEST_MAX_MESSAGES = 150;
// 新訊息前面附上的前文 只用來理解 不整理
export const INSTAGRAM_DIGEST_CONTEXT_MESSAGES = 10;
const DIGEST_CHECK_INTERVAL_MS = 60 * 1000;
const DIGEST_FAILURE_BACKOFF_MS = 10 * 60 * 1000;

type DigestHistory = Pick<
  InstagramHistoryStore,
  "undigested" | "before" | "notes" | "applyDigest" | "threads"
>;

type DigestOptions = {
  dispatch?: (job: ChatbotJob) => DispatchResult;
  workerIdle?: () => boolean;
  now?: () => number;
};

export type DigestOutcome =
  | "not_due"
  | "worker_busy"
  | "running"
  | "backing_off"
  | "failed"
  | { applied: number; digested: number };

export function parseDigestChanges(content: string): InstagramNoteChange[] | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const changes = (value as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return null;
  const parsed: InstagramNoteChange[] = [];
  for (const raw of changes) {
    if (!raw || typeof raw !== "object") continue;
    const { action, noteId, content: text } = raw as Record<string, unknown>;
    if (action === "add" && typeof text === "string") {
      parsed.push({ action, content: text });
    } else if (
      action === "replace" &&
      typeof noteId === "string" &&
      typeof text === "string"
    ) {
      parsed.push({ action, noteId, content: text });
    } else if (action === "remove" && typeof noteId === "string") {
      parsed.push({ action, noteId });
    }
  }
  return parsed;
}

export class InstagramDigester {
  private readonly dispatch: (job: ChatbotJob) => DispatchResult;
  private readonly workerIdle: () => boolean;
  private readonly now: () => number;
  private readonly running = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly history: DigestHistory,
    options: DigestOptions = {},
  ) {
    this.dispatch =
      options.dispatch ?? ((job) => macAgentBridge.dispatch(job, ["chat"]));
    this.workerIdle =
      options.workerIdle ?? (() => macAgentBridge.getWorkerSummary().active === 0);
    this.now = options.now ?? Date.now;
  }

  // 安靜下來的群組要靠定時檢查才會整理
  start() {
    this.timer ??= setInterval(() => {
      for (const threadId of this.history.threads()) {
        void this.digest(threadId).catch(() => undefined);
      }
    }, DIGEST_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async digest(threadId: string): Promise<DigestOutcome> {
    if (this.running.has(threadId)) return "running";
    const failedAt = this.failedAt.get(threadId);
    if (failedAt !== undefined && this.now() - failedAt < DIGEST_FAILURE_BACKOFF_MS)
      return "backing_off";

    const fresh = this.history.undigested(threadId, INSTAGRAM_DIGEST_MAX_MESSAGES);
    const last = fresh.at(-1);
    if (!last) return "not_due";
    const quietFor = this.now() - Date.parse(last.timestamp);
    if (
      fresh.length < INSTAGRAM_DIGEST_BATCH &&
      quietFor < INSTAGRAM_DIGEST_IDLE_MS
    )
      return "not_due";
    if (!this.workerIdle()) return "worker_busy";

    this.running.add(threadId);
    try {
      const first = fresh[0]!;
      const context = this.history
        .before(threadId, first.timestamp, INSTAGRAM_DIGEST_CONTEXT_MESSAGES + 1)
        .filter((message) => message.id !== first.id)
        .slice(-INSTAGRAM_DIGEST_CONTEXT_MESSAGES);
      const job = buildInstagramDigestJob(
        threadId,
        [...context, ...fresh],
        first.id,
        this.history.notes(threadId),
      );
      const dispatch = this.dispatch(job);
      if (dispatch.status !== "accepted") return "worker_busy";
      const result = await dispatch.result;
      const changes = result.ok ? parseDigestChanges(result.content) : null;
      if (!changes) {
        this.failedAt.set(threadId, this.now());
        return "failed";
      }
      this.failedAt.delete(threadId);
      const applied = this.history.applyDigest(threadId, changes, {
        ts: Date.parse(last.timestamp),
        id: last.id,
      });
      console.log(
        `Instagram notes: digested ${fresh.length} messages, applied ${applied} of ${changes.length} changes.`,
      );
      return { applied, digested: fresh.length };
    } catch (error) {
      this.failedAt.set(threadId, this.now());
      console.warn(
        `Could not digest Instagram chat: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return "failed";
    } finally {
      this.running.delete(threadId);
    }
  }
}

export function buildInstagramDigestJob(
  threadId: string,
  messages: ReturnType<DigestHistory["undigested"]>,
  fromMessageId: string,
  notes: ReturnType<DigestHistory["notes"]>,
): ChatDigestJob {
  const chatbotMessages = buildInstagramMessages({
    threadId,
    requestMessageId: messages.at(-1)!.id,
    addressingMode: "mention",
    messages,
  });
  return {
    id: randomUUID(),
    // 跟回覆一樣加 ig: 前綴 永遠不會是 owner
    requesterUserId: "ig:digest",
    purpose: "chat_digest",
    channelId: `ig:${threadId}`,
    requestMessageId: messages.at(-1)!.id,
    request: "",
    messages: chatbotMessages,
    digestNotes: notes,
    digestFromMessageId: fromMessageId,
  };
}

let configuredDigester: InstagramDigester | null | undefined;

export function getInstagramDigester() {
  if (configuredDigester !== undefined) return configuredDigester;
  const history = getInstagramHistory();
  configuredDigester = history ? new InstagramDigester(history) : null;
  configuredDigester?.start();
  return configuredDigester;
}
