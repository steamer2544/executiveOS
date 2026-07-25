// Chat backends + the two tool-call protocols (Phase 35).
//
// `native` — Anthropic `tools` / `tool_use` / `tool_result` blocks. Preferred: no
//            parsing, and the model is trained on the shape.
// `json`   — tool schemas rendered into the system prompt; the model answers with a
//            fenced ```json {"tool": ..., "args": ...} ``` block. The fallback for a
//            gateway that does not pass `tools` through.
//
// Which one the 9arm gateway supports is UNMEASURED — every probe returned HTTP 524
// because Arm's inference box was down (HANDOFF §4). `scripts/probe-tools.ts` settles
// it when the box is back; until then both paths are implemented and tested, so this
// is not a blocking unknown.

import type { AgentTool, ChatBackend, ModelStep, TranscriptItem } from "./types.js";
import type { Config } from "../config.js";
import { llmMaxTokens, llmTimeoutMs } from "../config.js";

// ─── json protocol: prompt rendering + parsing ────────────────────────────────

/** Render the tool list into prose for a backend that cannot take `tools` natively. */
export function renderToolsForPrompt(tools: AgentTool[]): string {
  const lines = tools.map((t) => {
    const props = Object.entries(t.inputSchema.properties ?? {})
      .map(([k, v]) => {
        const d = (v as { description?: string }).description ?? "";
        const req = (t.inputSchema.required ?? []).includes(k) ? " (required)" : "";
        return `      - ${k}${req}: ${d}`;
      })
      .join("\n");
    return `  * ${t.name} — ${t.description}\n${props || "      (no arguments)"}`;
  });

  return (
    "TOOLS\n" +
    "You can call these tools to look things up and to act. To call one, reply with " +
    "ONLY a fenced json block and nothing else:\n" +
    "```json\n" +
    '{"tool": "get_state", "args": {}}\n' +
    "```\n" +
    "You will be given the result and can then call another tool or answer. " +
    "When you are ready to answer the owner, reply with plain text and no json block.\n\n" +
    lines.join("\n\n")
  );
}

/**
 * Extract a tool call from model prose.
 *
 * Tolerates code fences and surrounding chatter — the model wraps JSON in ```json
 * fences or explains itself first, and every other parser in this codebase has had to
 * learn the same lesson (GOTCHA §1).
 */
export function parseJsonToolCall(
  text: string
): { name: string; args: Record<string, unknown> } | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
      const name = parsed.tool ?? parsed.name;
      if (typeof name !== "string" || name.trim() === "") continue;
      const args = parsed.args ?? parsed.input ?? {};
      return {
        name: name.trim(),
        args: typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** Strip a fenced tool-call block out of prose, so leftover text reads cleanly. */
export function stripToolBlock(text: string): string {
  return text.replace(/```(?:json)?\s*[\s\S]*?```/gi, "").trim();
}

// ─── Wire encoding ────────────────────────────────────────────────────────────

type WireMessage = { role: "user" | "assistant"; content: unknown };

/** Anthropic native: tool_use blocks out, tool_result blocks back. */
export function encodeNative(transcript: TranscriptItem[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const item of transcript) {
    if (item.kind === "user") {
      out.push({ role: "user", content: item.text });
    } else if (item.kind === "assistant") {
      const blocks: unknown[] = [];
      if (item.text.trim()) blocks.push({ type: "text", text: item.text });
      for (const c of item.toolCalls) {
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : "" });
    } else {
      out.push({
        role: "user",
        content: item.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
          ...(r.ok ? {} : { is_error: true }),
        })),
      });
    }
  }
  return out;
}

/** json fallback: everything is prose, tool results come back as a user message. */
export function encodeJson(transcript: TranscriptItem[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const item of transcript) {
    if (item.kind === "user") {
      out.push({ role: "user", content: item.text });
    } else if (item.kind === "assistant") {
      const call = item.toolCalls[0];
      const content = call
        ? "```json\n" + JSON.stringify({ tool: call.name, args: call.args }) + "\n```"
        : item.text;
      out.push({ role: "assistant", content: content || "(no output)" });
    } else {
      const body = item.results
        .map((r) => `Result of ${r.name}${r.ok ? "" : " (FAILED)"}:\n${r.content}`)
        .join("\n\n");
      out.push({ role: "user", content: body });
    }
  }
  return out;
}

// ─── Anthropic-shape backend ──────────────────────────────────────────────────

export interface AnthropicChatOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  timeoutMs: number;
  protocol: "native" | "json";
}

