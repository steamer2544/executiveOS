// Tests for the dictated-note quality gate (Phase 32).
// Every "drop" case below is a real transcript taken from the live event log.

import { describe, it, expect } from "bun:test";
import { judgeNote, isMeaningfulNote } from "./note.js";

describe("judgeNote — drops low-signal dictation", () => {
  it("drops an empty / whitespace note", () => {
    expect(judgeNote("").keep).toBe(false);
    expect(judgeNote("   ").keep).toBe(false);
  });

  it("drops pure counting (no letters at all)", () => {
    const v = judgeNote("1 2 3 1 2 3 1 2 3 4 1 2 3 4 1 2 3 4 1 2 3");
    expect(v.keep).toBe(false);
  });

  it("drops a mumble with too few letters", () => {
    expect(judgeNote("12312 เนี่ย").keep).toBe(false); // 3 Thai letters
    expect(judgeNote("ok").keep).toBe(false);
  });

  it("drops a repeated chant even when it has letters", () => {
    expect(judgeNote("test test test test test test test").keep).toBe(false);
  });

  it("reports why it dropped", () => {
    expect(judgeNote("").reason).toBe("empty");
    expect(judgeNote("1 2 3").reason).toBe("too few letters");
    expect(judgeNote("test test test test test test test").reason).toBe("repetitive");
  });
});

describe("judgeNote — keeps real speech", () => {
  it("keeps a Thai sentence", () => {
    expect(isMeaningfulNote("ทำ unit test สำหรับตัว opm backend เพราะ FE ทักมา")).toBe(true);
  });

  it("keeps an English sentence", () => {
    expect(isMeaningfulNote("I want to learn playing. I don't know how to play.")).toBe(true);
  });

  it("keeps a short but real utterance", () => {
    expect(isMeaningfulNote("The smith")).toBe(true);
    expect(isMeaningfulNote("อนาคตปั๊บ")).toBe(true);
  });

  it("keeps messy code-switched speech (permissive by design)", () => {
    expect(isMeaningfulNote("1234 ใช่ครับ 12 แอปคือ one to iltion act คือฮัลโหล")).toBe(true);
  });
});
