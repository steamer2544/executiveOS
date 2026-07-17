// AnthropicSynthesizer — HTTP, strict-JSON, Anthropic Messages API.
// Mirrors Phase 5's AnthropicWorker shape but demands a strict JSON ChangeSet output.

import type { Synthesizer, SynthInput, SynthResult } from "./types.js";
import type { ChangeSet, FileOp } from "../executor/types.js";

export interface AnthropicSynthesizerOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  timeoutMs: number;
}

// ─── System prompt ────────────────────────────────────────────────────────────

/**
 * Fixed system prompt. The LLM converts an approved Proposal into a strict JSON ChangeSet.
 * No prose, no markdown fences — pure JSON only.
 */
export function buildSynthSystemPrompt(): string {
  return (
    "You are the Synthesizer (translator) of ExecutiveOS, an event-driven personal assistant runtime.\n" +
    "You are given an approved Proposal (prose steps) and must convert it into a strict JSON ChangeSet.\n" +
    "Output ONLY a single JSON object — no prose, no markdown fences, no explanation.\n" +
    "The JSON must have this exact shape:\n" +
    '{ "id": string (^[A-Za-z0-9._-]+$), "title": string, "commitMessage": string, ' +
    '"test": string|null, "ops": [ {"op":"write"|"create"|"delete", "path": repo-relative string, ' +
    '"content": string (for write/create) } ] }\n' +
    "Rules:\n" +
    "- Paths are repo-relative, never absolute, never `..`, never under `.git` or `.executive`.\n" +
    "- For `write`/`create` include the ENTIRE new file content.\n" +
    "- Keep the change minimal and focused on the Proposal.\n" +
    "- `test` may be null if no test command is needed.\n" +
    "- `commitMessage` should be a short imperative description.\n" +
    "You do NOT execute anything — you only translate intent into file ops."
  );
}

// ─── User message ─────────────────────────────────────────────────────────────

/**
 * Deterministic serialization of the proposal + context + file material.
 * No clock, no randomness.
 */
export function buildSynthUserMessage(input: SynthInput): string {
  return JSON.stringify(
    {
      proposal: {
        summary: input.proposal.summary,
        steps: input.proposal.steps,
        action: input.proposal.action,
      },
      summary: input.summary,
      files: input.files,
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
export function buildSynthRequestBody(
  input: SynthInput,
  model: string,
  maxTokens: number
): object {
  return {
    model,
    max_tokens: maxTokens,
    temperature: 0,
    system: buildSynthSystemPrompt(),
    messages: [
      {
        role: "user",
        content: buildSynthUserMessage(input),
      },
    ],
  };
}

// ─── Response parsing ─────────────────────────────────────────────────────────

/**
 * Extract text from an Anthropic API response.
 * Concatenates the `text` of every block where `block.type === "text"`.
 */
function parseAnthropicResponse(json: unknown): string {
  const obj = json as Record<string, unknown>;
  const content = obj.content;
  if (!Array.isArray(content)) {
    throw new Error("synth: no text in response");
  }
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block as Record<string, unknown>).type === "text" &&
      "text" in block &&
      typeof (block as Record<string, string>).text === "string"
    ) {
      parts.push(String((block as Record<string, string>).text ?? ""));
    }
  }
  if (parts.length === 0) {
    throw new Error("synth: no text in response");
  }
  return parts.join("\n");
}

/**
 * Leniently extract a ChangeSet JSON object from model text.
 * Strips markdown fences, finds first `{` to last `}`, parses.
 * Coerces missing fields to safe defaults.
 * Does NOT validate — runSynth calls validateChangeSet separately.
 */
export function parseChangeSetJson(text: string): ChangeSet {
  let cleaned = text.trim();

  // Strip leading/trailing markdown fences (```json or ```).
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  // Take the substring from the first `{` to the last `}`.
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("synth: could not parse ChangeSet JSON");
  }
  const jsonStr = cleaned.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error("synth: could not parse ChangeSet JSON");
  }

  const obj = parsed as Record<string, unknown>;

  // Coerce `id`: if missing/empty, derive from title.
  let id = typeof obj.id === "string" && obj.id.trim().length > 0 ? obj.id : "";
  if (!id) {
    const title = typeof obj.title === "string" ? obj.title : "";
    // Slugify: keep only [A-Za-z0-9._-], lowercase.
    const slug = title.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 64);
    id = slug.length > 0 ? "synth-" + slug : "synth";
  }

  // Coerce `title`.
  const title = typeof obj.title === "string" && obj.title.trim().length > 0
    ? obj.title
    : "synthesized change";

  // Coerce `commitMessage`.
  const commitMessage = typeof obj.commitMessage === "string" && obj.commitMessage.trim().length > 0
    ? obj.commitMessage
    : title;

  // Coerce `test`.
  const test = obj.test === null || (typeof obj.test === "string" && obj.test.trim().length > 0)
    ? (obj.test as string | null)
    : null;

  // Coerce `ops`.
  const rawOps = obj.ops;
  const ops: Array<Record<string, unknown>> = Array.isArray(rawOps) ? rawOps : [];

  // Build the ChangeSet.
  const fileOps: FileOp[] = ops.map((o) => {
    const opType = (o.op as "write" | "create" | "delete") ?? "write";
    const path = typeof o.path === "string" ? o.path : "";
    if (opType === "delete") {
      return { op: opType, path } as FileOp;
    }
    return { op: opType, path, content: typeof o.content === "string" ? o.content : "" } as FileOp;
  });

  return {
    id,
    title,
    commitMessage,
    test,
    ops: fileOps,
    basedOnProposal: typeof obj.basedOnProposal === "string" ? obj.basedOnProposal : null,
  };
}

// ─── AnthropicSynthesizer ─────────────────────────────────────────────────────

export class AnthropicSynthesizer implements Synthesizer {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(opts: AnthropicSynthesizerOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.maxTokens = opts.maxTokens;
    this.timeoutMs = opts.timeoutMs;
    this.name = "anthropic:" + opts.model;
  }

  async synthesize(input: SynthInput): Promise<SynthResult> {
    const url = this.baseUrl + "/v1/messages";
    const body = buildSynthRequestBody(input, this.model, this.maxTokens);
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
          "synth HTTP " + res.status + ": " + bodyText.slice(0, 500)
        );
      }

      const json = await res.json();
      const text = parseAnthropicResponse(json);
      const changeSet = parseChangeSetJson(text);
      return {
        changeSet,
        raw: text,
        backend: this.name,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
