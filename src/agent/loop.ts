// The agentic loop (Phase 35).
//
// call the model → it asks for tools → run them → feed results back → repeat until it
// answers. A write tool stops the loop and waits for the owner's tap; `resumeTurn`
// picks it up from there.
//
// The loop owns three guarantees:
//   1. it always terminates (maxToolRounds, then a forced answer),
//   2. a write tool never runs without confirmation or standing trust,
//   3. every step is appended to conversation.jsonl before the next one starts,
//      so a crash mid-turn leaves an inspectable trail rather than a black box.

import type {
  AgentTool,
  AgentTurn,
  ChatBackend,
  ConfirmDecision,
  PendingWrite,
  ToolContext,
} from "./types.js";
import type { Config } from "../config.js";

import { ALL_TOOLS, agentRoots, findTool, previewWrite } from "./tools.js";
import { createChatBackend, isToolsUnsupported, AnthropicChatBackend } from "./protocol.js";
import {
  appendMessage,
  buildAgentSystemPrompt,
  buildTranscript,
  clearPending,
  readConversation,
  readPending,
  writePending,
  readSessionTrust,
  addSessionTrust,
} from "./session.js";
import { llmMaxTokens, llmTimeoutMs, trustTool, NEVER_TRUSTABLE } from "../config.js";

const DEFAULT_MAX_ROUNDS = 8;
const DEFAULT_HISTORY_TURNS = 20;

/** The answer used when the model burns its tool budget without ever concluding. */
const CAPPED_FALLBACK =
  "ผมหาข้อมูลหลายรอบแล้วแต่ยังสรุปไม่ได้ — ลองถามให้เจาะจงกว่านี้อีกนิดครับ";

export interface TurnOptions {
  config: Config;
  /** Injected in tests; production builds one from config. */
  backend?: ChatBackend;
  /** Injected in tests so a tool can be faked without touching the real runtime. */
  tools?: AgentTool[];
}

function toolsFor(opts: TurnOptions): AgentTool[] {
  return opts.tools ?? ALL_TOOLS;
}

function ctxFor(config: Config): ToolContext {
  return { config, roots: agentRoots(config) };
}

function isTrusted(name: string, config: Config): boolean {
  // Session trust (this conversation only) covers ANY tool, including the never-persistently-
  // trustable ones — it is bounded and resets on clear, and the run_command denylist still
  // hard-refuses a destructive command even here (command-guard, checked inside run_command).
  if (readSessionTrust().includes(name)) return true;
  // Persistent trust: run_command / edit_files can never be trusted via config (Phase 38).
  if (NEVER_TRUSTABLE.has(name)) return false;
  return (config.agent?.trustedTools ?? []).includes(name);
}

/**
 * Run one tool and record it. Never throws — a tool that blows up must come back as a
 * failed result the model can react to, not as an exception that kills the turn.
 */
async function runTool(
  tool: AgentTool,
  args: Record<string, unknown>,
  config: Config
): Promise<{ ok: boolean; content: string }> {
  let result: { ok: boolean; content: string };
  try {
    const r = await tool.run(args, ctxFor(config));
    result = { ok: r.ok, content: r.content };
  } catch (e) {
    result = { ok: false, content: `tool ${tool.name} threw: ${(e as Error).message}` };
  }
  appendMessage({
    role: "tool",
    text: result.content,
    toolName: tool.name,
    toolArgs: args,
    toolOk: result.ok,
  });
  return result;
}

/**
 * Ask the model for one step, downgrading `native` → `json` if the gateway rejects the
 * `tools` field. Whether the 9arm gateway supports native tool calling is unmeasured
 * (every probe hit a 524 outage), so the downgrade is a real path, not a formality.
 */
async function step(
  backendRef: { current: ChatBackend },
  config: Config,
  tools: AgentTool[]
) {
  const input = {
    system: buildAgentSystemPrompt(),
    transcript: buildTranscript(
      readConversation(),
      config.agent?.historyTurns ?? DEFAULT_HISTORY_TURNS
    ),
    tools,
  };
  try {
    return await backendRef.current.step(input);
  } catch (e) {
    const auto = (config.agent?.toolProtocol ?? "auto") === "auto";
    if (auto && backendRef.current.protocol === "native" && isToolsUnsupported(e)) {
      const w = config.worker ?? {};
      backendRef.current = new AnthropicChatBackend({
        baseUrl: w.baseUrl ?? "",
        model: w.model ?? "qwen3.6-35b-a3b",
        apiKey: process.env[w.apiKeyEnv ?? "EXECUTIVE_WORKER_KEY"] ?? "",
        maxTokens: llmMaxTokens(config, 8192),
        timeoutMs: llmTimeoutMs(config),
        protocol: "json",
      });
      return await backendRef.current.step(input);
    }
    throw e;
  }
}

