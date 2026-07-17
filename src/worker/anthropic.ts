// AnthropicWorker — HTTP, Anthropic Messages API.
// Posts to ${baseUrl}/v1/messages (the 9arm gateway shape).

import type { Worker, WorkerInput, WorkerOutput } from "./types.js";

export interface AnthropicWorkerOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  timeoutMs: number;
}

// ─── System prompt ────────────────────────────────────────────────────────────

/**
 * Fixed system prompt. The LLM is the Worker (CPU) of an OS —
 * it reasons about ONE action and proposes concrete steps.
 * It does NOT execute anything.
 */
export function buildSystemPrompt(): string {
  return (
    "You are the Worker (reasoning engine) of ExecutiveOS, an event-driven personal assistant runtime.\n" +
    "You are given ONE action to carry out and a compact context snapshot.\n" +
    "Propose concrete, actionable steps to carry out that action.\n" +
    "You do NOT execute anything — you only reason and write a proposal.\n" +
    "Keep your output concise. Use short lines for steps."
  );
}

// ─── User message ─────────────────────────────────────────────────────────────

/**
 * Deterministic serialization of the action + context.
 * No clock, no randomness.
 */
export function buildUserMessage(input: WorkerInput): string {
  return JSON.stringify(
    {
      action: input.action,
      summary: input.context.summary,
      state: input.context.state,
      recentEvents: input.context.recentEvents,
    },
    null,
    2
  );
}

// ─── Request body ─────────────────────────────────────────────────────────────

/**
 * Assemble the full Anthropic Messages API request body.
 * Top-level `system` string + single `user` message.
 */
export function buildRequestBody(
  input: WorkerInput,
  model: string,
  maxTokens: number
): object {
  return {
    model,
    max_tokens: maxTokens,
    temperature: 0,
    system: buildSystemPrompt(),
    messages: [
      {
        role: "user",
        content: buildUserMessage(input),
      },
    ],
  };
}

// ─── Response parsing ─────────────────────────────────────────────────────────

/**
 * Extract text from an Anthropic API response.
 * Concatenates the `text` of every block where `block.type === "text"`.
 */
export function parseAnthropicResponse(json: unknown): string {
  const obj = json as Record<string, unknown>;
  const content = obj.content;
  if (!Array.isArray(content)) {
    throw new Error("worker: no text in response");
  }
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block as Record<string, unknown>).type === "text" &&
      "text" in block &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      parts.push(String((block as Record<string, string>).text ?? ""));
    }
  }
  if (parts.length === 0) {
    throw new Error("worker: no text in response");
  }
  return parts.join("\n");
}

/**
 * Parse the raw model text into a WorkerOutput.
 * summary = first non-empty line; steps = all non-empty lines (bullets stripped).
 */
export function parseCompletion(text: string): WorkerOutput {
  if (!text.trim()) {
    return { summary: "(empty completion)", steps: [], raw: text };
  }
  const lines = text.split("\n").map((l) => l.trim());
  const rawSummary = lines.find((l) => l.length > 0) ?? "(empty completion)";
  const summary = rawSummary.replace(/^[-*]\s*/, "").replace(/^\d+\.\s*/, "");
  const steps = lines
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-*]\s*/, "").replace(/^\d+\.\s*/, ""));
  return { summary, steps, raw: text };
}

// ─── AnthropicWorker ──────────────────────────────────────────────────────────

export class AnthropicWorker implements Worker {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(opts: AnthropicWorkerOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.maxTokens = opts.maxTokens;
    this.timeoutMs = opts.timeoutMs;
    this.name = "anthropic:" + opts.model;
  }

  async run(input: WorkerInput): Promise<WorkerOutput> {
    const url = this.baseUrl + "/v1/messages";
    const body = buildRequestBody(input, this.model, this.maxTokens);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      if (this.apiKey) {
        headers["Authorization"] = "Bearer " + this.apiKey;
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const bodyText = await res.text();
        throw new Error(
          "worker HTTP " + res.status + ": " + bodyText.slice(0, 500)
        );
      }

      const json = await res.json();
      const text = parseAnthropicResponse(json);
      return parseCompletion(text);
    } finally {
      clearTimeout(timer);
    }
  }
}
