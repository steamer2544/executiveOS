// Tests for ocr.ts — offline only. Never spawns a real Tesseract or PowerShell:
// every case either uses a pure helper or a deliberately bogus executable path.

import { describe, test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ocrImage, normalizeThaiOcr, resolveTesseractPath, resolveOcrLanguages, hasThai } from "./ocr.js";

// Thai sara-am as Tesseract emits it: ก + U+0E4D (nikhahit) + U+0E32 (sara aa).
const DECOMPOSED = "กํา"; // กํา
const COMPOSED = "กำ"; // กำ

describe("normalizeThaiOcr", () => {
  test("recomposes a decomposed sara-am", () => {
    expect(normalizeThaiOcr(DECOMPOSED)).toBe(COMPOSED);
  });

  // Regression: the first implementation passed a STRING to .replace(), which fixes only the
  // first occurrence — every later sara-am word stayed decomposed. Must be a global regex.
  test("recomposes EVERY occurrence, not just the first", () => {
    const input = "กํา นํา ทํา"; // กํา นํา ทํา
    const out = normalizeThaiOcr(input);
    expect(out).toBe("กำ นำ ทำ"); // กำ นำ ทำ
    expect(out.includes("ํา")).toBe(false);
  });

  test("a realistic mixed Thai/English OCR line comes out composed", () => {
    // "กําหนดส่ง 14 API key" → "กำหนดส่ง 14 API key"
    const input = "กําหนดส่ง 14 API key";
    expect(normalizeThaiOcr(input)).toBe("กำหนดส่ง 14 API key");
  });

  test("empty string in → empty string out", () => {
    expect(normalizeThaiOcr("")).toBe("");
  });

  test("plain ASCII is returned unchanged", () => {
    expect(normalizeThaiOcr("hello world")).toBe("hello world");
  });
});

describe("resolveTesseractPath", () => {
  test("ignores a configured path that does not exist and still returns a candidate", () => {
    const p = resolveTesseractPath("C:\\definitely\\not\\here.exe");
    expect(p).not.toBeNull();
    expect(p).not.toBe("C:\\definitely\\not\\here.exe");
  });

  test("returns a candidate when nothing is configured", () => {
    expect(resolveTesseractPath(null)).not.toBeNull();
    expect(resolveTesseractPath(undefined)).not.toBeNull();
  });

  test("an empty/whitespace configured path is ignored, not returned", () => {
    expect(resolveTesseractPath("")).not.toBe("");
    expect(resolveTesseractPath("   ")).not.toBe("   ");
  });
});

describe("ocrImage engine dispatch", () => {
  test("an unreadable image on the tesseract engine returns '' and never throws", () => {
    // Note: the bogus tesseractPath is deliberately ignored by resolveTesseractPath (it does not
    // exist), so on a machine WITH Tesseract this really spawns it and the missing image makes it
    // exit non-zero; on a machine WITHOUT it the spawn fails; on non-win32 the platform guard
    // returns first. All three routes must produce the same contract: "" and no throw.
    const out = ocrImage("C:\\nope\\img.png", null, {
      engine: "tesseract",
      tesseractPath: "C:\\nope\\nope.exe",
    });
    expect(out).toBe("");
  });

  test("omitting opts keeps the default (WinRT) engine reachable without throwing", () => {
    // A non-existent image on the WinRT path must degrade to "" rather than throw.
    //
    // The WinRT path stages a temp .ps1 under tmpDir(), so EXECUTIVE_HOME must point at a
    // temp directory: without it this test wrote its scratch file into the owner's LIVE
    // .executive/tmp.
    const prev = process.env.EXECUTIVE_HOME;
    process.env.EXECUTIVE_HOME =
      tmpdir() + "/executive-test-ocr-" + randomUUID();
    try {
      expect(typeof ocrImage("C:\\nope\\img.png")).toBe("string");
    } finally {
      if (prev === undefined) delete process.env.EXECUTIVE_HOME;
      else process.env.EXECUTIVE_HOME = prev;
    }
  });
});

describe("resolveTesseractPath — configured path warning", () => {
  test("warns on stderr when a configured path does not exist (a typo must not be invisible)", () => {
    const seen: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string) => { seen.push(String(chunk)); return true; };
    try {
      resolveTesseractPath("C:/definitely/not/here.exe");
    } finally {
      process.stderr.write = orig;
    }
    expect(seen.join("")).toContain("tesseractPath does not exist");
  });

  test("does not warn when nothing is configured", () => {
    const seen: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string) => { seen.push(String(chunk)); return true; };
    try {
      resolveTesseractPath(null);
    } finally {
      process.stderr.write = orig;
    }
    expect(seen.join("")).toBe("");
  });
});

