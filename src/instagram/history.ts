import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { InstagramChatMessage } from "./chat";

// IG 群組的完整聊天紀錄。轉接程式每一輪輪詢都把看到的新訊息送過來（不管有沒有叫她），
// 被叫的時候就能拿到比 IG 一次給的 20 則更早的前文。
// 圖片網址帶有效期限的簽章 過幾天就失效 所以只存文字；要看圖還是靠轉接程式當下送來的那幾則。

export const INSTAGRAM_HISTORY_RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Row = {
  id: string;
  author_id: string;
  author: string;
  author_name: string | null;
  text: string;
  timestamp: string;
  from_self: number;
  reply_to_id: string | null;
};

type InstagramHistoryOptions = {
  now?: () => Date;
  retentionDays?: number;
};

export class InstagramHistoryStore {
  private readonly db: Database;
  private readonly now: () => Date;
  private readonly retentionMs: number;
  private lastPrunedAt = 0;

  constructor(path: string, options: InstagramHistoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.retentionMs =
      (options.retentionDays ?? INSTAGRAM_HISTORY_RETENTION_DAYS) * DAY_MS;
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        thread_id TEXT NOT NULL,
        id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author TEXT NOT NULL,
        author_name TEXT,
        text TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        ts INTEGER NOT NULL,
        from_self INTEGER NOT NULL,
        reply_to_id TEXT,
        PRIMARY KEY (thread_id, id)
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS messages_by_time ON messages (thread_id, ts)",
    );
  }

  // 同一則可能被送很多次（每輪輪詢、被叫時的請求）。她要回的那則會多帶貼文說明，
  // 所以文字只換成比較長的版本，不會被之後的精簡版蓋掉。
  record(threadId: string, messages: InstagramChatMessage[]) {
    const upsert = this.db.prepare(`
      INSERT INTO messages
        (thread_id, id, author_id, author, author_name, text, timestamp, ts, from_self, reply_to_id)
      VALUES
        ($threadId, $id, $authorId, $author, $authorName, $text, $timestamp, $ts, $fromSelf, $replyToId)
      ON CONFLICT (thread_id, id) DO UPDATE SET
        author = excluded.author,
        author_name = coalesce(excluded.author_name, author_name),
        text = CASE WHEN length(excluded.text) > length(text) THEN excluded.text ELSE text END,
        reply_to_id = coalesce(excluded.reply_to_id, reply_to_id)
    `);
    this.db.transaction(() => {
      for (const message of messages) {
        upsert.run({
          threadId,
          id: message.id,
          authorId: message.authorId,
          author: message.author,
          authorName: message.authorName ?? null,
          text: message.text,
          timestamp: message.timestamp,
          ts: Date.parse(message.timestamp),
          fromSelf: message.fromSelf ? 1 : 0,
          replyToId: message.replyToId ?? null,
        });
      }
    })();
    this.pruneIfDue();
  }

  // 某個時間點（含）之前最新的 limit 則，舊到新
  before(threadId: string, timestamp: string, limit: number) {
    const rows = this.db
      .query<Row, [string, number, number]>(
        `SELECT id, author_id, author, author_name, text, timestamp, from_self, reply_to_id
           FROM messages
          WHERE thread_id = ? AND ts <= ?
          ORDER BY ts DESC
          LIMIT ?`,
      )
      .all(threadId, Date.parse(timestamp), limit);
    return rows.reverse().map(toMessage);
  }

  private pruneIfDue() {
    const now = this.now().getTime();
    if (now - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    this.lastPrunedAt = now;
    this.db
      .query("DELETE FROM messages WHERE ts < ?")
      .run(now - this.retentionMs);
  }

  close() {
    this.db.close();
  }
}

function toMessage(row: Row): InstagramChatMessage {
  return {
    id: row.id,
    authorId: row.author_id,
    author: row.author,
    ...(row.author_name ? { authorName: row.author_name } : {}),
    text: row.text,
    timestamp: row.timestamp,
    fromSelf: row.from_self === 1,
    ...(row.reply_to_id ? { replyToId: row.reply_to_id } : {}),
    images: [],
  };
}

let configuredStore: InstagramHistoryStore | null | undefined;

// 沒設資料夾就不存（本機開發、測試）；VM 上由 compose.core.yaml 指到 /app/state/instagram
export function getInstagramHistory() {
  if (configuredStore !== undefined) return configuredStore;
  const directory = process.env.MINISAGO_INSTAGRAM_STATE_DIRECTORY?.trim();
  if (!directory) {
    configuredStore = null;
    return configuredStore;
  }
  mkdirSync(directory, { recursive: true });
  configuredStore = new InstagramHistoryStore(join(directory, "history.sqlite"));
  return configuredStore;
}
