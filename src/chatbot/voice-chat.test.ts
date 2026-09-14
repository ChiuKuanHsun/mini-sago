import { expect, test } from "bun:test";

import {
  createThinkingLinePicker,
  startThinkingFeedback,
  THINKING_FEEDBACK_LIMIT,
  THINKING_FEEDBACK_LINES,
  THINKING_GAP_MS,
  VoiceSentenceBuffer,
} from "./voice-chat";

test("never plays the same thinking line twice in a row", () => {
  const next = createThinkingLinePicker(["a", "b", "c"], () => 0);
  expect(next()).toBe("a");
  expect(next()).toBe("b");
  expect(next()).toBe("a");
});

test("keeps working when only one thinking line is configured", () => {
  const next = createThinkingLinePicker(["only"], () => 0);
  expect(next()).toBe("only");
  expect(next()).toBe("only");
});

test("ships several distinct thinking lines", () => {
  expect(THINKING_FEEDBACK_LINES.length).toBeGreaterThan(2);
  expect(new Set(THINKING_FEEDBACK_LINES).size).toBe(
    THINKING_FEEDBACK_LINES.length,
  );
});

test("stops the thinking cue after the configured number of plays", async () => {
  expect(THINKING_FEEDBACK_LIMIT).toBe(2);
  let plays = 0;
  const stop = startThinkingFeedback({
    getAudio: async () => Buffer.alloc(1),
    play: () => {
      plays++;
    },
    isCurrent: () => true,
    gapMs: 5,
  });
  await Bun.sleep(80);
  expect(plays).toBe(2);
  stop();
});

test("repeats thinking feedback only after playback ends and a gap", async () => {
  expect(THINKING_GAP_MS).toBe(3_500);
  let plays = 0;
  let finish!: () => void;
  const stop = startThinkingFeedback({
    getAudio: async () => Buffer.alloc(1),
    play: () => {
      plays++;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    isCurrent: () => true,
    gapMs: 20,
  });
  await Bun.sleep(30);
  expect(plays).toBe(1);
  finish();
  await Bun.sleep(5);
  expect(plays).toBe(1);
  await Bun.sleep(30);
  expect(plays).toBe(2);
  stop();
  finish();
  await Bun.sleep(30);
  expect(plays).toBe(2);
});

test("answer readiness suppresses feedback still being synthesized", async () => {
  let resolve!: (audio: Buffer) => void;
  let plays = 0;
  const stop = startThinkingFeedback({
    getAudio: () =>
      new Promise<Buffer>((done) => {
        resolve = done;
      }),
    play: () => {
      plays++;
    },
    isCurrent: () => true,
  });
  stop();
  resolve(Buffer.alloc(1));
  await Bun.sleep(0);
  expect(plays).toBe(0);
});

test("emits complete spoken sentences as reply text arrives", () => {
  const sentences: string[] = [];
  const buffer = new VoiceSentenceBuffer((sentence) =>
    sentences.push(sentence),
  );

  buffer.push("最初の");
  buffer.push("文。次の文！残り");
  expect(sentences).toEqual(["最初の文。", "次の文！"]);

  buffer.push("だよ");
  buffer.flush();
  expect(sentences).toEqual(["最初の文。", "次の文！", "残りだよ"]);
});

test("removes response-only markers before speech", () => {
  const sentences: string[] = [];
  const buffer = new VoiceSentenceBuffer((sentence) =>
    sentences.push(sentence),
  );

  buffer.push("<self-introduction>MiniSago</self-introduction>だよ。\n");
  expect(sentences).toEqual(["MiniSagoだよ。"]);
});