describe("hasThai", () => {
  test("true for a Thai title", () => {
    expect(hasThai("แชท OPM Dev — LINE")).toBe(true);
  });

  test("false for an all-English title", () => {
    expect(hasThai("builder.ts - executive - Visual Studio Code")).toBe(false);
  });

  test("false for null/undefined/empty (never throws on a missing title)", () => {
    expect(hasThai(null)).toBe(false);
    expect(hasThai(undefined)).toBe(false);
    expect(hasThai("")).toBe(false);
  });

  // Neighbouring scripts must not be mistaken for Thai: Lao (U+0E80+) sits directly after the
  // Thai block, and Khmer looks similar to a casual range check.
  test("false for Lao and Khmer text", () => {
    expect(hasThai("ສະບາຍດີ")).toBe(false);
    expect(hasThai("សួស្តី")).toBe(false);
  });

  test("true when a single Thai character hides inside an otherwise English title", () => {
    expect(hasThai("Untitled - ก - Notepad")).toBe(true);
  });
});

describe("resolveOcrLanguages", () => {
  const NO_TITLE = () => null;

  test("auto + Thai window title → tha+eng", () => {
    expect(resolveOcrLanguages("auto", () => "แชท OPM Dev — LINE")).toBe("tha+eng");
  });

  // The whole point of the feature: a blanket tha+eng hallucinates Thai on an English screen.
  test("auto + English window title → eng", () => {
    expect(resolveOcrLanguages("auto", () => "builder.ts - executive - Visual Studio Code")).toBe("eng");
  });

  test("an empty/absent setting behaves like auto", () => {
    expect(resolveOcrLanguages(undefined, () => "ตรวจสอบ handoff")).toBe("tha+eng");
    expect(resolveOcrLanguages(null, () => "GitHub - Chromium")).toBe("eng");
    expect(resolveOcrLanguages("", () => "GitHub - Chromium")).toBe("eng");
    expect(resolveOcrLanguages("   ", () => "GitHub - Chromium")).toBe("eng");
  });

  test('"AUTO" in any casing is still auto, not a language named AUTO', () => {
    expect(resolveOcrLanguages("AUTO", () => "GitHub - Chromium")).toBe("eng");
    expect(resolveOcrLanguages(" Auto ", () => "GitHub - Chromium")).toBe("eng");
  });

  // Manual override is the escape hatch: it must beat the guess in BOTH directions, including
  // the case where the guess would have agreed.
  test("a manual list always wins over the guess", () => {
    expect(resolveOcrLanguages("tha+eng", () => "builder.ts - Visual Studio Code")).toBe("tha+eng");
    expect(resolveOcrLanguages("eng", () => "แชท OPM Dev — LINE")).toBe("eng");
    expect(resolveOcrLanguages("jpn", () => "แชท OPM Dev — LINE")).toBe("jpn");
  });

  test("a manual list is trimmed", () => {
    expect(resolveOcrLanguages("  tha+eng  ", NO_TITLE)).toBe("tha+eng");
  });

  // The title lookup is a spawnSync (PowerShell). A manual setting must not pay for it.
  test("does not read the window at all when the setting is manual", () => {
    let calls = 0;
    const getTitle = () => { calls++; return "แชท OPM Dev"; };
    expect(resolveOcrLanguages("eng", getTitle)).toBe("eng");
    expect(calls).toBe(0);
  });

  test("reads the window exactly once when the setting is auto", () => {
    let calls = 0;
    const getTitle = () => { calls++; return "GitHub - Chromium"; };
    resolveOcrLanguages("auto", getTitle);
    expect(calls).toBe(1);
  });

  // Uncertain → keep the old behaviour. Guessing "eng" would DROP Thai; "tha+eng" only adds
  // noise, which the downstream reader survives.
  test("an unknown or blank title falls back to tha+eng, not eng", () => {
    expect(resolveOcrLanguages("auto", NO_TITLE)).toBe("tha+eng");
    expect(resolveOcrLanguages("auto", () => "")).toBe("tha+eng");
    expect(resolveOcrLanguages("auto", () => "   ")).toBe("tha+eng");
  });
});
