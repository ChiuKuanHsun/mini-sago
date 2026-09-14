import { randomUUID } from "node:crypto";

import type {
  AnswerJob,
  ChatbotMessage,
} from "../../contracts/worker-contract";
import { parseChatbotAnswerDecision } from "../../contracts/answer-contract";
import { leaveVoiceChannel } from "../discord/api/voice";
import { SpeechCache, synthesizeSpeech } from "../discord/local-speech";
import type {
  VoiceChatResponse,
  VoiceChatTurn,
  VoiceReplyInput,
} from "../discord/voice-conversation";
import { macAgentBridge } from "./bridge";
import { registerChatbotMcpSession } from "./mcp";

// 同一段音檔重複播是最像機器的一件事 所以輪替台詞 拉長間隔 並且只講兩次
export const THINKING_FEEDBACK_LINES = [
  "うーん…。",
  "ちょっと待って。",
  "んー、そうね…。",
  "今考えてるんだけど。",
  "ちょっと待ちなさいよ。",
] as const;
export const THINKING_GAP_MS = 3_500;
export const THINKING_FEEDBACK_LIMIT = 2;
const FAILURE_FEEDBACK = "ごめん、うまくいかなかった。もう一度お願い。";
const THINKING_LINES: readonly string[] = THINKING_FEEDBACK_LINES;
const feedbackSpeech = new SpeechCache((text) =>
  synthesizeSpeech(text, THINKING_LINES.includes(text) ? { speedScale: 0.8 } : {}),
);
const feedbackLines = [...THINKING_FEEDBACK_LINES, FAILURE_FEEDBACK] as const;

export function createThinkingLinePicker(
  lines: readonly string[] = THINKING_FEEDBACK_LINES,
  random: () => number = Math.random,
) {
  let last: string | undefined;
  return () => {
    const pool =
      lines.length > 1 ? lines.filter((line) => line !== last) : lines;
    const next = pool[Math.floor(random() * pool.length) % pool.length];
    last = next ?? last;
    return next ?? lines[0]!;
  };
}

export function startThinkingFeedback(options: {
  getAudio: () => Promise<Buffer>;
  play: (audio: Buffer) => void | Promise<void>;
  isCurrent: () => boolean;
  gapMs?: number;
  limit?: number;
}) {
  let stopped = false;
  let played = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = options.limit ?? THINKING_FEEDBACK_LIMIT;
  const active = () => !stopped && options.isCurrent();
  const play = async () => {
    if (!active()) return;
    try {
      const audio = await options.getAudio();
      if (!active()) return;
      await options.play(audio);
      played += 1;
    } catch (error) {
      console.warn("Could not play thinking feedback:", error);
    }
    if (active() && played < limit)
      timer = setTimeout(() => {
        void play();
      }, options.gapMs ?? THINKING_GAP_MS);
  };
  void play();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

async function playFeedback(text: string, onAudio: (audio: Buffer) => void) {
  try {
    onAudio(await feedbackSpeech.get(text));
  } catch (error) {
    console.warn(
      `Could not play voice feedback: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

// 合成服務可能在另一台機器上 core 先起來是常態 所以重試而不是一次就放棄。
const PREWARM_RETRY_DELAYS_MS = [10_000, 30_000, 60_000] as const;

export async function prewarmVoiceChatSpeech() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await feedbackSpeech.prewarm(feedbackLines);
      return;
    } catch (error) {
      const delay = PREWARM_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        console.warn(
          `Could not prewarm voice feedback: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        return;
      }
      await Bun.sleep(delay);
    }
  }
}

