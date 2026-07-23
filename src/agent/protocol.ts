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

    const body: Record<string, unknown> = {
      model: this.opts.model,
      max_tokens: this.opts.maxTokens,
      temperature: 0,
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      if (this.opts.apiKey) headers["Authorization"] = "Bearer " + this.opts.apiKey;

      const res = await fetch(this.opts.baseUrl + "/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`agent HTTP ${res.status}: ${text.slice(0, 400)}`);
      }
      const json = await res.json();
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
    } finally {
      clearTimeout(timer);
    }
  }
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
