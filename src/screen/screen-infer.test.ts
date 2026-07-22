// Tests for screen-infer.ts — offline only, no PowerShell or network.
// All I/O is injected via deps.

import { describe, test, expect } from "bun:test";
import { runScreenInference } from "./screen-infer.js";
import type { Config } from "../config.js";
import type { Suggestion } from "../report/types.js";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Build a minimal Config with screen + worker blocks. */
function makeConfig(overrides?: {
  screen?: Partial<Config["screen"]>;
  worker?: Partial<Config["worker"]>;
}): Config {
  return {
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    timezone: "Asia/Bangkok",
    worker: {
      backend: "mock",
      baseUrl: "http://localhost:9999",
      model: "qwen3.6-35b-a3b",
      apiKeyEnv: "EXECUTIVE_WORKER_KEY",
      maxTokens: 4096,
      timeoutMs: 120000,
      autoInvoke: false,
      ...overrides?.worker,
    },
    screen: {
      ocr: { enabled: false, cooldownMs: 300000, minChars: 40 },
      vision: {
        enabled: false,
        cooldownMs: 600000,
        escalateFromOcr: true,
        model: "qwen-vl-max",
        maxImageBytes: 2000000,
        ...overrides?.screen?.vision,
      },
      ...overrides?.screen,
    },
  } as unknown as Config;
}

describe("runScreenInference", () => {
  test("both ocr and vision disabled → ran:false, layer:none", async () => {
    const config = makeConfig({
      screen: {
        ocr: { enabled: false },
        vision: { enabled: false },
      },
    });
    const result = await runScreenInference(config);
    expect(result.ran).toBe(false);
    expect(result.layer).toBe("none");
    expect(result.suggestions).toEqual([]);
    expect(result.message).toBe("screen sensing disabled");
  });

  test("ocr enabled, capture returns shot, text passes minChars → layer:ocr", async () => {
    const config = makeConfig({
      screen: {
        ocr: { enabled: true, minChars: 40 },
        vision: { enabled: false },
      },
    });

    const fakeShot = { path: "x.jpg", bytes: 1000, format: "jpeg" as const };
    const longText = "a".repeat(50); // >= minChars
    const mockSuggestions: Suggestion[] = [
      {
        kind: "block",
        text: "t",
        emit: { type: "system.blocked", data: { reason: "test" } },
      },
    ];

    const visionCalled = { value: false };
    const result = await runScreenInference(config, {
      capture: () => fakeShot,
      ocr: () => longText,
      textInfer: async () => mockSuggestions,
      vision: async () => {
        visionCalled.value = true;
        return "";
      },
    });

    expect(result.ran).toBe(true);
    expect(result.layer).toBe("ocr");
    expect(result.suggestions).toEqual(mockSuggestions);
    expect(visionCalled.value).toBe(false); // vision must NOT be called
  });

  test("ocr thin + vision enabled + escalateFromOcr → escalates to vision", async () => {
    const config = makeConfig({
      screen: {
        ocr: { enabled: true, minChars: 40 },
        vision: { enabled: true, escalateFromOcr: true },
      },
    });

    const tmpPath = join(tmpdir(), "screen-infer-test-ocr-escalate-" + Date.now() + ".jpg");
    writeFileSync(tmpPath, "fake-jpeg-bytes");

    const fakeShot = { path: tmpPath, bytes: 15, format: "jpeg" as const };
    const shortText = "hi"; // < minChars
    let visionCallCount = 0;

    try {
      const result = await runScreenInference(config, {
        capture: () => fakeShot,
        ocr: () => shortText,
        textInfer: async () => [],
        vision: async () => {
          visionCallCount++;
          return "";
        },
      });

      expect(result.ran).toBe(true);
      expect(result.layer).toBe("vision");
      expect(visionCallCount).toBe(1);
    } finally {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    }
  });

  test("ocr disabled, vision enabled → straight to vision", async () => {
    const config = makeConfig({
      screen: {
        ocr: { enabled: false },
        vision: { enabled: true },
      },
    });

    const tmpPath = join(tmpdir(), "screen-infer-test-vision-only-" + Date.now() + ".jpg");
    writeFileSync(tmpPath, "fake-jpeg-bytes");

    const fakeShot = { path: tmpPath, bytes: 15, format: "jpeg" as const };
    let ocrCallCount = 0;
    let visionCallCount = 0;

    try {
      const result = await runScreenInference(config, {
        capture: () => fakeShot,
        ocr: () => {
          ocrCallCount++;
          return "";
        },
        vision: async () => {
          visionCallCount++;
          return "";
        },
      });

      expect(result.ran).toBe(true);
      expect(result.layer).toBe("vision");
      expect(ocrCallCount).toBe(0); // ocr must NOT be called
      expect(visionCallCount).toBe(1);
    } finally {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    }
  });

  test("capture returns null → no crash, returns empty suggestions", async () => {
    const config = makeConfig({
      screen: {
        ocr: { enabled: true, minChars: 40 },
        vision: { enabled: false },
      },
    });

    const result = await runScreenInference(config, {
      capture: () => null,
      ocr: () => "should not be called",
      textInfer: async () => [],
    });

    expect(result.ran).toBe(true);
    expect(result.suggestions).toEqual([]);
  });

  test("temp screenshot is cleaned up in finally block", async () => {
    const config = makeConfig({
      screen: {
        ocr: { enabled: true, minChars: 40 },
        vision: { enabled: false },
      },
    });

    const tmpPath = join(tmpdir(), "screen-infer-test-" + Date.now() + ".jpg");
    writeFileSync(tmpPath, ""); // create empty temp file

    try {
      await runScreenInference(config, {
        capture: () => ({ path: tmpPath, bytes: 0, format: "jpeg" }),
        ocr: () => "a".repeat(50),
        textInfer: async () => [],
      });

      // After runScreenInference resolves, the temp file should be deleted.
      expect(existsSync(tmpPath)).toBe(false);
    } finally {
      // Clean up if the test itself didn't delete it.
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    }
  });

  test("task suggestion round-trips with correct emit shape", async () => {
    const config = makeConfig({
      screen: {
        ocr: { enabled: true, minChars: 40 },
        vision: { enabled: false },
      },
    });

    const taskSuggestion: Suggestion = {
      kind: "task",
      text: "Possible task (from screen) — fix login bug",
      emit: { type: "system.task", data: { task: "fix login bug" } },
    };

    const result = await runScreenInference(config, {
      capture: () => ({ path: "x.jpg", bytes: 1000, format: "jpeg" }),
      ocr: () => "a".repeat(50),
      textInfer: async () => [taskSuggestion],
    });

    expect(result.ran).toBe(true);
    expect(result.layer).toBe("ocr");
    expect(result.suggestions.length).toBe(1);
    const s = result.suggestions[0]!;
    expect(s.emit).toEqual({
      type: "system.task",
      data: { task: "fix login bug" },
    });
  });
});
