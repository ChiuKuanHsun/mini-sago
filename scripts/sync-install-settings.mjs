import {
  DISCORD_GUILD_INSTALL,
  buildDiscordApplicationUpdate,
} from "../src/discord/install-settings.ts";

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID?.trim();

if (!applicationId || !botToken) {
  console.error("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required.");
  process.exit(1);
}

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const requiredGuildPermissionFlags = [
  ["ADD_REACTIONS", 1n << 6n],
  ["VIEW_CHANNEL", 1n << 10n],
  ["SEND_MESSAGES", 1n << 11n],
  ["MANAGE_MESSAGES", 1n << 13n],
  ["EMBED_LINKS", 1n << 14n],
  ["READ_MESSAGE_HISTORY", 1n << 16n],
  ["CONNECT", 1n << 20n],
  ["SPEAK", 1n << 21n],
  ["MANAGE_WEBHOOKS", 1n << 29n],
  ["MANAGE_GUILD_EXPRESSIONS", 1n << 30n],
  ["MANAGE_THREADS", 1n << 34n],
  ["CREATE_PUBLIC_THREADS", 1n << 35n],
  ["SEND_MESSAGES_IN_THREADS", 1n << 38n],
  ["CREATE_GUILD_EXPRESSIONS", 1n << 43n],
];

const guildInstallScopes = ["bot"];
const guildInstallPermissions = requiredGuildPermissionFlags
  .reduce((permissions, [, flag]) => permissions | flag, 0n)
  .toString();

async function discordApi(path, options = {}) {
  const response = await fetch(`${DISCORD_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (response.ok) {
    return response;
  }

  const body = await response.text();
  throw new Error(`${response.status} ${response.statusText}: ${body}`);
}

const currentApplicationResponse = await discordApi("/applications/@me");
const currentApplication = await currentApplicationResponse.json();

if (currentApplication.id !== applicationId) {
  throw new Error(
    `DISCORD_APPLICATION_ID (${applicationId}) does not match the application for DISCORD_BOT_TOKEN (${currentApplication.id}).`,
  );
}

await discordApi("/applications/@me", {
  method: "PATCH",
  body: JSON.stringify(
    buildDiscordApplicationUpdate({
      application: currentApplication,
      scopes: guildInstallScopes,
      permissions: guildInstallPermissions,
    }),
  ),
});

const todoCommand = {
  name: "todo",
  type: 1,
  description: "管代辦清單",
  options: [
    {
      name: "add",
      type: 1,
      description: "加一筆到代辦頻道",
      options: [
        {
          name: "content",
          type: 3,
          description: "要做什麼",
          required: true,
          max_length: 300,
        },
        {
          name: "due",
          type: 3,
          description: "到期時間 例如 2026-09-10 18:00",
          max_length: 40,
        },
        {
          name: "repeat",
          type: 3,
          description: "重複 五段 cron 例如 0 20 * * 1",
          max_length: 60,
        },
        {
          name: "lead",
          type: 4,
          description: "提前幾分鐘先提醒一次",
          min_value: 1,
          max_value: 10080,
        },
      ],
    },
    { name: "list", type: 1, description: "看目前有哪些" },
    {
      name: "edit",
      type: 1,
      description: "改一筆",
      options: [
      {
        name: "item",
        type: 3,
        description: "編號或內容片段",
        required: true,
        max_length: 300,
      },
        { name: "content", type: 3, description: "改成什麼", max_length: 300 },
        { name: "due", type: 3, description: "到期時間", max_length: 40 },
        { name: "repeat", type: 3, description: "重複 cron", max_length: 60 },
        {
          name: "lead",
          type: 4,
          description: "提前幾分鐘",
          min_value: 1,
          max_value: 10080,
        },
        {
          name: "clear",
          type: 3,
          description: "清掉某個設定",
          choices: [
            { name: "到期時間", value: "due" },
            { name: "重複", value: "repeat" },
            { name: "提前提醒", value: "lead" },
          ],
        },
      ],
    },
    {
      name: "done",
      type: 1,
      description: "勾掉一筆",
      options: [
      {
        name: "item",
        type: 3,
        description: "編號或內容片段",
        required: true,
        max_length: 300,
      },
      ],
    },
    {
      name: "remove",
      type: 1,
      description: "不做了 直接丟掉",
      options: [
      {
        name: "item",
        type: 3,
        description: "編號或內容片段",
        required: true,
        max_length: 300,
      },
      ],
    },
  ],
};

const askCommand = {
  name: "ask",
  type: 1,
  description: "私下問二乃",
  options: [
    {
      name: "prompt",
      type: 3,
      description: "你想問二乃什麼",
      required: true,
      max_length: 2_000,
    },
  ],
};

const commandTargets = guildId
  ? [
      { path: `/applications/${applicationId}/commands`, commands: [] },
      {
        path: `/applications/${applicationId}/guilds/${guildId}/commands`,
        commands: [askCommand, todoCommand],
      },
    ]
  : [
      {
        path: `/applications/${applicationId}/commands`,
        commands: [
          { ...askCommand, contexts: [0], integration_types: [0] },
          { ...todoCommand, contexts: [0], integration_types: [0] },
        ],
      },
    ];

await Promise.all(
  commandTargets.map(({ path, commands }) =>
    discordApi(path, {
      method: "PUT",
      body: JSON.stringify(commands),
    }),
  ),
);

const permissionNames = requiredGuildPermissionFlags
  .map(([name]) => name)
  .join(", ");
const inviteUrl = new URL("https://discord.com/oauth2/authorize");
inviteUrl.searchParams.set("client_id", applicationId);
inviteUrl.searchParams.set("scope", guildInstallScopes.join(" "));
inviteUrl.searchParams.set("permissions", guildInstallPermissions);
inviteUrl.searchParams.set("integration_type", DISCORD_GUILD_INSTALL);

console.log("Updated Discord Guild Install default settings.");
console.log(
  `Registered /ask ${guildId ? `for guild ${guildId}` : "globally"}.`,
);
console.log(`Scopes: ${guildInstallScopes.join(", ")}`);
console.log(`Permissions: ${guildInstallPermissions} (${permissionNames})`);
console.log(`Direct guild install URL: ${inviteUrl.toString()}`);
