// Types for the conversational Agent (Phase 35).
//
// The agent is the runtime's mouth and hands: the owner talks to it, it calls tools
// that read/act on the REAL runtime, and it answers. It holds no facts of its own —
// every claim about the owner's work must come from a tool call.

import type { Config } from "../config.js";

/**
 * read  — safe to run automatically, no confirmation, no mutation.
 * write — mutates something (files, git, the event log, the advisor queue).
 *         Requires the owner's confirmation unless the tool is in
 *         `config.agent.trustedTools`.
 */
export type ToolKind = "read" | "write";

/** What a tool hands back to the model. */
export interface ToolResult {
  ok: boolean;
  /**
   * What the model sees. Pre-formatted for a language model: durations spelled out
   * in words, timestamps localized, long output truncated. Never raw milliseconds —
   * the model reads `sessionMs: 2173707` as "36 hours" when it is 36 minutes
   * (measured, Phase 33.1), so raw numbers are a correctness bug, not a style choice.
   */
  content: string;
  /** Present when ok === false. Also surfaced to the model so it can adapt. */
  error?: string;
}

/** Everything a tool needs to run. Passed in rather than imported, so tests can isolate. */
export interface ToolContext {
  config: Config;
  /** Repo roots the agent is confined to. Anything outside is rejected. */
  roots: string[];
}

export interface AgentTool {
  name: string;
  /** Written for the model, not for us — it decides from this whether to call the tool. */
  description: string;
  kind: ToolKind;
  /** JSON Schema, Anthropic `input_schema` shape. Also rendered into the prompt for the json protocol. */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ─── Conversation ─────────────────────────────────────────────────────────────

export type ChatRole = "user" | "assistant" | "tool";

/** One line in .executive/conversation.jsonl. Append-only, like the event logs. */
export interface ChatMessage {
  id: string;
  ts: string; // ISO
  role: ChatRole;
  text: string;
  /** role: "tool" only */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolOk?: boolean;
  /** role: "user" only — how it was said. */
  via?: "text" | "voice";
}

// ─── Write confirmation ───────────────────────────────────────────────────────

/**
 * A write tool the model asked for but that has not been approved yet.
 * The loop parks it and stops; the owner taps once, then the loop resumes.
 */
export interface PendingWrite {
  id: string;
  ts: string;
  toolName: string;
  args: Record<string, unknown>;
  /** One line, in the owner's language, describing what will happen if approved. */
  preview: string;
  /** Phase 38: false for tools that may never be blanket-trusted (run_command / edit_files).
   *  Those get a **session**-trust button ("ไว้ใจทั้งแชทนี้") instead of the persistent
   *  "ไว้ใจตลอด"; trustable (absent/true) tools keep the persistent one. */
  trustable?: boolean;
}

/** "run" = do it once. "trust" = persist to config.agent.trustedTools (persistent, only for
 *  trustable tools). "trust_session" = trust for the current conversation only (used for the
 *  never-persistent-trustable tools; resets on clear). "no" = decline. */
export type ConfirmDecision = "run" | "trust" | "trust_session" | "no";

// ─── Turn result ──────────────────────────────────────────────────────────────

export interface AgentTurn {
  /** The assistant's text answer. Empty when the turn stopped on a pending write. */
  reply: string;
  /** Tool calls made during this turn, in order — the audit trail shown in the UI. */
  toolCalls: Array<{ name: string; ok: boolean; args: Record<string, unknown> }>;
  /** Set when the turn stopped waiting for the owner to confirm a write. */
  pending: PendingWrite | null;
  /** True when the turn ended because it hit maxToolRounds. */
  cappedOut: boolean;
}

// ─── Backend ──────────────────────────────────────────────────────────────────

/** What the model produced for one step: either text, or a request to call tools. */
export interface ModelStep {
  text: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  /** Raw stop reason, when the backend reports one — used to detect budget exhaustion. */
  stopReason?: string;
}

/**
 * The conversation as the LOOP sees it — protocol-neutral on purpose.
 *
 * The loop never speaks a wire format; each backend translates this transcript into
 * its own (Anthropic `tool_use`/`tool_result` blocks, or fenced JSON in prose). That
 * is what lets one loop and one test body cover both protocols.
 */
export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> }
  | { kind: "tool_results"; results: Array<{ id: string; name: string; ok: boolean; content: string }> };

/**
 * A chat backend. `mock` for tests, `anthropic` for the real gateway.
 * The protocol (native tool_use vs json-fence) is a property of the backend
 * implementation, not of the loop.
 */
export interface ChatBackend {
  name: string;
  /** Whether tool schemas are sent natively or rendered into the system prompt. */
  protocol: "native" | "json";
  step(input: {
    system: string;
    transcript: TranscriptItem[];
    tools: AgentTool[];
  }): Promise<ModelStep>;
}
