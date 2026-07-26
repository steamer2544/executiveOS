// Phase 39.x — agent chat backend resilience: retry once on a transient failure, and
// surface an honest Thai message instead of leaking a raw exception. Driven by a live
// Discord incident ("ขอโทษครับ พัง: The operation was aborted.") that turned out to be a
// one-off gateway latency spike >120s with no retry and a cryptic message.

import { describe, it, expect, afterEach } from "bun:test";
import {
  AnthropicChatBackend,
  isTransientNetworkError,
  isEmptyMaxTokens,
  chatErrorMessage,
  ContextTooHeavyError,
  WALL_SAFE_MAX_TOKENS,
  GATEWAY_WALL_MS,
  effectiveTimeoutMs,
} from "./protocol.js";
import type { TranscriptItem } from "./types.js";

// ─── helpers ────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function okResponse(text = "hi"): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }),
    text: async () => "",
  } as unknown as Response;
}

function errResponse(status: number, body = "boom"): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

function makeBackend(timeoutMs = 50): AnthropicChatBackend {
  return new AnthropicChatBackend({
    baseUrl: "https://gw.test",
    model: "qwen-test",
    apiKey: "k",
    maxTokens: 8192,
    timeoutMs,
    protocol: "native",
  });
}

const HELLO: TranscriptItem[] = [{ kind: "user", text: "สวัสดี" }];

// ─── isTransientNetworkError ────────────────────────────────────────────────

describe("isTransientNetworkError", () => {
  it("true for an AbortError (the 120s timeout)", () => {
    const e = new Error("The operation was aborted.");
    (e as { name: string }).name = "AbortError";
    expect(isTransientNetworkError(e)).toBe(true);
  });
  it("true for network-level errors by message and code", () => {
    expect(isTransientNetworkError(new Error("fetch failed"))).toBe(true);
    expect(isTransientNetworkError(new Error("read ECONNRESET"))).toBe(true);
    const e = new Error("x"); (e as unknown as { code: string }).code = "ETIMEDOUT";
    expect(isTransientNetworkError(e)).toBe(true);
  });
  it("false for a plain HTTP 4xx error (must NOT retry — tools-downgrade needs it)", () => {
    expect(isTransientNetworkError(new Error("agent HTTP 400: bad tools"))).toBe(false);
  });
  it("false for an unrelated bug", () => {
    expect(isTransientNetworkError(new TypeError("cannot read x of undefined"))).toBe(false);
  });
});

// ─── chatErrorMessage ───────────────────────────────────────────────────────

describe("chatErrorMessage", () => {
  it("a timeout/abort → honest 'gateway slow, try again' (not the raw exception)", () => {
    const e = new Error("The operation was aborted.");
    (e as { name: string }).name = "AbortError";
    const msg = chatErrorMessage(e);
    expect(msg).toContain("gateway");
    expect(msg).not.toContain("aborted");
  });
  it("a 4xx → surfaces it as a request problem", () => {
    expect(chatErrorMessage(new Error("agent HTTP 400: nope"))).toContain("ปฏิเสธ");
  });
  it("a 5xx → transient", () => {
    expect(chatErrorMessage(new Error("agent HTTP 503: down"))).toContain("5xx");
  });
  it("anything else → falls back to the พัง form", () => {
    expect(chatErrorMessage(new Error("weird"))).toContain("พัง");
  });
});

// ─── isEmptyMaxTokens ───────────────────────────────────────────────────────

describe("isEmptyMaxTokens", () => {
  it("true when stopped at max_tokens with empty/whitespace content", () => {
    expect(isEmptyMaxTokens({ stop_reason: "max_tokens", content: [] })).toBe(true);
    expect(isEmptyMaxTokens({ stop_reason: "max_tokens", content: [{ type: "text", text: "  " }] })).toBe(true);
  });
  it("false when there is real text or a tool call, even at max_tokens", () => {
    expect(isEmptyMaxTokens({ stop_reason: "max_tokens", content: [{ type: "text", text: "hi" }] })).toBe(false);
    expect(isEmptyMaxTokens({ stop_reason: "max_tokens", content: [{ type: "tool_use", name: "get_state" }] })).toBe(false);
  });
  it("false for a normal end_turn even with empty content", () => {
    expect(isEmptyMaxTokens({ stop_reason: "end_turn", content: [] })).toBe(false);
  });
});

// ─── retry in step() ────────────────────────────────────────────────────────