/** Parse an Anthropic response into a protocol-neutral ModelStep. */
export function parseNativeStep(json: unknown): ModelStep {
  const obj = json as Record<string, unknown>;
  const content = obj.content;
  const stopReason = typeof obj.stop_reason === "string" ? obj.stop_reason : undefined;
  const texts: string[] = [];
  const toolCalls: ModelStep["toolCalls"] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        texts.push(b.text);
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        toolCalls.push({
          id: typeof b.id === "string" ? b.id : crypto.randomUUID(),
          name: b.name,
          args:
            typeof b.input === "object" && b.input !== null
              ? (b.input as Record<string, unknown>)
              : {},
        });
      }
    }
  }

  // A budget exhaustion and a malformed answer must NOT look alike — that ambiguity
  // hid a real outage for hours (Phase 29.2 / 33.1).
  if (texts.length === 0 && toolCalls.length === 0) {
    if (stopReason === "max_tokens") {
      throw new Error(
        "agent: the model used its entire token budget thinking and produced no answer " +
          "(stop_reason: max_tokens) — raise config.worker.maxTokens"
      );
    }
    throw new Error("agent: no text and no tool call in the response");
  }

  return { text: texts.join("\n"), toolCalls, stopReason };
}

export class AnthropicChatBackend implements ChatBackend {
  readonly name: string;
  readonly protocol: "native" | "json";
  private readonly opts: AnthropicChatOptions;