function spokenText(text: string) {
  return text
    .replace(/<\/?self-introduction>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export class VoiceSentenceBuffer {
  private pending = "";

  constructor(private readonly emit: (sentence: string) => void) {}

  push(delta: string) {
    this.pending += delta;
    while (true) {
      const match = /[。！？!?\n]+/u.exec(this.pending);
      if (!match) return;
      const end = match.index + match[0].length;
      const sentence = spokenText(this.pending.slice(0, end));
      this.pending = this.pending.slice(end);
      if (sentence) this.emit(sentence);
    }
  }

  flush() {
    const sentence = spokenText(this.pending);
    this.pending = "";
    if (sentence) this.emit(sentence);
  }
}

function contextMessages(
  history: VoiceChatTurn[],
  channelId: string,
): ChatbotMessage[] {
  const timestamp = new Date().toISOString();
  return history.map((turn) => ({
    id: randomUUID(),
    role: turn.role,
    author: turn.author,
    timestamp,
    content: turn.content,
    attachments: [],
    channelId,
    channelName: "voice chat",
  }));
}

export async function respondToVoiceChat(
  input: VoiceReplyInput & {
    guildId: string;
    channelId: string;
  },
): Promise<VoiceChatResponse | null> {
  if (!input.isCurrent()) return null;
  const { transcript } = input;
  const nextThinkingLine = createThinkingLinePicker();
  const stopFeedback = startThinkingFeedback({
    getAudio: () => feedbackSpeech.get(nextThinkingLine()),
    play: (audio) => input.onAudio(audio, "feedback"),
    isCurrent: input.isCurrent,
  });

  const requestMessageId = randomUUID();
  const requestMessage: ChatbotMessage = {
    id: requestMessageId,
    role: "user",
    author: input.userId,
    timestamp: new Date().toISOString(),
    content: transcript,
    attachments: [],
    channelId: input.channelId,
    channelName: "voice chat",
  };
  const messages = contextMessages(input.history, input.channelId);
  const mcpSession = registerChatbotMcpSession({
    // 語音裡唯一有意義的動作就是離開 join 沒有意義 她已經在頻道裡了。
    leaveVoiceChannel: () => leaveVoiceChannel(input.guildId),
    resolveContext: async () => ({
      history: { status: "complete", messages },
      search: { status: "not_requested", results: [] },
      members: { status: "not_requested", results: [] },
      previousTrace: { status: "not_requested" },
    }),
  });
  const job: AnswerJob = {
    id: randomUUID(),
    requesterUserId: input.userId,
    purpose: "answer",
    channelId: input.channelId,
    requestMessageId,
    request: transcript,
    requestMessage,
    messages,
    mcpAccessToken: mcpSession.token,
    capabilities: [
      {
        id: "conversation",
        category: "conversation",
        availability: "available",
        description:
          "Reply naturally in Japanese using at most two short sentences for a live Discord group voice chat. The local voice is Japanese-only, so do not include English words, emoji, Markdown, URLs, or other text that would sound unclear when spoken.",
      },
      {
        id: "voice_presence",
        category: "discord",
        availability: "available",
        description:
          "Leave this voice channel when the requester asks you to. You are already in it, so there is nothing to join.",
        tools: ["leave_voice_channel"],
      },
    ],
    executionRoute: "chat",
    streamReply: true,
  };

  try {
    let streamedReply = "";
    let speech = Promise.resolve();
    const sentences = new VoiceSentenceBuffer((sentence) => {
      speech = speech.then(async () => {
        if (!input.isCurrent()) return;
        const audio = await synthesizeSpeech(sentence);
        stopFeedback();
        if (input.isCurrent()) input.onAudio(audio);
      });
    });
    const dispatch = macAgentBridge.dispatch(job, ["chat"], (delta) => {
      if (!input.isCurrent()) return;
      streamedReply += delta;
      sentences.push(delta);
    });
    if (dispatch.status !== "accepted") {
      stopFeedback();
      await playFeedback(FAILURE_FEEDBACK, input.onAudio);
      return null;
    }
    const result = await dispatch.result;
    if (!input.isCurrent()) {
      await speech.catch(() => undefined);
      return null;
    }
    if (!result.ok) {
      stopFeedback();
      await speech.catch(() => undefined);
      await playFeedback(FAILURE_FEEDBACK, input.onAudio);
      return null;
    }

    const reply = parseChatbotAnswerDecision(result.content).reply;
    if (!reply) {
      stopFeedback();
      await speech.catch(() => undefined);
      await playFeedback(FAILURE_FEEDBACK, input.onAudio);
      return null;
    }
    if (!streamedReply) {
      sentences.push(reply);
    } else if (reply.startsWith(streamedReply)) {
      sentences.push(reply.slice(streamedReply.length));
    }
    sentences.flush();
    await speech;
    stopFeedback();
    return {
      transcript,
      reply,
    };
  } catch (error) {
    stopFeedback();
    await playFeedback(FAILURE_FEEDBACK, input.onAudio);
    console.warn(
      `Could not prepare Discord voice reply: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return null;
  } finally {
    stopFeedback();
    mcpSession.revoke();
  }
}
