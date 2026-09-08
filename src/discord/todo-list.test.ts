import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_TODOS, TodoList, type Todo, type TodoNoticeKind } from "./todo-list";

let directory: string;
let stateFile: string;
let clock: Date;
let posted: Todo[];
let notices: Array<{ id: string; kind: TodoNoticeKind }>;
let deleted: string[];
let messageCounter: number;
let noticeCounter: number;

function makeList(overrides: Partial<ConstructorParameters<typeof TodoList>[0]> = {}) {
  return new TodoList({
    stateFile,
    now: () => clock,
    postTodoMessage: async (todo) => {
      posted.push({ ...todo });
      messageCounter += 1;
      return `message-${messageCounter}`;
    },
    postNotice: async (todo, kind) => {
      notices.push({ id: todo.id, kind });
      noticeCounter += 1;
      return `notice-${noticeCounter}`;
    },
    deleteTodoMessages: async (todo) => {
      deleted.push(
        ...(todo.messageId ? [todo.messageId] : []),
        ...(todo.noticeMessageIds ?? []),
      );
    },
    ...overrides,
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "minisago-todos-"));
  stateFile = join(directory, "todos.json");
  clock = new Date("2026-09-08T00:00:00.000Z");
  posted = [];
  notices = [];
  deleted = [];
  messageCounter = 0;
  noticeCounter = 0;
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("todo list", () => {
  test("新增待辦會先貼訊息 再把 message ID 記下來", async () => {
    const list = makeList();
    const todo = await list.add({ content: "  寫 PR review  " });

    expect(todo.content).toBe("寫 PR review");
    expect(todo.messageId).toBe("message-1");
    expect(posted).toHaveLength(1);
    expect(await list.findByMessageId("message-1")).toMatchObject({
      id: todo.id,
    });
  });

  test("cron 待辦會算出下一次到期", async () => {
    const list = makeList();
    const todo = await list.add({
      content: "倒垃圾",
      cron: "0 20 * * 1",
      timezone: "Asia/Taipei",
    });

    expect(todo.cron).toBe("0 20 * * 1");
    // 2026-09-08 是週二 下一個週一晚上八點（台北）是 09-14 12:00Z。
    expect(todo.nextDueAt).toBe("2026-09-14T12:00:00.000Z");
  });

  test("同時給到期時間和 cron 會被擋下來", async () => {
    const list = makeList();
    await expect(
      list.add({
        content: "兩個都給",
        dueAt: "2026-09-09T00:00:00.000Z",
        cron: "0 20 * * 1",
      }),
    ).rejects.toThrow("either a due time or a cron");
  });

  test("到期時間在過去會被擋下來", async () => {
    const list = makeList();
    await expect(
      list.add({ content: "昨天", dueAt: "2026-09-07T00:00:00.000Z" }),
    ).rejects.toThrow("already in the past");
  });

  test("沒有排程就不能設提前提醒", async () => {
    const list = makeList();
    await expect(
      list.add({ content: "沒有到期時間", leadMinutes: 30 }),
    ).rejects.toThrow("needs a due time or a cron");
  });

  test("清單有上限", async () => {
    const list = makeList();
    for (let index = 0; index < MAX_TODOS; index += 1) {
      await list.add({ content: `第 ${index} 筆` });
    }
    await expect(list.add({ content: "滿了" })).rejects.toThrow(
      `already holds ${MAX_TODOS}`,
    );
  });

  test("一次性待辦打勾後刪訊息並從清單消失", async () => {
    const list = makeList();
    const todo = await list.add({ content: "訂機票" });

    const result = await list.complete(todo.id);
    expect(result.recurring).toBe(false);
    expect(deleted).toEqual(["message-1"]);
    expect(await list.list()).toHaveLength(0);
  });

  test("重複待辦打勾只結束這一輪 待辦本身留著", async () => {
    const list = makeList();
    const todo = await list.add({
      content: "倒垃圾",
      cron: "0 20 * * 1",
      timezone: "Asia/Taipei",
    });

    const result = await list.complete(todo.id);
    expect(result.recurring).toBe(true);
    expect(deleted).toEqual(["message-1"]);

    const [remaining] = await list.list();
    expect(remaining?.id).toBe(todo.id);
    expect(remaining?.messageId).toBeUndefined();
    expect(remaining?.nextDueAt).toBe("2026-09-14T12:00:00.000Z");
  });

  test("重複待辦到下一輪到期時重貼一則新訊息", async () => {
    const list = makeList();
    const todo = await list.add({
      content: "倒垃圾",
      cron: "0 20 * * 1",
      timezone: "Asia/Taipei",
    });
    await list.complete(todo.id);
    expect(posted).toHaveLength(1);

    // 還沒到下一輪 什麼都不做。
    clock = new Date("2026-09-10T00:00:00.000Z");
    await list.tick();
    expect(posted).toHaveLength(1);

    clock = new Date("2026-09-14T12:00:00.000Z");
    await list.tick();
    expect(posted).toHaveLength(2);
    const [remaining] = await list.list();
    expect(remaining?.messageId).toBe("message-2");
  });

  test("提前提醒和到期提醒各發一次", async () => {
    const list = makeList();
    await list.add({
      content: "交報告",
      dueAt: "2026-09-08T02:00:00.000Z",
      leadMinutes: 30,
    });

    clock = new Date("2026-09-08T01:00:00.000Z");
    await list.tick();
    expect(notices).toHaveLength(0);

    clock = new Date("2026-09-08T01:35:00.000Z");
    await list.tick();
    await list.tick();
    expect(notices.map((notice) => notice.kind)).toEqual(["lead"]);

    clock = new Date("2026-09-08T02:00:00.000Z");
    await list.tick();
    await list.tick();
    expect(notices.map((notice) => notice.kind)).toEqual(["lead", "due"]);
  });

  test("打勾會把提醒訊息一起收掉", async () => {
    const list = makeList();
    const todo = await list.add({
      content: "交報告",
      dueAt: "2026-09-08T02:00:00.000Z",
      leadMinutes: 30,
    });

    // 提前提醒的窗口在到期那一刻就關了 所以要分兩次。
    clock = new Date("2026-09-08T01:35:00.000Z");
    await list.tick();
    clock = new Date("2026-09-08T02:00:00.000Z");
    await list.tick();
    expect(notices.map((notice) => notice.kind)).toEqual(["lead", "due"]);
    expect((await list.list())[0]?.noticeMessageIds).toEqual([
      "notice-1",
      "notice-2",
    ]);

    await list.complete(todo.id);
    // 待辦本體加上兩則提醒 一個都不留。
    expect(deleted).toEqual(["message-1", "notice-1", "notice-2"]);
  });

  test("重複待辦下一輪不會扛著上一輪的提醒", async () => {
    const list = makeList();
    const todo = await list.add({
      content: "倒垃圾",
      cron: "0 20 * * 1",
      timezone: "Asia/Taipei",
    });

    clock = new Date("2026-09-14T12:00:00.000Z");
    await list.tick();
    expect((await list.list())[0]?.noticeMessageIds).toEqual(["notice-1"]);

    await list.complete(todo.id);
    expect(deleted).toEqual(["message-1", "notice-1"]);
    const [remaining] = await list.list();
    expect(remaining?.noticeMessageIds).toBeUndefined();
  });

  test("改了排程就重新開放提醒", async () => {
    const list = makeList();
    const todo = await list.add({
      content: "交報告",
      dueAt: "2026-09-08T02:00:00.000Z",
    });
    clock = new Date("2026-09-08T02:00:00.000Z");
    await list.tick();
    expect(notices).toHaveLength(1);

    const edited = await list.edit({
      todoId: todo.id,
      dueAt: "2026-09-08T05:00:00.000Z",
    });
    expect(edited.dueNotifiedFor).toBeUndefined();

    clock = new Date("2026-09-08T05:00:00.000Z");
    await list.tick();
    expect(notices).toHaveLength(2);
  });

  test("改成 cron 之後原本的到期時間會被清掉", async () => {
    const list = makeList();
    const todo = await list.add({
      content: "倒垃圾",
      dueAt: "2026-09-09T00:00:00.000Z",
    });

    const edited = await list.edit({
      todoId: todo.id,
      cron: "0 20 * * 1",
      timezone: "Asia/Taipei",
    });
    expect(edited.dueAt).toBeUndefined();
    expect(edited.cron).toBe("0 20 * * 1");
    expect(edited.nextDueAt).toBe("2026-09-14T12:00:00.000Z");
  });

  test("刪除會連訊息一起刪掉", async () => {
    const list = makeList();
    const todo = await list.add({
      content: "倒垃圾",
      cron: "0 20 * * 1",
      timezone: "Asia/Taipei",
    });

    await list.remove(todo.id);
    expect(deleted).toEqual(["message-1"]);
    expect(await list.list()).toHaveLength(0);
  });

  test("狀態寫進檔案 換一個實例讀得回來", async () => {
    const first = makeList();
    const todo = await first.add({ content: "寫測試" });

    const raw = JSON.parse(await readFile(stateFile, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.todos).toHaveLength(1);

    const second = makeList();
    const [restored] = await second.list();
    expect(restored?.id).toBe(todo.id);
    expect(restored?.messageId).toBe("message-1");
  });

  test("貼訊息失敗不會讓整個 tick 掛掉 下次再試", async () => {
    let failing = true;
    const list = makeList({
      postTodoMessage: async (todo) => {
        if (failing) throw new Error("Discord is down.");
        posted.push({ ...todo });
        return "message-late";
      },
    });
    failing = false;
    const todo = await list.add({
      content: "倒垃圾",
      cron: "0 20 * * 1",
      timezone: "Asia/Taipei",
    });
    await list.complete(todo.id);

    failing = true;
    clock = new Date("2026-09-14T12:00:00.000Z");
    await list.tick();
    expect((await list.list())[0]?.messageId).toBeUndefined();

    // 退避 60 秒之後才會再試。
    failing = false;
    clock = new Date("2026-09-14T12:02:00.000Z");
    await list.tick();
    expect((await list.list())[0]?.messageId).toBe("message-late");
  });
});
