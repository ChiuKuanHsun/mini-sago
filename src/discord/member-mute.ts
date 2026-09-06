const DEFAULT_MUTE_MINUTES = 60;
const MAX_MUTE_MINUTES = 24 * 60;
const BRUSH_OFF_COOLDOWN_MS = 30_000;

// 罐頭回覆由 host 直接送出，不經過 Codex，所以被冷處理的人問再多次也不吃額度。
export const MEMBER_BRUSH_OFF_REPLIES = [
  "我才不理你",
  "哼 現在不想跟你講話",
  "你自己去旁邊玩",
  "在忙 忙著不理你",
  "跟你講話會變笨",
] as const;

export type MemberMuteStatus = {
  mutedUntil: string;
  durationMinutes: number;
};

type MutedMember = {
  until: number;
  replyCount: number;
  lastReplyAt: number;
};

export class MemberMuteTracker {
  private members = new Map<string, MutedMember>();

  constructor(private readonly now = () => Date.now()) {}

  private key(guildId: string, userId: string) {
    return `${guildId}:${userId}`;
  }

  private active(guildId: string, userId: string) {
    const key = this.key(guildId, userId);
    const member = this.members.get(key);
    if (!member) return undefined;
    if (member.until <= this.now()) {
      this.members.delete(key);
      return undefined;
    }
    return member;
  }

  mute(
    guildId: string,
    userId: string,
    durationMinutes = DEFAULT_MUTE_MINUTES,
  ): MemberMuteStatus {
    const boundedDuration = Math.min(
      MAX_MUTE_MINUTES,
      Math.max(1, Math.ceil(durationMinutes)),
    );
    const until = this.now() + boundedDuration * 60_000;
    this.members.set(this.key(guildId, userId), {
      until,
      replyCount: 0,
      lastReplyAt: 0,
    });
    return {
      mutedUntil: new Date(until).toISOString(),
      durationMinutes: boundedDuration,
    };
  }

  isMuted(guildId: string, userId: string) {
    return this.active(guildId, userId) !== undefined;
  }

  release(guildId: string, userId: string) {
    return this.members.delete(this.key(guildId, userId));
  }

  list(guildId: string) {
    const prefix = `${guildId}:`;
    const now = this.now();
    const entries: Array<{ userId: string; mutedUntil: string }> = [];
    for (const [key, member] of this.members) {
      if (!key.startsWith(prefix)) continue;
      if (member.until <= now) {
        this.members.delete(key);
        continue;
      }
      entries.push({
        userId: key.slice(prefix.length),
        mutedUntil: new Date(member.until).toISOString(),
      });
    }
    return entries;
  }

  // 取一句罐頭回覆。冷卻期間回傳 undefined，讓連續騷擾安靜下來而不是洗版。
  takeBrushOff(guildId: string, userId: string) {
    const member = this.active(guildId, userId);
    if (!member) return undefined;
    const now = this.now();
    if (
      member.lastReplyAt > 0 &&
      now - member.lastReplyAt < BRUSH_OFF_COOLDOWN_MS
    ) {
      return undefined;
    }
    const reply =
      MEMBER_BRUSH_OFF_REPLIES[
        member.replyCount % MEMBER_BRUSH_OFF_REPLIES.length
      ]!;
    member.replyCount += 1;
    member.lastReplyAt = now;
    return reply;
  }
}