  constructor(opts: AnthropicChatOptions) {
    this.opts = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, "") };
    this.protocol = opts.protocol;
    this.name = `anthropic:${opts.model}:${opts.protocol}`;
  }

  async step(input: {
    system: string;
    transcript: TranscriptItem[];
    tools: AgentTool[];
  }): Promise<ModelStep> {
    const native = this.protocol === "native";
    const system = native
      ? input.system
      : input.system + "\n\n" + renderToolsForPrompt(input.tools);

    // Qwen's RECOMMENDED thinking-mode sampling — NOT greedy (temperature 0). The model's
    // own docs warn that greedy decoding "can lead to endless repetitions" in thinking mode,
    // and that is exactly what we hit: with `temperature: 0` a meta question ("planner
    // คืออะไร") sent the model into an infinite <think> loop that burned the whole
    // max_tokens budget and returned NO answer (stop_reason: max_tokens). Measured live:
    // temp 0 → always loops; temp 0.6 alone → ~1/3 still loops; temp 0.6 + top_p 0.95 +
    // top_k 20 → 5/5 clean. See GOTCHA §1.
    const body: Record<string, unknown> = {
      model: this.opts.model,
      max_tokens: this.opts.maxTokens,
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      system,
      messages: native ? encodeNative(input.transcript) : encodeJson(input.transcript),
    };
    if (native) {
      body.tools = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.opts.apiKey) headers["Authorization"] = "Bearer " + this.opts.apiKey;
    const payload = JSON.stringify(body);

    // Two independent retry budgets:
    //  • TRANSIENT_MAX — infra failures (abort/timeout, network error, gateway 5xx/524, or an
    //    unparseable body). One retry is enough: a spike clears fast.
    //  • SAMPLE_MAX — the model looped in its <think> phase and returned an EMPTY max_tokens
    //    response. Even with Qwen's recommended sampling this still happens ~25% of the time on
    //    a reasoning-heavy prompt; each roll is independent at temperature>0, so re-sampling 3×
    //    drives ~25% down to ~0.4%. This is the COMMON failure, hence the larger budget.
    // A 4xx is NEVER retried — real request problem, and the native→json tools-downgrade
    // (isToolsUnsupported) depends on seeing it.
    const SAMPLE_MAX = 4;
    const TRANSIENT_MAX = 2;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= SAMPLE_MAX; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        const res = await fetch(this.opts.baseUrl + "/v1/messages", {
          method: "POST",
          headers,
          body: payload,
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          if (res.status >= 500 && attempt < TRANSIENT_MAX) {
            lastErr = new Error(`agent HTTP ${res.status}: ${text.slice(0, 200)}`);
            await sleep(RETRY_BACKOFF_MS);
            continue;
          }
          throw new Error(`agent HTTP ${res.status}: ${text.slice(0, 400)}`);
        }
        let json: unknown;
        try {
          json = await res.json();
        } catch (pe) {
          // Truncated / non-JSON body — a transient gateway hiccup; retry like a 5xx.
          lastErr = pe;
          if (attempt < TRANSIENT_MAX) {
            await sleep(RETRY_BACKOFF_MS);
            continue;
          }
          throw new Error("agent: gateway returned an unparseable response");
        }
        // The model looped and produced no usable output — re-sample (a fresh roll at
        // temperature>0 usually answers) instead of failing the turn.
        if (isEmptyMaxTokens(json) && attempt < SAMPLE_MAX) {
          lastErr = new Error("agent: empty max_tokens response — re-sampling");
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        const step = parseNativeStep(json);
        if (native) return step;

        // json protocol: the tool call is inside the text.
        const call = parseJsonToolCall(step.text);
        if (!call) return { text: step.text, toolCalls: [], stopReason: step.stopReason };
        return {
          text: stripToolBlock(step.text),
          toolCalls: [{ id: crypto.randomUUID(), ...call }],
          stopReason: step.stopReason,
        };
      } catch (e) {
        lastErr = e;
        if (attempt < TRANSIENT_MAX && isTransientNetworkError(e)) {
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    // Reached only if the last attempt was a retryable case that fell through (e.g. the final
    // empty-max_tokens); parseNativeStep on that path throws its own descriptive error first.
    throw lastErr ?? new Error("agent: request failed");
  }
}

/** Backoff between the two attempts. Short — a transient blip clears fast, and after a
 *  120 s abort an extra pause is negligible. */
const RETRY_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A human, actionable Thai message for a failed chat turn (Phase 29.2 "failure honesty":
 * never leak a raw exception like "The operation was aborted." to the owner). Distinguishes
 * a timeout — the gateway is sometimes slow, so just resend — from a real request error.
 * The retry above already ran, so a timeout here means BOTH attempts exceeded the deadline.
 */
export function chatErrorMessage(e: unknown): string {
  const err = e as { name?: string; message?: string };
  const msg = String(err?.message ?? "");
  if (err?.name === "AbortError" || /abort|timed?\s?out/i.test(msg)) {
    return "gateway ตอบช้าเกินไป (ลองอัตโนมัติ 2 ครั้งแล้ว) — บางทีมันช้าชั่วคราวครับ ลองพิมพ์มาใหม่อีกทีได้เลย";
  }
  if (/HTTP 4\d\d/.test(msg)) {
    return "คำขอมีปัญหา (gateway ปฏิเสธ): " + msg.slice(0, 200);
  }
  if (/HTTP 5\d\d/.test(msg)) {
    return "gateway มีปัญหาชั่วคราว (5xx) — ลองใหม่อีกครั้งครับ";
  }
  return "ขอโทษครับ พัง: " + (msg || "unknown error");
}

/** True if the response is a Qwen think-loop casualty: it stopped at `max_tokens` with no
 *  usable text and no tool call. Worth one re-sample (see step()); mirrors the throw
 *  condition in parseNativeStep so the two never disagree. */
export function isEmptyMaxTokens(json: unknown): boolean {
  const o = json as { stop_reason?: unknown; content?: unknown };
  if (o?.stop_reason !== "max_tokens") return false;
  const c = o.content;
  if (!Array.isArray(c)) return true;
  return !c.some((b) => {
    const bl = b as { type?: unknown; text?: unknown };
    return (bl?.type === "text" && typeof bl.text === "string" && bl.text.trim() !== "") || bl?.type === "tool_use";
  });
}

/** A transient failure worth exactly one retry: an abort/timeout or a network-level error.
 *  Deliberately NOT any HTTP status — a 4xx is a real request problem (and the loop's
 *  tools-downgrade path needs to see it); 5xx retry is handled inline at the call site. */
export function isTransientNetworkError(e: unknown): boolean {
  const err = e as { name?: string; message?: string; code?: string };
  if (err?.name === "AbortError") return true;
  const msg = String(err?.message ?? "");
  const code = String(err?.code ?? "");
  return (
    /abort|timed?\s?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket hang/i.test(msg) ||
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/.test(code)
  );
}

/** Does this error look like the gateway refusing the `tools` field? */
export function isToolsUnsupported(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? "");
  if (!/HTTP 4\d\d/.test(msg)) return false;
  return /tool/i.test(msg);
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build the chat backend from config. Reuses `config.worker` — no new gateway, no new
 * token. The token floor is 8192, not the usual 4096: the Advisor hit
 * `stop_reason: max_tokens` on 3/3 live runs at 4096 once its prompt grew (Phase 33.1),
 * and an agent prompt carrying tool schemas is strictly longer than that one.
 */
export function createChatBackend(config: Config): ChatBackend {
  const w = config.worker ?? {};
  const baseUrl = w.baseUrl ?? "";
  const apiKeyEnv = w.apiKeyEnv ?? "EXECUTIVE_WORKER_KEY";
  const requested = config.agent?.toolProtocol ?? "auto";
  // "auto" starts native; the loop downgrades to json if the gateway rejects `tools`.
  const protocol: "native" | "json" = requested === "json" ? "json" : "native";

  return new AnthropicChatBackend({
    baseUrl,
    model: w.model ?? "qwen3.6-35b-a3b",
    apiKey: process.env[apiKeyEnv] ?? "",
    maxTokens: llmMaxTokens(config, 8192),
    timeoutMs: llmTimeoutMs(config),
    protocol,
  });
}
