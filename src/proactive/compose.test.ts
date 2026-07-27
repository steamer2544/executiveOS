// Tests for nudgeSubject and buildPrompt (Phase 42 — Job 1).

import { describe, test, expect } from "bun:test";
import { nudgeSubject, composeNudge } from "./compose.js";
import type { ChatBackend, ModelStep, TranscriptItem } from "../agent/types.js";
import type { Config } from "../config.js";

/** Minimal config for composeNudge (no real network). */
function makeConfig(): Config {
  return {
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    timezone: "Asia/Bangkok",
    watch: { git: { enabled: true, repoPath: process.cwd(), pollMs: 5000 }, fs: { enabled: true, paths: [process.cwd() + "/src"], debounceMs: 300 } },
    state: { intervalMs: 30000 },
    worker: { backend: "anthropic", baseUrl: "http://localhost:9999", model: "test", apiKeyEnv: "TEST_KEY", maxTokens: 4096, timeoutMs: 120000, autoInvoke: false },
    agent: {
      enabled: true,
      toolProtocol: "auto",
      maxToolRounds: 8,
      historyTurns: 20,
      speak: false,
      trustedTools: [],
      commandTimeoutMs: 60000,
      proactive: {
        enabled: true,
        maxPerDay: 6,
        minGapMs: 1800000,
        quietFrom: "22:00",
        quietTo: "08:00",
      },
    },
  } as Config;
}

// ─── nudgeSubject ─────────────────────────────────────────────────────────────

describe("nudgeSubject", () => {
  test("returns detail when detail is a non-empty string (criterion 1)", () => {
    const nudge = {
      key: "plan|test",
      source: "plan" as const,
      summary: "INTERNAL label",
      detail: "90 minutes with no break — worth a short pause",
    };
    expect(nudgeSubject(nudge)).toBe("90 minutes with no break — worth a short pause");
  });

  test("returns summary when detail is undefined (criterion 2)", () => {
    const nudge = {
      key: "autopilot|test",
      source: "autopilot" as const,
      summary: "Autopilot stopped and needs you",
    };
    expect(nudgeSubject(nudge)).toBe("Autopilot stopped and needs you");
  });

  test("returns summary when detail is empty string (criterion 2)", () => {
    const nudge = {
      key: "plan|test",
      source: "plan" as const,
      summary: "Autopilot stopped and needs you",
      detail: "",
    };
    expect(nudgeSubject(nudge)).toBe("Autopilot stopped and needs you");
  });

  test("returns summary when detail is whitespace-only (criterion 2)", () => {
    const nudge = {
      key: "plan|test",
      source: "plan" as const,
      summary: "Autopilot stopped and needs you",
      detail: "   ",
    };
    expect(nudgeSubject(nudge)).toBe("Autopilot stopped and needs you");
  });

  test("prefers the digest-supplied label over both summary and detail", () => {
    // Post-Phase-42 review: `detail || summary` is the right rule for the `plan` source ONLY.
    // For executor/autopilot/worker the SUMMARY is the human sentence and `detail` is the
    // extra, so preferring detail dropped the part that matters ("with FAILING tests") and
    // kept the changeset title. buildDigest now supplies an explicit label per source.
    const nudge = {
      key: "executor|parked",
      source: "executor" as const,
      summary: "A change is parked on executive/change-7 with FAILING tests",
      detail: "Add retry to fetch",
      label: "A change is parked on executive/change-7 with FAILING tests — Add retry to fetch",
    };
    expect(nudgeSubject(nudge)).toContain("FAILING tests");
    expect(nudgeSubject(nudge)).toContain("Add retry to fetch");
  });

  test("returns empty string when both summary and detail are empty (criterion 3)", () => {
    const nudge = {
      key: "plan|test",
      source: "plan" as const,
      summary: "",
      detail: "",
    };
    expect(nudgeSubject(nudge)).toBe("");
  });
});

// ─── buildPrompt (via composeNudge with a fake backend) ────────────────────────

