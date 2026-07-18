// AnthropicInferer — HTTP, Anthropic Messages API (the 9arm gateway shape).
// Asks the LLM to GUESS block/deadline from recent context and return strict JSON.

import type { Inferer, InferenceGuesses } from "./types.js";
import type { Context } from "../state/types.js";

export interface AnthropicInfererOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  timeoutMs: number;
}

const SYSTEM_PROMPT =
  "You are a signal-inference helper for a developer's assistant.\n" +
  "From the recent activity you are given, GUESS two things:\n" +
  "1) Is the developer likely BLOCKED (waiting on something external, stuck)? If so, a short reason.\n" +
  "2) Is there an implied DEADLINE? If so, an ISO date (YYYY-MM-DD) if stated or clearly implied, else null, plus a short note.\n" +
  "These are only suggestions a human will confirm — do not overstate confidence.\n" +
  'Respond with ONLY a JSON object, no prose, exactly this shape:\n' +
  '{"block":{"likely":boolean,"reason":string},"deadline":{"likely":boolean,"date":string|null,"note":string}}';

export function buildUserMessage(context: Context): string {
  return JSON.stringify(
    { summary: context.summary, state: context.state, recentEvents: context.recentEvents },
    null,
    2
  );
}

export function buildRequestBody(context: Context, model: string, maxTokens: number): object {
  return {
    model,
    max_tokens: maxTokens,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(context) }],
  };
}

/** Concatenate text blocks from an Anthropic response. Throws if none. */
export function extractText(json: unknown): string {
  const obj = json as Record<string, unknown>;
  const content = obj.content;
  if (!Array.isArray(content)) throw new Error("infer: no text in response");
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" && block !== null && "type" in block &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      parts.push(String((block as Record<string, string>).text));
    }
  }
  if (parts.length === 0) throw new Error("infer: no text in response");
  return parts.join("\n");
}

/** Parse the model's JSON (tolerant: strips code fences, finds the first {...}). */
export function parseGuesses(text: string): InferenceGuesses {
  let s = text.trim();
  // strip ```json ... ``` fences if present
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  // else grab from the first { to the last }
  if (!s.startsWith("{")) {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
  }
  const obj = JSON.parse(s) as {
    block?: { likely?: unknown; reason?: unknown };
    deadline?: { likely?: unknown; date?: unknown; note?: unknown };
  };
  return {
    block: {
      likely: Boolean(obj.block?.likely),
      reason: typeof obj.block?.reason === "string" ? obj.block.reason : "",
    },
    deadline: {
      likely: Boolean(obj.deadline?.likely),
      date: typeof obj.deadline?.date === "string" ? obj.deadline.date : null,
      note: typeof obj.deadline?.note === "string" ? obj.deadline.note : "",
    },
    raw: text,
  };
}

export class AnthropicInferer implements Inferer {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(opts: AnthropicInfererOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.maxTokens = opts.maxTokens;
    this.timeoutMs = opts.timeoutMs;
    this.name = "anthropic:" + opts.model;
  }

  async infer(context: Context): Promise<InferenceGuesses> {
    const url = this.baseUrl + "/v1/messages";
    const body = buildRequestBody(context, this.model, this.maxTokens);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      if (this.apiKey) headers["Authorization"] = "Bearer " + this.apiKey;

      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      if (!res.ok) {
        const t = await res.text();
        throw new Error("infer HTTP " + res.status + ": " + t.slice(0, 300));
      }
      const json = await res.json();
      return parseGuesses(extractText(json));
    } finally {
      clearTimeout(timer);
    }
  }
}
