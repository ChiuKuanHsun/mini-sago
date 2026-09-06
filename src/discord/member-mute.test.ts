import { expect, test } from "bun:test";

import {
  MEMBER_BRUSH_OFF_REPLIES,
  MemberMuteTracker,
} from "./member-mute";

test("brushes a muted member off and rotates the canned replies", () => {
  let now = 1_000_000;
  const tracker = new MemberMuteTracker(() => now);
  tracker.mute("guild", "member");

  expect(tracker.isMuted("guild", "member")).toBe(true);
  expect(tracker.takeBrushOff("guild", "member")).toBe(
    MEMBER_BRUSH_OFF_REPLIES[0],
  );

  now += 30_000;
  expect(tracker.takeBrushOff("guild", "member")).toBe(
    MEMBER_BRUSH_OFF_REPLIES[1],
  );
});

test("stays silent while the brush-off is cooling down", () => {
  let now = 1_000_000;
  const tracker = new MemberMuteTracker(() => now);
  tracker.mute("guild", "member");

  expect(tracker.takeBrushOff("guild", "member")).toBeString();
  now += 5_000;
  expect(tracker.takeBrushOff("guild", "member")).toBeUndefined();
  now += 26_000;
  expect(tracker.takeBrushOff("guild", "member")).toBeString();
});

test("scopes a mute to one server and forgets it when it expires", () => {
  let now = 1_000_000;
  const tracker = new MemberMuteTracker(() => now);
  const status = tracker.mute("guild-a", "member", 30);

  expect(status.durationMinutes).toBe(30);
  expect(tracker.isMuted("guild-a", "member")).toBe(true);
  expect(tracker.isMuted("guild-b", "member")).toBe(false);
  expect(tracker.list("guild-a")).toEqual([
    { userId: "member", mutedUntil: status.mutedUntil },
  ]);

  now += 30 * 60_000 + 1;
  expect(tracker.isMuted("guild-a", "member")).toBe(false);
  expect(tracker.takeBrushOff("guild-a", "member")).toBeUndefined();
  expect(tracker.list("guild-a")).toEqual([]);
});

test("bounds the mute duration and releases on request", () => {
  const tracker = new MemberMuteTracker(() => 0);
  expect(tracker.mute("guild", "member", 10_000).durationMinutes).toBe(1_440);
  expect(tracker.mute("guild", "member", 0).durationMinutes).toBe(1);

  expect(tracker.release("guild", "member")).toBe(true);
  expect(tracker.release("guild", "member")).toBe(false);
  expect(tracker.isMuted("guild", "member")).toBe(false);
});