describe("buildPrompt content — plan nudge", () => {
  class PassthroughBackend implements ChatBackend {
    name = "passthrough";
    protocol: "native" | "json" = "native";
    capturedPrompt = "";

    step({ transcript }: { system: string; transcript: TranscriptItem[]; tools: unknown[] }): Promise<ModelStep> {
      this.capturedPrompt = (transcript[0] as { kind: string; text: string }).text;
      return Promise.resolve({ text: "Thai reply", toolCalls: [] });
    }
  }

  test("prompt for plan nudge contains detail, not internal identifiers (criterion 4)", async () => {
    const backend = new PassthroughBackend();
    const nudge = {
      key: "plan|long_session",
      source: "plan" as const,
      summary: "Planner needs your call: long_session",
      detail: "90 minutes with no break — worth a short pause",
    };

    await composeNudge(nudge, makeConfig(), () => backend);

    const prompt = backend.capturedPrompt;
    expect(prompt).toContain("90 minutes with no break");

    // Assert on the WHOLE prompt, not just the subject line. Scoping this to the first line
    // is what let the instruction text smuggle the forbidden identifiers back in — the model
    // reads the entire prompt, so the entire prompt is the contract.
    expect(prompt).not.toContain("long_session");
    expect(prompt).not.toContain("grinding_on_file");
    expect(prompt).not.toContain("needs your call");
    expect(prompt).not.toContain("Planner");
  });

  test("prompt for nudge without detail still contains summary, exactly once (criterion 5)", async () => {
    const backend = new PassthroughBackend();
    const nudge = {
      key: "autopilot|stopped",
      source: "autopilot" as const,
      summary: "Autopilot stopped and needs you",
    };

    await composeNudge(nudge, makeConfig(), () => backend);

    const prompt = backend.capturedPrompt;
    expect(prompt).toContain("Autopilot stopped and needs you");
    // nudgeSubject already falls back to the summary, so echoing it a second time as a
    // "context" line would hand the model the same sentence twice.
    expect(prompt.split("Autopilot stopped and needs you").length - 1).toBe(1);
  });
});

// ─── deterministicFallback ────────────────────────────────────────────────────

describe("deterministicFallback", () => {
  /** The fallback is only reachable through composeNudge when the backend fails. */
  class DownBackend implements ChatBackend {
    name = "down";
    protocol: "native" | "json" = "native";
    step(): Promise<ModelStep> { return Promise.reject(new Error("gateway down")); }
  }

  test("fallback for plan nudge equals detail exactly, no internal identifiers (criterion 6)", async () => {
    const nudge = {
      key: "plan|long_session",
      source: "plan" as const,
      summary: "Planner needs your call: long_session",
      detail: "90 minutes with no break — worth a short pause",
    };

    const result = await composeNudge(nudge, makeConfig(), () => new DownBackend());

    // This is the text the OWNER receives when the gateway is down — the real live path,
    // not the prompt. It must be the human sentence and nothing else.
    expect(result.text).toBe("90 minutes with no break — worth a short pause");
    expect(result.text).not.toContain("long_session");
    expect(result.text).not.toContain("needs your call");
    expect(result.text).not.toContain("Planner");
    expect(result.text).not.toContain(" — Planner");
  });

  test("fallback for a nudge with no detail is the summary (criterion 6)", async () => {
    const nudge = {
      key: "autopilot|stopped",
      source: "autopilot" as const,
      summary: "Autopilot stopped and needs you",
    };

    const result = await composeNudge(nudge, makeConfig(), () => new DownBackend());
    expect(result.text).toBe("Autopilot stopped and needs you");
  });
});

// ─── composeNudge contract preservation ────────────────────────────────────────

describe("composeNudge contract", () => {
  class ThrowBackend implements ChatBackend {
    name = "throw";
    protocol: "native" | "json" = "native";
    step(): Promise<ModelStep> { throw new Error("down"); }
  }

  test("backend that throws → { composedBy: 'fallback' } with fallback text (criterion 7)", async () => {
    const nudge = {
      key: "plan|long_session",
      source: "plan" as const,
      summary: "Planner needs your call: long_session",
      detail: "90 minutes with no break — worth a short pause",
    };

    const result = await composeNudge(nudge, makeConfig(), () => new ThrowBackend() as unknown as ChatBackend);

    expect(result.composedBy).toBe("fallback");
    expect(result.text).toBe("90 minutes with no break — worth a short pause");
  });

  test("backend returning empty text → fallback (criterion 8)", async () => {
    class EmptyBackend implements ChatBackend {
      name = "empty";
      protocol: "native" | "json" = "native";
      step(): Promise<ModelStep> { return Promise.resolve({ text: "", toolCalls: [] }); }
    }

    const nudge = {
      key: "plan|long_session",
      source: "plan" as const,
      summary: "Planner needs your call: long_session",
      detail: "90 minutes with no break — worth a short pause",
    };

    const result = await composeNudge(nudge, makeConfig(), () => new EmptyBackend() as unknown as ChatBackend);

    expect(result.composedBy).toBe("fallback");
    expect(result.text).toBe("90 minutes with no break — worth a short pause");
  });
});