describe("AnthropicChatBackend.step — retry once on a transient failure", () => {
  it("retries after an abort and returns the second (successful) response", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        const e = new Error("The operation was aborted.");
        (e as { name: string }).name = "AbortError";
        throw e;
      }
      return okResponse("recovered");
    }) as unknown as typeof fetch;

    const out = await makeBackend().step({ system: "s", transcript: HELLO, tools: [] });
    expect(calls).toBe(2);
    expect(out.text).toBe("recovered");
  });

  it("retries after a gateway 5xx and returns the second response", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? errResponse(524, "cloudflare") : okResponse("ok2");
    }) as unknown as typeof fetch;

    const out = await makeBackend().step({ system: "s", transcript: HELLO, tools: [] });
    expect(calls).toBe(2);
    expect(out.text).toBe("ok2");
  });

  it("does NOT retry a 4xx — surfaces it immediately (tools-downgrade path)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return errResponse(400, "bad tools");
    }) as unknown as typeof fetch;

    await expect(makeBackend().step({ system: "s", transcript: HELLO, tools: [] })).rejects.toThrow(
      /HTTP 400/,
    );
    expect(calls).toBe(1);
  });

  // An exhausted budget is raised as a TYPED error, not retried. Measured: the gateway
  // kills any request at ~125 s and the model generates at 33–48 tok/s, so a bigger
  // ceiling can never come back; and the spiral is near-deterministic per context (0/7,
  // 0/3, 0/3 on the same transcripts), so re-rolling only burns another ~2 minutes.
  it("throws ContextTooHeavyError on an empty max_tokens — without retrying", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ content: [], stop_reason: "max_tokens" }), text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(
      makeBackend().step({ system: "s", transcript: HELLO, tools: [] })
    ).rejects.toBeInstanceOf(ContextTooHeavyError);
    expect(calls).toBe(1);
  });

  it("never asks for more output tokens than the gateway can return before its wall", async () => {
    const budgets: number[] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      budgets.push((JSON.parse(init.body) as { max_tokens: number }).max_tokens);
      return okResponse("ok");
    }) as unknown as typeof fetch;

    // Ask for far more than the wire can deliver; the clamp must win.
    await new AnthropicChatBackend({
      baseUrl: "https://gw.test",
      model: "m",
      apiKey: "k",
      maxTokens: 32768,
      timeoutMs: 50,
      protocol: "native",
    }).step({ system: "s", transcript: HELLO, tools: [] });

    expect(budgets).toEqual([WALL_SAFE_MAX_TOKENS]);
    expect(WALL_SAFE_MAX_TOKENS).toBeLessThan(GATEWAY_WALL_MS / 1000 * 48);
  });

  it("a configured ceiling BELOW the clamp is respected (the clamp only lowers)", async () => {
    const budgets: number[] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      budgets.push((JSON.parse(init.body) as { max_tokens: number }).max_tokens);
      return okResponse("ok");
    }) as unknown as typeof fetch;

    await new AnthropicChatBackend({
      baseUrl: "https://gw.test", model: "m", apiKey: "k",
      maxTokens: 512, timeoutMs: 50, protocol: "native",
    }).step({ system: "s", transcript: HELLO, tools: [] });

    expect(budgets).toEqual([512]);
  });

  it("aborts before the gateway's wall, so a stall is ours to classify", () => {
    expect(effectiveTimeoutMs(120_000)).toBeLessThan(GATEWAY_WALL_MS);
    expect(effectiveTimeoutMs(30_000)).toBe(30_000); // never lengthens a shorter deadline
  });

  it("a transient retry re-sends the SAME budget (there is no headroom to buy)", async () => {
    const budgets: number[] = [];
    let calls = 0;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      budgets.push((JSON.parse(init.body) as { max_tokens: number }).max_tokens);
      calls++;
      if (calls === 1) throw new Error("fetch failed");
      return okResponse("recovered");
    }) as unknown as typeof fetch;

    const out = await makeBackend().step({ system: "s", transcript: HELLO, tools: [] });
    expect(out.text).toBe("recovered");
    expect(budgets).toEqual([budgets[0]!, budgets[0]!]);
  });

  it("names a spent thinking budget honestly — not as a slow gateway or a crash", () => {
    const msg = chatErrorMessage(new ContextTooHeavyError(3072));
    expect(msg).toContain("คิดจนหมดโควตา");
    expect(msg).not.toContain("พัง:"); // not the generic crash branch
    expect(msg).not.toContain("ตอบช้าเกินไป"); // and not mistaken for a timeout
  });

  it("retries once on an unparseable body (transient gateway hiccup) then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return { ok: true, status: 200, json: async () => { throw new Error("Failed to parse JSON"); }, text: async () => "garbage" } as unknown as Response;
      }
      return okResponse("parsed ok");
    }) as unknown as typeof fetch;

    const out = await makeBackend().step({ system: "s", transcript: HELLO, tools: [] });
    expect(calls).toBe(2);
    expect(out.text).toBe("parsed ok");
  });

  it("gives up after two transient failures and throws the last error", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      const e = new Error("The operation was aborted.");
      (e as { name: string }).name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;

    await expect(makeBackend().step({ system: "s", transcript: HELLO, tools: [] })).rejects.toThrow(
      /aborted/,
    );
    expect(calls).toBe(2);
  });
});
