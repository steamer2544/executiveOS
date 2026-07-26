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
      // Do NOT tell the owner to "raise config.worker.maxTokens": the ceiling is clamped to
      // what the gateway can physically return before its ~125 s wall (WALL_SAFE_MAX_TOKENS),
      // so headroom is not the lever. Context is — which is why this is a typed error.
      throw new ContextTooHeavyError();
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

    // ONE retry budget: TRANSIENT_MAX, for infra failures (abort/timeout, network error,
    // gateway 5xx/524, or an unparseable body). One retry is enough — a spike clears fast.
    // A 4xx is NEVER retried: real request problem, and the native→json tools-downgrade
    // (isToolsUnsupported) depends on seeing it.
    //
    // There is deliberately NO re-sample-on-empty-budget retry here any more. It used to
    // re-roll (and escalate the ceiling) in place, on the premise that each roll was an
    // independent ~25% risk. Measurement killed both halves of that premise: the ceiling
    // cannot be escalated (WALL_SAFE_MAX_TOKENS — the bigger response can never come back),
    // and the roll is not independent (the same context spiralled 0/7, 0/3, 0/3). Retrying
    // here could only burn another ~2 minutes to fail identically. The context is the only
    // lever, so an exhausted budget is raised to the loop as ContextTooHeavyError.
    const TRANSIENT_MAX = 2;
    const budget = effectiveMaxTokens(this.opts.maxTokens);
    const deadline = effectiveTimeoutMs(this.opts.timeoutMs);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= TRANSIENT_MAX; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deadline);
      const payload = JSON.stringify({ ...body, max_tokens: budget });
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
        // The model spent the whole ceiling thinking and produced no usable output. Neither
        // a bigger ceiling nor a fresh roll can help (see ContextTooHeavyError) — hand it to
        // the loop, which can retry with less context.
        if (isEmptyMaxTokens(json)) throw new ContextTooHeavyError(budget);
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
        // A spent budget is NOT transient — retrying the same context reproduces it exactly.
        if (e instanceof ContextTooHeavyError) throw e;
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
/**
 * Is the gateway answering at all?
 *
 * One deliberately trivial request — 1 token, no tools, no history — so the only thing it
 * can measure is reachability. Used ONLY after a turn has already failed, to tell "this
 * question was too slow" apart from "the box is down". Those two produced the identical
 * "ตอบช้าเกินไป … ลองพิมพ์มาใหม่" message, and the owner burned 12 minutes retrying into a
 * gateway that was returning 502 to a one-word prompt.
 *
 * Never throws; a failure to probe IS the answer. The short deadline is the point — a
 * healthy gateway answers this in ~1-2 s, so the diagnosis costs nothing worth measuring.
 */
