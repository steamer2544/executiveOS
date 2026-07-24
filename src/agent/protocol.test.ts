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

  it("re-samples once on an empty max_tokens response (Qwen think-loop) then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        // stopped at max_tokens with no usable content — the think-loop casualty
        return {
          ok: true, status: 200,
          json: async () => ({ content: [], stop_reason: "max_tokens" }),
          text: async () => "",
        } as unknown as Response;
      }
      return okResponse("answered on the second roll");
    }) as unknown as typeof fetch;

    const out = await makeBackend().step({ system: "s", transcript: HELLO, tools: [] });
    expect(calls).toBe(2);
    expect(out.text).toBe("answered on the second roll");
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
