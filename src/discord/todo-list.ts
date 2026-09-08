import { randomUUID } from "node:crypto";

import { Cron } from "croner";

import { readJsonFile, writeJsonFile } from "./jobs/job-utils";

// 待辦清單。每一筆在指定頻道各佔一則訊息 打勾（✅）就刪掉那則訊息。
// 一次性待辦打勾後從清單消失 重複待辦只結束這一輪 下次到期再貼一則新的。
//
// 排程刻意跟 jobs/reminders.ts 分開：那邊一筆提醒就是一則訊息 這邊一筆待辦
// 有自己的訊息 要在到期時回覆它 打勾時取消它 重複時重貼它 生命週期不一樣。
// 兩邊共用的只有 croner 和 writeJsonFile。

export const DEFAULT_TODO_STATE_FILE = ".data/todos.json";
export const MAX_TODOS = 100;
export const MAX_TODO_CONTENT = 300;
export const TODO_CHECK_INTERVAL_MS = 15_000;
const FAILED_ATTEMPT_BACKOFF_MS = 60_000;
const DEFAULT_TIMEZONE = "Asia/Taipei";

export type Todo = {
  id: string;
  content: string;
  createdAt: string;
  /** 目前這一輪在頻道裡的訊息。重複待辦打勾後會清空 等下一輪重貼。 */
  messageId?: string;
  /** 一次性待辦的到期時間。重複待辦用 cron 算 不存這個。 */
  dueAt?: string;
  cron?: string;
  timezone?: string;
  /** 提前幾分鐘先提醒一次。 */
  leadMinutes?: number;
  /** 下一次到期時間 一次性等於 dueAt 重複的由 cron 推進。 */
  nextDueAt?: string;
  /** 已經為哪一個 nextDueAt 發過提前提醒 避免重複發。 */
  leadNotifiedFor?: string;
  /** 已經為哪一個 nextDueAt 發過到期提醒。 */
  dueNotifiedFor?: string;
  /** 這一輪貼出去的提醒訊息。待辦被刪或打勾時要一起收掉 不然會留下孤兒。 */
  noticeMessageIds?: string[];
};

type TodoState = {
  version: 1;
  todos: Todo[];
};

export type TodoNoticeKind = "lead" | "due";

type TodoListOptions = {
  stateFile: string;
  /** 貼一則新的待辦訊息 回傳 message ID。 */
  postTodoMessage: (todo: Todo) => Promise<string | undefined>;
  /** 到期或提前提醒 應該回覆到待辦自己的訊息上 回傳 message ID。 */
  postNotice: (
    todo: Todo,
    kind: TodoNoticeKind,
  ) => Promise<string | undefined>;
  /** 刪掉這筆待辦名下的所有訊息 本體加上它的提醒。 */
  deleteTodoMessages: (todo: Todo) => Promise<void>;
  now?: () => Date;
  schedule?: (
    task: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
};

export type CreateTodoInput = {
  content: string;
  dueAt?: string;
  cron?: string;
  timezone?: string;
  leadMinutes?: number;
};

export type EditTodoInput = {
  todoId: string;
  content?: string;
  dueAt?: string | null;
  cron?: string | null;
  timezone?: string;
  leadMinutes?: number | null;
};

function ensureTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}

export function cronNextRun(pattern: string, timezone: string, from: Date) {
  const cron = new Cron(pattern, { mode: "5-part", paused: true, timezone });
  const nextRun = cron.nextRun(from);
  cron.stop();
  if (!nextRun) throw new Error("The cron expression has no future run.");
  return nextRun;
}

function ensureContent(content: string) {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("A todo needs some content.");
  if (trimmed.length > MAX_TODO_CONTENT) {
    throw new Error(`A todo cannot exceed ${MAX_TODO_CONTENT} characters.`);
  }
  return trimmed;
}

function ensureLeadMinutes(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 10_080) {
    throw new Error("Lead time must be 1 to 10080 whole minutes.");
  }
  return value;
}

