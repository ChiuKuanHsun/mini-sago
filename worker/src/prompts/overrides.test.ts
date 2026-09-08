import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAnswerDeveloperInstructions } from "./answer";
import {
  clearPromptOverrides,
  loadPromptOverrides,
  promptOverrideFingerprint,
  PROMPT_OVERRIDE_MAX_BYTES,
  promptText,
  stopPromptOverrideWatch,
  watchPromptOverrides,
} from "./overrides";
import type { AnswerJob } from "../../../contracts/worker-contract";

const BUILTIN = "built-in identity text";

const job = {
  purpose: "answer",
  request: "在嗎",
  executionRoute: "chat",
  messages: [],
} as unknown as AnswerJob;

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "minisago-prompts-"));
});

afterEach(async () => {
  stopPromptOverrideWatch();
  clearPromptOverrides();
  await rm(directory, { recursive: true, force: true });
});

async function writeIdentity(text: string) {
  await writeFile(join(directory, "identity.md"), text, "utf8");
}

describe("prompt overrides", () => {
  test("falls back to the built-in text when the file is missing", () => {
    loadPromptOverrides(directory);
    expect(promptText("identity", BUILTIN)).toBe(BUILTIN);
    expect(promptOverrideFingerprint()).toBe("builtin");
  });

  test("falls back when the directory does not exist", () => {
    loadPromptOverrides(join(directory, "absent"));
    expect(promptText("identity", BUILTIN)).toBe(BUILTIN);
  });

  test("uses the file when it names her", async () => {
    await writeIdentity("  你是二乃 講話兇一點\n");
    loadPromptOverrides(directory);
    expect(promptText("identity", BUILTIN)).toBe("你是二乃 講話兇一點");
    expect(promptOverrideFingerprint()).toMatch(/^identity@[0-9a-f]{8}$/u);
  });

  test("rejects a file that no longer names her", async () => {
    // 這是唯一會安靜壞掉的改法：她的自我介紹會被 enforceFirstPersonIdentity()
    // 整則丟棄 而使用者只會看到她不回話。
    await writeIdentity("You are 上杉風太郎, a tutor.");
    loadPromptOverrides(directory);
    expect(promptText("identity", BUILTIN)).toBe(BUILTIN);
  });

  test("rejects an empty file", async () => {
    await writeIdentity("   \n\n");
    loadPromptOverrides(directory);
    expect(promptText("identity", BUILTIN)).toBe(BUILTIN);
  });

  test("rejects a file over the size cap", async () => {
    await writeIdentity(`二乃${"啦".repeat(PROMPT_OVERRIDE_MAX_BYTES)}`);
    loadPromptOverrides(directory);
    expect(promptText("identity", BUILTIN)).toBe(BUILTIN);
  });

  test("rejects a directory in place of the file", async () => {
    await mkdir(join(directory, "identity.md"));
    loadPromptOverrides(directory);
    expect(promptText("identity", BUILTIN)).toBe(BUILTIN);
  });

  test("reloads on change without restarting", async () => {
    await writeIdentity("二乃 第一版");
    loadPromptOverrides(directory);
    expect(watchPromptOverrides(directory, 10)).toBe(true);

    await writeIdentity("二乃 第二版");
    await Bun.sleep(200);
    expect(promptText("identity", BUILTIN)).toBe("二乃 第二版");

    // 改壞了不用回滾 刪掉檔案就回到內建版本。
    await rm(join(directory, "identity.md"));
    await Bun.sleep(200);
    expect(promptText("identity", BUILTIN)).toBe(BUILTIN);
  });

  test("does not watch a directory that does not exist", () => {
    expect(watchPromptOverrides(join(directory, "absent"), 10)).toBe(false);
  });

  test("the loaded text reaches the compiled developer instructions", async () => {
    const before = buildAnswerDeveloperInstructions(job);
    expect(before).toContain("You are 中野二乃 (Nakano Nino)");

    await writeIdentity("你就是二乃 這句是覆寫進來的");
    loadPromptOverrides(directory);

    const after = buildAnswerDeveloperInstructions(job);
    expect(after).toContain("你就是二乃 這句是覆寫進來的");
    expect(after).not.toContain("You are 中野二乃 (Nakano Nino)");
    // 其餘段落還在程式碼裡 不受覆寫影響。
    expect(after).toContain("Chinese replies must use one punctuation style.");
  });
});
