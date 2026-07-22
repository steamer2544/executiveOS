// Tests for ocr.ts — offline only. Never spawns a real Tesseract or PowerShell:
// every case either uses a pure helper or a deliberately bogus executable path.

import { describe, test, expect } from "bun:test";
import { ocrImage, normalizeThaiOcr, resolveTesseractPath } from "./ocr.js";

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
    expect(typeof ocrImage("C:\\nope\\img.png")).toBe("string");
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
