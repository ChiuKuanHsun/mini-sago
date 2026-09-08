import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DiscordApplicationCommandInteraction } from "./interactions";
import {
  parseDueTime,
  parseTodoCommand,
  resolveTodo,
  runTodoCommand,
  shortId,
} from "./todo-command";
import { TodoList, type Todo } from "./todo-list";

let directory: string;
let list: TodoList;
let deleted: Array<string | undefined>;
let messageCounter: number;

function interaction(
  name: string,
  subcommand?: { name: string; options?: Array<{ type: number; name: string; value: unknown }> },
): DiscordApplicationCommandInteraction {
  return {
    id: "1",
    application_id: "2",
    token: "t",
    type: 2,
    channel_id: "3",
    data: {
      type: 1,
      name,
      ...(subcommand
        ? { options: [{ type: 1, name: subcommand.name, options: subcommand.options ?? [] }] }
        : {}),
    },
  } as DiscordApplicationCommandInteraction;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "minisago-todo-command-"));
  deleted = [];
  messageCounter = 0;
  list = new TodoList({
    stateFile: join(directory, "todos.json"),
    now: () => new Date("2026-09-08T00:00:00.000Z"),
    postTodoMessage: async () => {
      messageCounter += 1;
      return `message-${messageCounter}`;
    },
    postNotice: async () => {},
    deleteTodoMessage: async (todo: Todo) => {
      deleted.push(todo.messageId);
    },
  });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("parseTodoCommand", () => {
  test("讀得出子指令和它的選項", () => {
    const command = parseTodoCommand(
      interaction("todo", {
        name: "add",
        options: [
          { type: 3, name: "content", value: "  倒垃圾  " },
          { type: 3, name: "repeat", value: "0 20 * * 1" },
          { type: 4, name: "lead", value: 30 },
        ],
      }),
    );
    expect(command).toEqual({
      action: "add",
      content: "倒垃圾",
      repeat: "0 20 * * 1",
      lead: 30,
    });
  });

  test("不是 /todo 就回 null", () => {
    expect(parseTodoCommand(interaction("ask"))).toBeNull();
  });

  test("認不得的子指令回 null", () => {
    expect(parseTodoCommand(interaction("todo", { name: "nuke" }))).toBeNull();
  });
});

describe("parseDueTime", () => {
  test("當地時間按時區換算", () => {
    // 台北 +8 所以 18:00 是前一天的 10:00Z。
    expect(parseDueTime("2026-09-10 18:00", "Asia/Taipei")).toBe(
      "2026-09-10T10:00:00.000Z",
    );
  });

  test("帶時區的 ISO 直接吃", () => {
    expect(parseDueTime("2026-09-10T10:00:00Z")).toBe(
      "2026-09-10T10:00:00.000Z",
    );
  });

  test("看不懂就抱怨", () => {
    expect(() => parseDueTime("下禮拜吧")).toThrow("看不懂那個時間");
  });
});

describe("resolveTodo", () => {
  const todos = [
    { id: "aaaa1111-0000-0000-0000-000000000000", content: "倒垃圾" },
    { id: "aaaa2222-0000-0000-0000-000000000000", content: "訂機票" },
  ] as Todo[];

  test("短編號前綴找得到", () => {
    expect(resolveTodo(todos, "aaaa1111")?.content).toBe("倒垃圾");
  });

  test("內容片段也找得到", () => {
    expect(resolveTodo(todos, "機票")?.content).toBe("訂機票");
  });

  test("前綴撞號會要求打長一點", () => {
    expect(() => resolveTodo(todos, "aaaa")).toThrow("不只一筆");
  });

  test("找不到就直說", () => {
    expect(() => resolveTodo(todos, "洗車")).toThrow("沒有這一筆");
  });
});

describe("runTodoCommand", () => {
  test("新增然後列出來", async () => {
    const added = await runTodoCommand(
      { action: "add", content: "倒垃圾" },
      list,
    );
    expect(added).toContain("加好了");

    const listed = await runTodoCommand({ action: "list" }, list);
    expect(listed).toContain("倒垃圾");
  });

  test("空清單有自己的講法", async () => {
    expect(await runTodoCommand({ action: "list" }, list)).toBe("清單是空的 難得");
  });

  test("到期時間和重複只能挑一個", async () => {
    await expect(
      runTodoCommand(
        {
          action: "add",
          content: "兩個都給",
          due: "2026-09-10 18:00",
          repeat: "0 20 * * 1",
        },
        list,
      ),
    ).rejects.toThrow("只能挑一個");
  });

  test("勾掉一次性的會刪訊息", async () => {
    const todo = await list.add({ content: "訂機票" });
    const reply = await runTodoCommand(
      { action: "done", item: shortId(todo) },
      list,
    );
    expect(reply).toContain("勾掉了");
    expect(deleted).toEqual(["message-1"]);
    expect(await list.list()).toHaveLength(0);
  });

  test("勾掉重複的只結束這一輪", async () => {
    const todo = await list.add({
      content: "倒垃圾",
      cron: "0 20 * * 1",
      timezone: "Asia/Taipei",
    });
    const reply = await runTodoCommand(
      { action: "done", item: shortId(todo) },
      list,
    );
    expect(reply).toContain("這輪算你完成");
    expect(await list.list()).toHaveLength(1);
  });

  test("用內容片段就能丟掉", async () => {
    await list.add({ content: "退租的事" });
    const reply = await runTodoCommand({ action: "remove", item: "退租" }, list);
    expect(reply).toContain("丟掉了");
    expect(await list.list()).toHaveLength(0);
  });

  test("改內容", async () => {
    const todo = await list.add({ content: "倒垃圾" });
    const reply = await runTodoCommand(
      { action: "edit", item: shortId(todo), content: "倒回收" },
      list,
    );
    expect(reply).toContain("倒回收");
  });

  test("clear 可以把重複清掉", async () => {
    const todo = await list.add({
      content: "倒垃圾",
      cron: "0 20 * * 1",
      timezone: "Asia/Taipei",
    });
    await runTodoCommand(
      { action: "edit", item: shortId(todo), clear: "repeat" },
      list,
    );
    const [updated] = await list.list();
    expect(updated?.cron).toBeUndefined();
    expect(updated?.nextDueAt).toBeUndefined();
  });

  test("什麼都沒改會被念", async () => {
    const todo = await list.add({ content: "倒垃圾" });
    await expect(
      runTodoCommand({ action: "edit", item: shortId(todo) }, list),
    ).rejects.toThrow("什麼都沒改");
  });

  test("沒給編號會被念", async () => {
    await expect(runTodoCommand({ action: "done" }, list)).rejects.toThrow(
      "要給我編號",
    );
  });
});
