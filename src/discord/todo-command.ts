import type { DiscordApplicationCommandInteraction } from "./interactions";
import type { Todo, TodoList } from "./todo-list";

// /todo 直接操作 store 不繞經 worker。slash 指令只有三秒可以回應
// 而她跑一次 Codex 遠不止三秒 所以增刪改走這條快路 自然語言走 MCP 工具那條。

export const TODO_COMMAND_NAME = "todo";
const DEFAULT_TIMEZONE = "Asia/Taipei";
/** 短編號取 UUID 前八碼 給人打得動。 */
export const SHORT_ID_LENGTH = 8;
const MIN_ID_QUERY = 4;

export type TodoCommandAction = "add" | "list" | "edit" | "done" | "remove";

export type TodoCommand = {
  action: TodoCommandAction;
  content?: string;
  item?: string;
  due?: string;
  repeat?: string;
  lead?: number;
  clear?: string;
};

const ACTIONS = new Set<TodoCommandAction>([
  "add",
  "list",
  "edit",
  "done",
  "remove",
]);

export function shortId(todo: Todo) {
  return todo.id.slice(0, SHORT_ID_LENGTH);
}

export function parseTodoCommand(
  interaction: DiscordApplicationCommandInteraction,
): TodoCommand | null {
  if (
    interaction.type !== 2 ||
    interaction.data?.type !== 1 ||
    interaction.data.name !== TODO_COMMAND_NAME
  ) {
    return null;
  }
  const subcommand = interaction.data.options?.find(
    (option) => option.type === 1,
  );
  const action = subcommand?.name as TodoCommandAction | undefined;
  if (!action || !ACTIONS.has(action)) return null;

  const options = (
    (subcommand as { options?: Array<{ name?: string; value?: unknown }> })
      .options ?? []
  ).reduce<Record<string, unknown>>((collected, option) => {
    if (option.name) collected[option.name] = option.value;
    return collected;
  }, {});

  const text = (name: string) => {
    const value = options[name];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const lead = options.lead;

  return {
    action,
    ...(text("content") ? { content: text("content") } : {}),
    ...(text("item") ? { item: text("item") } : {}),
    ...(text("due") ? { due: text("due") } : {}),
    ...(text("repeat") ? { repeat: text("repeat") } : {}),
    ...(text("clear") ? { clear: text("clear") } : {}),
    ...(typeof lead === "number" ? { lead } : {}),
  };
}

/** 某個 UTC 瞬間在指定時區的偏移量。台北沒有日光節約 一次計算就夠。 */
function zoneOffsetMs(utcMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(new Date(utcMs))
    .reduce<Record<string, string>>((collected, part) => {
      collected[part.type] = part.value;
      return collected;
    }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcMs;
}

/**
 * 接受 `2026-09-10 18:00`（當成指定時區的當地時間）或任何 Date 吃得下的
 * 帶時區字串。回傳 ISO 瞬間。
 */
export function parseDueTime(value: string, timeZone = DEFAULT_TIMEZONE) {
  const local =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(
      value.trim(),
    );
  if (local) {
    const naive = Date.UTC(
      Number(local[1]),
      Number(local[2]) - 1,
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      Number(local[6] ?? 0),
    );
    return new Date(naive - zoneOffsetMs(naive, timeZone)).toISOString();
  }
  const parsed = Date.parse(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(
      "看不懂那個時間 用 2026-09-10 18:00 這種格式 或完整的 ISO 時間",
    );
  }
  return new Date(parsed).toISOString();
}

/** 依短編號、完整 ID 或內容片段找出唯一一筆。 */
export function resolveTodo(todos: Todo[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) throw new Error("要給我編號啦");

  const exact = todos.find(
    (todo) => todo.id.toLocaleLowerCase() === normalized,
  );
  if (exact) return exact;

  if (normalized.length >= MIN_ID_QUERY) {
    const byPrefix = todos.filter((todo) =>
      todo.id.toLocaleLowerCase().startsWith(normalized),
    );
    if (byPrefix.length === 1) return byPrefix[0]!;
    if (byPrefix.length > 1) throw new Error("那個編號對到不只一筆 多打幾碼");
  }

  const byContent = todos.filter((todo) =>
    todo.content.toLocaleLowerCase().includes(normalized),
  );
  if (byContent.length === 1) return byContent[0]!;
  if (byContent.length > 1) throw new Error("那樣講對到不只一筆 講清楚一點");
  throw new Error("清單上沒有這一筆");
}

/** Discord 會用讀的人自己的時區顯示。刻意用絕對時間 相對時間看不出是哪一天。 */
export function absoluteTime(instant: string, style: "f" | "F" = "f") {
  return `<t:${Math.floor(Date.parse(instant) / 1000)}:${style}>`;
}

function describe(todo: Todo) {
  const parts = [`\`${shortId(todo)}\` ${todo.content}`];
  if (todo.nextDueAt) parts.push(absoluteTime(todo.nextDueAt));
  if (todo.cron) parts.push(`🔁 \`${todo.cron}\``);
  return parts.join(" · ");
}

const EMBED_TITLE_MAX = 256;

export type TodoEmbed = {
  color: number;
  title?: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline: boolean }>;
  footer: { text: string };
};

/** 待辦在頻道裡的樣子。顏色跟她其他 embed 一致。 */
export function todoEmbed(todo: Todo, color: number): TodoEmbed {
  const fields: Array<{ name: string; value: string; inline: boolean }> = [];
  if (todo.nextDueAt) {
    fields.push({
      name: "到期",
      value: absoluteTime(todo.nextDueAt, "F"),
      inline: false,
    });
  }
  if (todo.cron) {
    fields.push({
      name: "重複",
      value: `\`${todo.cron}\`${todo.timezone ? ` · ${todo.timezone}` : ""}`,
      inline: true,
    });
  }
  if (todo.leadMinutes !== undefined) {
    fields.push({
      name: "提前提醒",
      value: `${todo.leadMinutes} 分鐘`,
      inline: true,
    });
  }
  // 超過標題上限就整段放進 description 不要截斷使用者寫的東西。
  const long = todo.content.length > EMBED_TITLE_MAX;
  return {
    color,
    ...(long ? { description: todo.content } : { title: todo.content }),
    ...(fields.length ? { fields } : {}),
    footer: { text: `編號 ${shortId(todo)}` },
  };
}

export function renderTodoList(todos: Todo[]) {
  if (todos.length === 0) return "清單是空的 難得";
  return todos.map((todo) => `• ${describe(todo)}`).join("\n");
}

const CLEARABLE = new Set(["due", "repeat", "lead"]);

/** 執行一次 /todo。回傳要回給使用者的短訊息。 */
export async function runTodoCommand(command: TodoCommand, todos: TodoList) {
  if (command.action === "list") {
    return renderTodoList(await todos.list());
  }

  if (command.action === "add") {
    if (!command.content) throw new Error("要寫內容啦");
    if (command.due && command.repeat) {
      throw new Error("到期時間和重複只能挑一個");
    }
    const todo = await todos.add({
      content: command.content,
      ...(command.due ? { dueAt: parseDueTime(command.due) } : {}),
      ...(command.repeat ? { cron: command.repeat } : {}),
      ...(command.lead !== undefined ? { leadMinutes: command.lead } : {}),
    });
    return `加好了 ${describe(todo)}`;
  }

  if (!command.item) throw new Error("要給我編號啦");
  const current = await todos.list();
  const target = resolveTodo(current, command.item);

  if (command.action === "done") {
    const result = await todos.complete(target.id);
    return result.recurring
      ? `這輪算你完成 下次 ${absoluteTime(result.todo.nextDueAt!)} 再說`
      : `勾掉了 「${target.content}」`;
  }

  if (command.action === "remove") {
    await todos.remove(target.id);
    return `丟掉了 「${target.content}」`;
  }

  const clear = command.clear;
  if (clear && !CLEARABLE.has(clear)) {
    throw new Error("只能清掉 due repeat 或 lead");
  }
  if (
    !command.content &&
    !command.due &&
    !command.repeat &&
    command.lead === undefined &&
    !clear
  ) {
    throw new Error("你什麼都沒改");
  }
  if (command.due && command.repeat) {
    throw new Error("到期時間和重複只能挑一個");
  }

  const updated = await todos.edit({
    todoId: target.id,
    ...(command.content ? { content: command.content } : {}),
    ...(command.due ? { dueAt: parseDueTime(command.due) } : {}),
    ...(command.repeat ? { cron: command.repeat } : {}),
    ...(command.lead !== undefined ? { leadMinutes: command.lead } : {}),
    ...(clear === "due" ? { dueAt: null } : {}),
    ...(clear === "repeat" ? { cron: null } : {}),
    ...(clear === "lead" ? { leadMinutes: null } : {}),
  });
  return `改好了 ${describe(updated)}`;
}