function ensureFutureInstant(value: string, now: Date) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid due time: ${value}`);
  }
  if (parsed <= now.getTime()) {
    throw new Error("The due time is already in the past.");
  }
  return new Date(parsed).toISOString();
}

function isTodo(value: unknown): value is Todo {
  if (!value || typeof value !== "object") return false;
  const todo = value as Partial<Todo>;
  const optionalString = (field: unknown) =>
    field === undefined || typeof field === "string";
  return (
    typeof todo.id === "string" &&
    typeof todo.content === "string" &&
    typeof todo.createdAt === "string" &&
    optionalString(todo.messageId) &&
    optionalString(todo.dueAt) &&
    optionalString(todo.cron) &&
    optionalString(todo.timezone) &&
    optionalString(todo.nextDueAt) &&
    optionalString(todo.leadNotifiedFor) &&
    optionalString(todo.dueNotifiedFor) &&
    (todo.leadMinutes === undefined || Number.isInteger(todo.leadMinutes)) &&
    (todo.noticeMessageIds === undefined ||
      (Array.isArray(todo.noticeMessageIds) &&
        todo.noticeMessageIds.every((id) => typeof id === "string")))
  );
}

export function parseTodoState(value: unknown): TodoState {
  if (!value || typeof value !== "object") {
    throw new Error("Todo state must be an object.");
  }
  const state = value as Partial<TodoState>;
  if (state.version !== 1 || !Array.isArray(state.todos)) {
    throw new Error("Unsupported todo state.");
  }
  return { version: 1, todos: state.todos.filter(isTodo) };
}

export class TodoList {
  private todos: Todo[] = [];
  private started?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private operation = Promise.resolve();
  private readonly failedAttempts = new Map<string, number>();
  private readonly now: () => Date;
  private readonly schedule: NonNullable<TodoListOptions["schedule"]>;

  constructor(private readonly options: TodoListOptions) {
    this.now = options.now ?? (() => new Date());
    this.schedule = options.schedule ?? setTimeout;
  }

  start() {
    void this.load();
    this.scheduleNextTick();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async list() {
    await this.load();
    return this.todos.map((todo) => ({ ...todo }));
  }

  async add(input: CreateTodoInput) {
    return this.runExclusive(async () => {
      await this.load();
      if (this.todos.length >= MAX_TODOS) {
        throw new Error(`The list already holds ${MAX_TODOS} todos.`);
      }
      const now = this.now();
      const content = ensureContent(input.content);
      if (input.dueAt && input.cron) {
        throw new Error("A todo takes either a due time or a cron, not both.");
      }
      const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
      ensureTimezone(timezone);

      let nextDueAt: string | undefined;
      let dueAt: string | undefined;
      if (input.cron) {
        nextDueAt = cronNextRun(input.cron, timezone, now).toISOString();
      } else if (input.dueAt) {
        dueAt = ensureFutureInstant(input.dueAt, now);
        nextDueAt = dueAt;
      }

      const todo: Todo = {
        id: randomUUID(),
        content,
        createdAt: now.toISOString(),
        ...(dueAt ? { dueAt } : {}),
        ...(input.cron ? { cron: input.cron, timezone } : {}),
        ...(input.dueAt || input.cron ? { timezone } : {}),
        ...(input.leadMinutes !== undefined
          ? { leadMinutes: ensureLeadMinutes(input.leadMinutes) }
          : {}),
        ...(nextDueAt ? { nextDueAt } : {}),
      };
      if (todo.leadMinutes !== undefined && !todo.nextDueAt) {
        throw new Error("Lead time needs a due time or a cron.");
      }

      todo.messageId = await this.options.postTodoMessage(todo);
      this.todos = [...this.todos, todo];
      await this.write();
      return { ...todo };
    });
  }

  async edit(input: EditTodoInput) {
    return this.runExclusive(async () => {
      await this.load();
      const existing = this.todos.find((todo) => todo.id === input.todoId);
      if (!existing) throw new Error("That todo is not on the list.");
      const now = this.now();
      const next: Todo = { ...existing };

      if (input.content !== undefined) next.content = ensureContent(input.content);
      if (input.timezone !== undefined) {
        const timezone = input.timezone.trim() || DEFAULT_TIMEZONE;
        ensureTimezone(timezone);
        next.timezone = timezone;
      }
      if (input.cron !== undefined) {
        if (input.cron === null) {
          delete next.cron;
        } else {
          next.cron = input.cron;
          delete next.dueAt;
        }
      }
      if (input.dueAt !== undefined) {
        if (input.dueAt === null) {
          delete next.dueAt;
        } else {
          next.dueAt = ensureFutureInstant(input.dueAt, now);
          delete next.cron;
        }
      }
      if (input.leadMinutes !== undefined) {
        if (input.leadMinutes === null) delete next.leadMinutes;
        else next.leadMinutes = ensureLeadMinutes(input.leadMinutes);
      }
      if (next.cron && next.dueAt) {
        throw new Error("A todo takes either a due time or a cron, not both.");
      }

      const timezone = next.timezone || DEFAULT_TIMEZONE;
      if (next.cron) {
        next.nextDueAt = cronNextRun(next.cron, timezone, now).toISOString();
      } else if (next.dueAt) {
        next.nextDueAt = next.dueAt;
      } else {
        delete next.nextDueAt;
      }
      if (next.leadMinutes !== undefined && !next.nextDueAt) {
        throw new Error("Lead time needs a due time or a cron.");
      }
      // 排程換了就重新開放提醒。
      if (next.nextDueAt !== existing.nextDueAt) {
        delete next.leadNotifiedFor;
        delete next.dueNotifiedFor;
      }

      this.todos = this.todos.map((todo) =>
        todo.id === next.id ? next : todo,
      );
      await this.write();
      return { ...next };
    });
  }

  /**
   * 打勾。一次性待辦整筆移除 重複待辦只結束這一輪 下次到期再貼新訊息。
   * 兩種情況都會刪掉目前那則訊息。
   */
  async complete(todoId: string) {
    return this.runExclusive(async () => {
      await this.load();
      const todo = this.todos.find((item) => item.id === todoId);
      if (!todo) throw new Error("That todo is not on the list.");
      await this.options.deleteTodoMessages(todo);

      if (!todo.cron) {
        this.todos = this.todos.filter((item) => item.id !== todoId);
        await this.write();
        return { todo: { ...todo }, recurring: false as const };
      }

      const timezone = todo.timezone || DEFAULT_TIMEZONE;
      const next: Todo = {
        ...todo,
        nextDueAt: cronNextRun(todo.cron, timezone, this.now()).toISOString(),
      };
      delete next.messageId;
      delete next.leadNotifiedFor;
      delete next.dueNotifiedFor;
      delete next.noticeMessageIds;
      this.todos = this.todos.map((item) =>
        item.id === todoId ? next : item,
      );
      await this.write();
      return { todo: { ...next }, recurring: true as const };
    });
  }

  /** 直接刪掉 不管是不是重複的。 */
  async remove(todoId: string) {
    return this.runExclusive(async () => {
      await this.load();
      const todo = this.todos.find((item) => item.id === todoId);
      if (!todo) throw new Error("That todo is not on the list.");
      await this.options.deleteTodoMessages(todo);
      this.todos = this.todos.filter((item) => item.id !== todoId);
      await this.write();
      return { ...todo };
    });
  }

  /** 用 message ID 反查 供 ✅ 事件使用。 */
  async findByMessageId(messageId: string) {
    await this.load();
    const todo = this.todos.find((item) => item.messageId === messageId);
    return todo ? { ...todo } : undefined;
  }

  async tick() {
    return this.runExclusive(async () => {
      await this.load();
      const now = this.now();
      let changed = false;

      for (const todo of this.todos) {
        const attemptKey = `${todo.id}:${todo.nextDueAt ?? ""}`;
        const failedAt = this.failedAttempts.get(attemptKey);
        if (failedAt && now.getTime() - failedAt < FAILED_ATTEMPT_BACKOFF_MS) {
          continue;
        }
        try {
          if (await this.advance(todo, now)) changed = true;
          this.failedAttempts.delete(attemptKey);
        } catch (error) {
          this.failedAttempts.set(attemptKey, now.getTime());
          console.error(`Failed to advance todo ${todo.id}:`, error);
        }
      }

      if (changed) await this.write();
    });
  }

  /** 回傳是否動到狀態。 */
  private async advance(todo: Todo, now: Date) {
    if (!todo.nextDueAt) return false;
    const dueTime = Date.parse(todo.nextDueAt);
    if (!Number.isFinite(dueTime)) return false;
    let changed = false;

    // 重複待辦打勾後訊息會消失 到下一輪到期時重貼。
    if (!todo.messageId && now.getTime() >= dueTime) {
      todo.messageId = await this.options.postTodoMessage(todo);
      changed = true;
    }

    if (
      todo.leadMinutes !== undefined &&
      todo.leadNotifiedFor !== todo.nextDueAt &&
      now.getTime() >= dueTime - todo.leadMinutes * 60_000 &&
      now.getTime() < dueTime
    ) {
      const noticeId = await this.options.postNotice(todo, "lead");
      if (noticeId) {
        todo.noticeMessageIds = [...(todo.noticeMessageIds ?? []), noticeId];
      }
      todo.leadNotifiedFor = todo.nextDueAt;
      changed = true;
    }

    if (todo.dueNotifiedFor !== todo.nextDueAt && now.getTime() >= dueTime) {
      const noticeId = await this.options.postNotice(todo, "due");
      if (noticeId) {
        todo.noticeMessageIds = [...(todo.noticeMessageIds ?? []), noticeId];
      }
      todo.dueNotifiedFor = todo.nextDueAt;
      changed = true;
    }

    return changed;
  }

  private async load() {
    this.started ??= readJsonFile<unknown>(this.options.stateFile, () => ({
      version: 1,
      todos: [],
    }))
      .then((value) => {
        this.todos = parseTodoState(value).todos;
      })
      .catch((error) => {
        console.error("Failed to load the todo list:", error);
        this.todos = [];
      });
    await this.started;
  }

  private scheduleNextTick() {
    this.timer = this.schedule(() => {
      void this.tick().finally(() => this.scheduleNextTick());
    }, TODO_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.operation.then(task, task);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async write() {
    await writeJsonFile(this.options.stateFile, {
      version: 1,
      todos: this.todos,
    } satisfies TodoState);
  }
}

let todoList: TodoList | undefined;

export type TodoRuntimeCallbacks = Pick<
  TodoListOptions,
  "postTodoMessage" | "postNotice" | "deleteTodoMessages"
>;

export function configureTodoList(callbacks: TodoRuntimeCallbacks) {
  todoList = new TodoList({
    stateFile:
      process.env.MINISAGO_TODO_STATE_FILE?.trim() || DEFAULT_TODO_STATE_FILE,
    ...callbacks,
  });
  todoList.start();
  return todoList;
}

export function getTodoList() {
  return todoList;
}
