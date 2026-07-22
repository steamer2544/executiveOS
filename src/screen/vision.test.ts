// Tests for vision.ts — offline only, no network calls.
// Asserts: buildVisionRequestBody shape, extractOpenAiText happy / malformed,
// and Authorization header construction.

import { describe, test, expect } from "bun:test";
import {
  buildVisionRequestBody,
  extractOpenAiText,
  visionComplete,
} from "./vision.js";

describe("buildVisionRequestBody", () => {
  test("produces correct shape with model, max_tokens, and message parts", () => {
    const body = buildVisionRequestBody(
      "qwen-vl-max",
      4096,
      "What do you see?",
      "data:image/jpeg;base64,abc123",
    );

    expect((body as Record<string, unknown>).model).toBe("qwen-vl-max");
    expect((body as Record<string, unknown>).max_tokens).toBe(4096);

    const messages = (body as Record<string, unknown>).messages as unknown[];
    expect(messages.length).toBe(1);

    const content = (messages[0] as Record<string, unknown>).content as unknown[];
    expect(content.length).toBe(2);

    expect(content[0]).toEqual({ type: "text", text: "What do you see?" });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,abc123" },
    });
  });
});

describe("extractOpenAiText", () => {
  test("returns content string from a valid response", () => {
    const json = { choices: [{ message: { content: "hello" } }] };
    expect(extractOpenAiText(json)).toBe("hello");
  });

  test("throws when json is not an object", () => {
    expect(() => extractOpenAiText(null as unknown)).toThrow("vision: no text in response");
    expect(() => extractOpenAiText("string" as unknown)).toThrow("vision: no text in response");
    expect(() => extractOpenAiText(42 as unknown)).toThrow("vision: no text in response");
  });

  test("throws when choices is missing or not an array", () => {
    expect(() => extractOpenAiText({} as unknown)).toThrow("vision: no text in response");
    expect(() => extractOpenAiText({ choices: "nope" } as unknown)).toThrow(
      "vision: no text in response",
    );
  });

  test("throws when choices array is empty", () => {
    expect(() => extractOpenAiText({ choices: [] })).toThrow("vision: no text in response");
  });

  test("throws when choices[0].message is missing", () => {
    expect(() => extractOpenAiText({ choices: [{}] })).toThrow("vision: no text in response");
  });

  test("throws when choices[0].message.content is missing", () => {
    expect(() => extractOpenAiText({ choices: [{ message: {} }] })).toThrow(
      "vision: no text in response",
    );
  });

  test("throws when content is not a string", () => {
    expect(() =>
      extractOpenAiText({ choices: [{ message: { content: 123 } }] } as unknown),
    ).toThrow("vision: no text in response");
  });
});

describe("visionComplete — Authorization header", () => {
  test("includes Authorization header when apiKey is set (mocked fetch)", async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = async (input: string | URL | Request, init?: Record<string, unknown>) => {
      capturedHeaders = ((init?.headers as Record<string, string>) || {}) as Record<string, string>;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    (globalThis.fetch as unknown) = mockFetch;

    try {
      await visionComplete(
        {
          baseUrl: "http://localhost:9999",
          model: "test",
          apiKey: "secret-key",
          maxTokens: 1024,
          timeoutMs: 5000,
        },
        "prompt",
        "data:image/jpeg;base64,x",
      );
      expect(capturedHeaders["Authorization"]).toBe("Bearer secret-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("omits Authorization header when apiKey is empty", async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = async (input: string | URL | Request, init?: Record<string, unknown>) => {
      capturedHeaders = ((init?.headers as Record<string, string>) || {}) as Record<string, string>;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    (globalThis.fetch as unknown) = mockFetch;

    try {
      await visionComplete(
        {
          baseUrl: "http://localhost:9999",
          model: "test",
          apiKey: "",
          maxTokens: 1024,
          timeoutMs: 5000,
        },
        "prompt",
        "data:image/jpeg;base64,x",
      );
      expect(capturedHeaders["Authorization"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
