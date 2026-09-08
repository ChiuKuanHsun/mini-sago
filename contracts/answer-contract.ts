export const CHATBOT_REPLY_MAX_CHARACTERS = 4_000;
export const CHATBOT_REACTION_MAX_CHARACTERS = 100;
export const CHATBOT_EMBED_TITLE_MAX_CHARACTERS = 256;
export const CHATBOT_EMBED_DESCRIPTION_MAX_CHARACTERS = 1_000;
export const CHATBOT_EMBED_FIELD_NAME_MAX_CHARACTERS = 64;
export const CHATBOT_EMBED_FIELD_VALUE_MAX_CHARACTERS = 300;
export const CHATBOT_EMBED_MAX_FIELDS = 6;

export type ChatbotEmbedField = { name: string; value: string };
export type ChatbotEmbed = {
  title?: string;
  description?: string;
  fields?: ChatbotEmbedField[];
};

export type ChatbotAnswerDecision = {
  reply: string | null;
  reactionEmoji?: string;
  embed?: ChatbotEmbed;
};

const SELF_NAME = /\bNino\b|中野二乃|二乃/u;
const SELF_INTRODUCTION =
  /<self-introduction>\s*(中野\s*二乃|二乃|Nakano\s+Nino|Nino)\s*<\/self-introduction>/giu;
const SELF_INTRODUCTION_MARKER = /<\/?self-introduction>/u;
const SELF_INTRODUCTION_MARKERS = /<\/?self-introduction>/gu;

// 「我是二乃」本來就是合法的第一人稱介紹 模型只是忘了包 marker。
// 主動補上而不是讓整則回覆消失 —— 這是自我介紹會被系統擋掉的主因。
const BARE_SELF_INTRODUCTION_ZH =
  /(我(?:就)?是|我叫|叫我|我的名字是)(\s*)(中野\s*二乃|二乃|Nakano\s+Nino|Nino)/gu;
const BARE_SELF_INTRODUCTION_EN =
  /(\bI(?:'m|’m| am)|\bmy name is|\bcall me|\bthis is)(\s+)(中野\s*二乃|二乃|Nakano\s+Nino|Nino)/giu;

export function enforceFirstPersonIdentity(
  reply: string,
  stripIntroduction = true,
) {
  const normalized = reply
    .replace(
      /\bNino[\u2019']s\b/gu,
      (_match, offset: number, value: string) =>
        offset === 0 || /[.!?\n]\s*$/u.test(value.slice(0, offset))
          ? "My"
          : "my",
    )
    .replace(/中野二乃的|二乃的/gu, "我的")
    .replace(
      BARE_SELF_INTRODUCTION_ZH,
      "$1$2<self-introduction>$3</self-introduction>",
    )
    .replace(
      BARE_SELF_INTRODUCTION_EN,
      "$1$2<self-introduction>$3</self-introduction>",
    );
  const unmarked = normalized.replace(SELF_INTRODUCTION, "");
  if (SELF_INTRODUCTION_MARKER.test(unmarked) || SELF_NAME.test(unmarked)) {
    return null;
  }
  return stripIntroduction
    ? normalized.replace(SELF_INTRODUCTION, "$1")
    : normalized;
}

function embedText(value: unknown, limit: number) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const safe = enforceFirstPersonIdentity(trimmed);
  if (safe === null) return null;
  return safe.slice(0, limit);
}

export function parseChatbotEmbed(value: unknown): ChatbotEmbed | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const source = value as {
    title?: unknown;
    description?: unknown;
    fields?: unknown;
  };
  const title = embedText(source.title, CHATBOT_EMBED_TITLE_MAX_CHARACTERS);
  const description = embedText(
    source.description,
    CHATBOT_EMBED_DESCRIPTION_MAX_CHARACTERS,
  );
  if (title === null || description === null) return undefined;

  const fields: ChatbotEmbedField[] = [];
  if (Array.isArray(source.fields)) {
    for (const entry of source.fields.slice(0, CHATBOT_EMBED_MAX_FIELDS)) {
      if (!entry || typeof entry !== "object") continue;
      const field = entry as { name?: unknown; value?: unknown };
      const name = embedText(
        field.name,
        CHATBOT_EMBED_FIELD_NAME_MAX_CHARACTERS,
      );
      const fieldValue = embedText(
        field.value,
        CHATBOT_EMBED_FIELD_VALUE_MAX_CHARACTERS,
      );
      if (!name || !fieldValue) return undefined;
      fields.push({ name, value: fieldValue });
    }
  }

  if (!title && !description && fields.length === 0) return undefined;
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(fields.length ? { fields } : {}),
  };
}

export function parseChatbotAnswerDecision(
  content: string,
): ChatbotAnswerDecision {
  try {
    const value = JSON.parse(content) as {
      reply?: unknown;
      reaction?: unknown;
      embed?: unknown;
    };
    const reply =
      typeof value.reply === "string"
        ? value.reply.trim()
        : value.reply === null
          ? null
          : undefined;
    // 守衛是風格檢查 不是安全檢查。送出一則語氣不完美的回覆
    // 比讓整則回覆消失好 —— worker 那邊還有一次 repair 機會 這裡沒有。
    const safeReply = reply
      ? (enforceFirstPersonIdentity(reply) ??
        reply.replace(SELF_INTRODUCTION_MARKERS, ""))
      : reply;
    const reaction =
      value.reaction &&
      typeof value.reaction === "object" &&
      "emoji" in value.reaction &&
      typeof value.reaction.emoji === "string"
        ? value.reaction.emoji.trim()
        : undefined;
    if (
      reply === undefined ||
      (reply !== null && reply.length > CHATBOT_REPLY_MAX_CHARACTERS) ||
      (value.reaction !== null &&
        (!reaction || reaction.length > CHATBOT_REACTION_MAX_CHARACTERS)) ||
      (!safeReply && !reaction)
    ) {
      return { reply: null };
    }
    const embed = parseChatbotEmbed(value.embed);
    return {
      reply: safeReply || null,
      ...(reaction ? { reactionEmoji: reaction } : {}),
      ...(embed ? { embed } : {}),
    };
  } catch {
    return { reply: null };
  }
}
