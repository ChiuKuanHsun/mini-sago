import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { InstagramChatMessage } from "./chat";

// IG 群組的完整聊天紀錄。轉接程式每一輪輪詢都把看到的新訊息送過來（不管有沒有叫她），
// 被叫的時候就能拿到比 IG 一次給的 20 則更早的前文。
// 圖片網址帶有效期限的簽章 過幾天就失效 所以只存文字；要看圖還是靠轉接程式當下送來的那幾則。
// 同一個檔案也放聊天室筆記（背景整理出來的梗、綽號、進行中的事）和整理到哪一則的進度。
// 筆記不跟著訊息過期 訊息刪了筆記還在。

export const INSTAGRAM_HISTORY_RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// 跟 worker 的 prompts/chat-digest.ts 一致
export const INSTAGRAM_NOTE_MAX_CHARACTERS = 200;
export const INSTAGRAM_NOTE_LIMIT = 40;
const INVISIBLE_UNICODE_PATTERN =
  /[​-‏‪-‮⁠-⁯﻿]/u;

export type InstagramNote = { id: string; content: string };

export type InstagramNoteChange =
  | { action: "add"; content: string }
  | { action: "replace"; noteId: string; content: string }
  | { action: "remove"; noteId: string };

export type InstagramDigestCursor = { ts: number; id: string };

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
  createNoteId?: () => string;
};

export class InstagramHistoryStore {
  private readonly db: Database;
  private readonly now: () => Date;
  private readonly retentionMs: number;
  private readonly createNoteId: () => string;
  private lastPrunedAt = 0;

  constructor(path: string, options: InstagramHistoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.retentionMs =
      (options.retentionDays ?? INSTAGRAM_HISTORY_RETENTION_DAYS) * DAY_MS;
    this.createNoteId =
      options.createNoteId ?? (() => `n_${randomBytes(4).toString("hex")}`);
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
    this.db.run(`
      CREATE TABLE IF NOT EXISTS notes (
        thread_id TEXT NOT NULL,
        id TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, id)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS digest_cursor (
        thread_id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        id TEXT NOT NULL
      )
    `);
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

  // 給她翻舊帳用：作者比對帳號或名字，內容以空白分開的每個詞都要出現。新到舊。
  // 中文的詞常常只有兩個字 FTS 的 trigram 斷詞找不到 一個群組 30 天的量直接掃就夠快。
  search(
    threadId: string,
    query: { author?: string; content?: string },
    limit: number,
  ) {
    const conditions = ["thread_id = ?"];
    const params: (string | number)[] = [threadId];
    const like = (value: string) =>
      `%${value.toLowerCase().replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
    if (query.author?.trim()) {
      conditions.push(
        "(lower(author) LIKE ? ESCAPE '\\' OR lower(coalesce(author_name, '')) LIKE ? ESCAPE '\\')",
      );
      const author = like(query.author.trim().replace(/^@/u, ""));
      params.push(author, author);
    }
    const terms = query.content?.split(/\s+/u).filter(Boolean) ?? [];
    for (const term of terms) {
      conditions.push("lower(text) LIKE ? ESCAPE '\\'");
      params.push(like(term));
    }
    if (params.length === 1) return [];
    params.push(limit);
    return this.db
      .query<Row, (string | number)[]>(
        `SELECT id, author_id, author, author_name, text, timestamp, from_self, reply_to_id
           FROM messages
          WHERE ${conditions.join(" AND ")}
          ORDER BY ts DESC
          LIMIT ?`,
      )
      .all(...params)
      .map(toMessage);
  }

  // 還沒整理進筆記的訊息 舊到新
  undigested(threadId: string, limit: number) {
    const cursor = this.digestCursor(threadId) ?? { ts: -1, id: "" };
    const rows = this.db
      .query<Row, [string, number, number, string, number]>(
        `SELECT id, author_id, author, author_name, text, timestamp, from_self, reply_to_id
           FROM messages
          WHERE thread_id = ? AND (ts > ? OR (ts = ? AND id > ?))
          ORDER BY ts, id
          LIMIT ?`,
      )
      .all(threadId, cursor.ts, cursor.ts, cursor.id, limit);
    return rows.map(toMessage);
  }

  threads() {
    return this.db
      .query<{ thread_id: string }, []>(
        "SELECT DISTINCT thread_id FROM messages",
      )
      .all()
      .map((row) => row.thread_id);
  }

  digestCursor(threadId: string): InstagramDigestCursor | null {
    return (
      this.db
        .query<InstagramDigestCursor, [string]>(
          "SELECT ts, id FROM digest_cursor WHERE thread_id = ?",
        )
        .get(threadId) ?? null
    );
  }

  notes(threadId: string): InstagramNote[] {
    return this.db
      .query<InstagramNote, [string]>(
        "SELECT id, content FROM notes WHERE thread_id = ? ORDER BY updated_at, id",
      )
      .all(threadId);
  }

  notesRevision(threadId: string) {
    return (
      this.db
        .query<{ revision: number | null }, [string]>(
          "SELECT max(updated_at) AS revision FROM notes WHERE thread_id = ?",
        )
        .get(threadId)?.revision ?? 0
    );
  }

  // 模型給的修改逐條檢查：不存在的 id、超長、塞滿之後的新增都跳過，不讓整批失敗。
  // 修改與整理進度一起寫入 中途掛掉不會重複整理同一段。
  applyDigest(
    threadId: string,
    changes: InstagramNoteChange[],
    cursor: InstagramDigestCursor,
  ) {
    const now = this.now().getTime();
    let applied = 0;
    this.db.transaction(() => {
      const existing = new Set(this.notes(threadId).map((note) => note.id));
      for (const change of changes) {
        if (change.action === "remove") {
          if (!existing.delete(change.noteId)) continue;
          this.db
            .query("DELETE FROM notes WHERE thread_id = ? AND id = ?")
            .run(threadId, change.noteId);
          applied += 1;
          continue;
        }
        const content = normalizedNote(change.content);
        if (!content) continue;
        if (change.action === "replace") {
          if (!existing.has(change.noteId)) continue;
          this.db
            .query(
              "UPDATE notes SET content = ?, updated_at = ? WHERE thread_id = ? AND id = ?",
            )
            .run(content, now, threadId, change.noteId);
          applied += 1;
          continue;
        }
        if (existing.size >= INSTAGRAM_NOTE_LIMIT) continue;
        const id = this.createNoteId();
        existing.add(id);
        this.db
          .query(
            "INSERT INTO notes (thread_id, id, content, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run(threadId, id, content, now);
        applied += 1;
      }
      this.db
        .query(
          `INSERT INTO digest_cursor (thread_id, ts, id) VALUES (?, ?, ?)
           ON CONFLICT (thread_id) DO UPDATE SET ts = excluded.ts, id = excluded.id`,
        )
        .run(threadId, cursor.ts, cursor.id);
    })();
    return applied;
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

function normalizedNote(value: string) {
  const content = value.replace(/\s+/gu, " ").trim();
  if (
    !content ||
    content.length > INSTAGRAM_NOTE_MAX_CHARACTERS ||
    INVISIBLE_UNICODE_PATTERN.test(content)
  )
    return undefined;
  return content;
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