// ─── Turn ─────────────────────────────────────────────────────────────────────

/** Start a turn from the owner's message. */
export async function runTurn(
  message: string,
  opts: TurnOptions & { via?: "text" | "voice" }
): Promise<AgentTurn> {
  appendMessage({ role: "user", text: message, via: opts.via ?? "text" });
  return driveLoop(opts, []);
}

/**
 * Resume a turn the owner just decided on.
 * "run" runs it once; "trust" also adds the tool to config.agent.trustedTools so the
 * owner is never asked about it again; "no" tells the model it was declined and lets
 * it respond instead of leaving the conversation hanging.
 */
export async function resumeTurn(
  pendingId: string,
  decision: ConfirmDecision,
  opts: TurnOptions
): Promise<AgentTurn> {
  const pending = readPending();
  if (!pending || pending.id !== pendingId) {
    return { reply: "ข้อเสนอนี้หมดอายุแล้วครับ", toolCalls: [], pending: null, cappedOut: false };
  }
  clearPending();

  let config = opts.config;
  const done: AgentTurn["toolCalls"] = [];

  if (decision === "no") {
    appendMessage({
      role: "tool",
      text: "The owner declined this action. Do not retry it; acknowledge and stop.",
      toolName: pending.toolName,
      toolArgs: pending.args,
      toolOk: false,
    });
    done.push({ name: pending.toolName, ok: false, args: pending.args });
  } else {
    if (decision === "trust") {
      config = trustTool(pending.toolName);
    } else if (decision === "trust_session") {
      // Trust this tool for the rest of the conversation only (resets on clear). Covers the
      // never-persistently-trustable tools; the denylist still guards run_command.
      addSessionTrust(pending.toolName);
    }
    const tool = toolsFor(opts).find((t) => t.name === pending.toolName);
    if (!tool) {
      return {
        reply: `ไม่รู้จัก tool "${pending.toolName}" แล้วครับ`,
        toolCalls: [],
        pending: null,
        cappedOut: false,
      };
    }
    const r = await runTool(tool, pending.args, config);
    done.push({ name: tool.name, ok: r.ok, args: pending.args });
  }

  return driveLoop({ ...opts, config }, done);
}

/** The loop proper. `already` carries tool calls made before it was entered. */
async function driveLoop(opts: TurnOptions, already: AgentTurn["toolCalls"]): Promise<AgentTurn> {
  const config = opts.config;
  const tools = toolsFor(opts);
  const maxRounds = config.agent?.maxToolRounds ?? DEFAULT_MAX_ROUNDS;
  const backendRef = { current: opts.backend ?? createChatBackend(config) };
  const toolCalls: AgentTurn["toolCalls"] = [...already];

  for (let round = 0; round < maxRounds; round++) {
    const s = await step(backendRef, config, tools);

    if (s.toolCalls.length === 0) {
      const reply = s.text.trim() || "(ไม่มีคำตอบ)";
      appendMessage({ role: "assistant", text: reply });
      return { reply, toolCalls, pending: null, cappedOut: false };
    }

    for (const call of s.toolCalls) {
      const tool = findToolIn(tools, call.name);
      if (!tool) {
        appendMessage({
          role: "tool",
          text: `no such tool: ${call.name}`,
          toolName: call.name,
          toolArgs: call.args,
          toolOk: false,
        });
        toolCalls.push({ name: call.name, ok: false, args: call.args });
        continue;
      }

      // The confirmation gate. A write tool runs only with standing trust; otherwise
      // the loop parks and hands control back to the owner.
      if (tool.kind === "write" && !isTrusted(tool.name, config)) {
        const pending: PendingWrite = {
          id: crypto.randomUUID(),
          ts: new Date().toISOString(),
          toolName: tool.name,
          args: call.args,
          preview: previewWrite(tool.name, call.args, config),
          trustable: !NEVER_TRUSTABLE.has(tool.name),
        };
        writePending(pending);
        if (s.text.trim()) appendMessage({ role: "assistant", text: s.text.trim() });
        return { reply: s.text.trim(), toolCalls, pending, cappedOut: false };
      }

      const r = await runTool(tool, call.args, config);
      toolCalls.push({ name: tool.name, ok: r.ok, args: call.args });
    }
  }

  // Budget spent. Ask once more with no tools available, so the model has to answer.
  let reply = "";
  try {
    const final = await step(backendRef, config, []);
    reply = final.text.trim();
  } catch {
    reply = "";
  }
  if (!reply) reply = CAPPED_FALLBACK;
  appendMessage({ role: "assistant", text: reply });
  return { reply, toolCalls, pending: null, cappedOut: true };
}

function findToolIn(tools: AgentTool[], name: string): AgentTool | undefined {
  return tools.find((t) => t.name === name) ?? (tools === ALL_TOOLS ? findTool(name) : undefined);
}