export async function gatewayReachable(
  opts: { baseUrl: string; apiKey: string; model: string },
  timeoutMs = 20_000
): Promise<boolean> {
  try {
    const res = await fetch(opts.baseUrl.replace(/\/+$/, "") + "/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(opts.apiKey ? { Authorization: "Bearer " + opts.apiKey } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Any HTTP answer other than a server error means the gateway itself is alive — a 4xx
    // is a problem with the REQUEST, which is not what this is asking about.
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * `chatErrorMessage`, plus a reachability check when the failure looked like slowness.
 *
 * Only probes for the transient/timeout case: every other branch already names its own
 * cause, and re-probing them would just add latency to an answer we already have.
 */
export async function chatErrorMessageChecked(e: unknown, config: Config): Promise<string> {
  const base = chatErrorMessage(e);
  if (!isTransientNetworkError(e)) return base;

  const w = config.worker ?? {};
  const alive = await gatewayReachable({
    baseUrl: w.baseUrl ?? "",
    apiKey: process.env[w.apiKeyEnv ?? "EXECUTIVE_WORKER_KEY"] ?? "",
    model: w.model ?? "qwen3.6-35b-a3b",
  });
  if (alive) return base;
  return (
    "gateway ไม่ตอบเลยครับ — เช็คแล้วแม้แต่คำขอเล็กสุดก็ไม่ผ่าน " +
    "(เครื่อง inference ของ Arm น่าจะดับอยู่) ตอนนี้ลองใหม่ก็ไม่ช่วย รอให้มันกลับมาก่อนนะครับ"
  );
}

export function chatErrorMessage(e: unknown): string {
  const err = e as { name?: string; message?: string };
  const msg = String(err?.message ?? "");
  // Not "the gateway is slow" and not a crash: the model thought until it ran out of room,
  // and the loop already retried with less and less context. Say what actually helps.
  if (e instanceof ContextTooHeavyError || err?.name === "ContextTooHeavyError") {
    return (
      "โมเดลคิดจนหมดโควตาโดยไม่ตอบ (ลองลดประวัติแชทให้แล้วก็ยังไม่ผ่าน) — " +
      "ลองถามให้สั้น/เจาะจงกว่านี้ หรือกดล้างแชทแล้วเริ่มใหม่ครับ"
    );
  }
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

/**
 * The gateway kills any single request at ~125 s — Cloudflare, in front of the origin.
 * Measured 7×: 125.0 / 125.1 / 125.7 / 126.4 / 127.0 / 128.2 s, on both a plain POST and
 * an SSE one.
 *
 * **Streaming does not escape it.** With `stream: true` exactly two SSE chunks arrive
 * (`message_start`, `content_block_start`) and then the socket is silent for the whole
 * think — the gateway does not emit the model's thinking tokens — so the proxy sees an
 * idle connection and cuts it just the same.
 */
export const GATEWAY_WALL_MS = 125_000;

/**
 * The output ceiling that can physically come back before the wall.
 *
 * Measured throughput on the owner's real transcript (21,058 input tokens, 15 tool
 * schemas) is **33–48 tok/s on long generations** — slower the longer it runs:
 *   • 3072 → returned 6/6, in 47–72 s.
 *   • 4096 → returned 5/6, in 85–124 s; the 6th hit the wall (524).
 *   • 8192 → never returned. 8192 tokens needs ~170–250 s at that rate.
 * So a ceiling above ~4 k is not "expensive", it is **unreachable**: the response cannot
 * exist before the proxy hangs up. 3072 is the largest ceiling measured to come back
 * every time, and it still covers every successful answer we have observed (the longest
 * was 1,343 output tokens; 2,775 is the historical high-water mark).
 *
 * This is a hard clamp, not a default — `config.worker.maxTokens` may lower it, never
 * raise it past what the wire can deliver.
 */
export const WALL_SAFE_MAX_TOKENS = 3072;

/**
 * Abort before the gateway does, so a stall is classified by us instead of arriving as a
 * Cloudflare HTML error page.
 */
export const WALL_SAFE_TIMEOUT_MS = 115_000;

/** The output ceiling actually used: the configured base, clamped to what can return. */
export function effectiveMaxTokens(base: number): number {
  return Math.min(base, WALL_SAFE_MAX_TOKENS);
}

/** The request deadline actually used: the configured one, clamped below the wall. */
export function effectiveTimeoutMs(configured: number): number {
  return Math.min(configured, WALL_SAFE_TIMEOUT_MS);
}

/**
 * The model spent its whole ceiling thinking and produced nothing usable.
 *
 * Raising the ceiling cannot fix this — see WALL_SAFE_MAX_TOKENS, there is no headroom
 * left to buy — and **re-rolling the same context does not fix it either**: measured on
 * the transcript that triggered this, the spiral is near-deterministic per context
 * (0/7 at the full transcript, 0/3 at 40 items, 0/3 at 20 items) while a short context
 * answers every time (3/3 at 4 items, 4/4 with history dropped). So the only lever that
 * moves is the CONTEXT, and the loop is what owns it — hence a distinct error type it
 * can catch and retry smaller.
 */
export class ContextTooHeavyError extends Error {
  readonly budget: number | null;
  constructor(budget: number | null = null) {
    super(
      "agent: the model spent its entire thinking budget" +
        (budget ? ` (${budget} tokens)` : "") +
        " without answering (stop_reason: max_tokens)"
    );
    this.name = "ContextTooHeavyError";
    this.budget = budget;
  }
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
