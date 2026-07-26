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
  PendingChoice,
  ToolContext,
} from "./types.js";
import type { Config } from "../config.js";

import {
  ALL_TOOLS,
  agentRoots,
  findTool,
  previewWrite,
  describeSaveTarget,
  saveFileOnBranch,
} from "./tools.js";
import {
  createChatBackend,
  isToolsUnsupported,
  AnthropicChatBackend,
  ContextTooHeavyError,
} from "./protocol.js";
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
  trimTranscript,
} from "./session.js";
import {
  llmMaxTokens,
  llmTimeoutMs,
  trustTool,
  loadConfig,
  addFileOutputDir,
  NEVER_TRUSTABLE,
} from "../config.js";

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

/**
 * Which situation-specific buttons this write deserves.
 *
 * Kept next to the pending it decorates rather than inside the tool, because it is a
 * question about the CONFIRM UI, not about the write: the tool itself only ever runs
 * against an already-approved folder.
 */
function extraChoicesFor(
  name: string,
  args: Record<string, unknown>,
  config: Config
): PendingChoice[] {
  if (name !== "save_file") return [];
  const t = describeSaveTarget(args, config);
  if (!t.path || !t.dir) return [];
  const out: PendingChoice[] = [];
  if (!t.approved) out.push("allow_dir");
  if (t.repoRoot) out.push("branch");
  return out;
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
async function stepOnce(
  backendRef: { current: ChatBackend },
  config: Config,
  tools: AgentTool[],
  transcript: ReturnType<typeof buildTranscript>
) {
  const input = { system: buildAgentSystemPrompt(), transcript, tools };
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

/**
 * How much history to keep, per attempt: the configured window first, then progressively
 * less. This is the inverse of the ceiling ladder it replaced — measurement says the
 * ceiling cannot be raised (the gateway's ~125 s wall caps what can come back) while
 * shrinking the context is what actually rescues a spiralling turn (full history 0/7,
 * last few turns 3/3, last turn only 4/4).
 */
export const CONTEXT_LADDER: ReadonlyArray<number | null> = [null, 3, 1];

/**
 * Ask the model for one step, shrinking the context if it burns its whole budget thinking.
 *
 * `degraded` records the smallest window a step had to fall back to, so the turn can tell
 * the owner it answered without the earlier history rather than silently forgetting it.
 */
async function step(
  backendRef: { current: ChatBackend },
  config: Config,
  tools: AgentTool[],
  degraded: { turns: number | null }
) {
  const configured = config.agent?.historyTurns ?? DEFAULT_HISTORY_TURNS;
  const full = buildTranscript(readConversation(), configured);

  let lastErr: unknown;
  let lastWidth = -1;
  for (const rung of CONTEXT_LADDER) {
    const transcript = rung === null ? full : trimTranscript(full, rung);
    // Skip a rung that would re-send an identical request — a short conversation makes the
    // upper rungs no smaller than the full window. SKIP, never stop: the rungs below are
    // still smaller, and stopping here was a real bug (a 2-turn chat that spiralled failed
    // outright because the single-turn rescue was never reached).
    if (lastErr && transcript.length === lastWidth) continue;
    lastWidth = transcript.length;
    try {
      const out = await stepOnce(backendRef, config, tools, transcript);
      if (rung !== null) degraded.turns = rung;
      return out;
    } catch (e) {
      lastErr = e;
      if (!(e instanceof ContextTooHeavyError)) throw e;
    }
  }
  throw lastErr ?? new Error("agent: request failed");
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
    } else if (decision === "allow_dir") {
      // Approve the DESTINATION FOLDER, not the tool: the next save into it needs no
      // question, while every save still shows its full path and every other folder is
      // still asked about once. Persisted, so it survives a restart and shows up in the
      // dashboard's File output list where the owner can take it back.
      const t = describeSaveTarget(pending.args, config);
      if (t.dir) {
        addFileOutputDir(t.dir);
        config = loadConfig();
      }
    } else if (decision === "branch") {
      // Same bytes, isolated branch. Runs the executor path directly rather than the tool,
      // and records it under the tool's name so the transcript reads as one action.
      const r = await saveFileOnBranch(pending.args, ctxFor(config));
      appendMessage({
        role: "tool", text: r.content, toolName: pending.toolName,
        toolArgs: pending.args, toolOk: r.ok,
      });
      return driveLoop({ ...opts, config }, [
        { name: pending.toolName, ok: r.ok, args: pending.args },
      ]);
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
  const degraded: { turns: number | null } = { turns: null };

  for (let round = 0; round < maxRounds; round++) {
    const s = await step(backendRef, config, tools, degraded);

    if (s.toolCalls.length === 0) {
      const reply = withDegradedNote(s.text.trim() || "(ไม่มีคำตอบ)", degraded.turns);
      appendMessage({ role: "assistant", text: reply });
      return { reply, toolCalls, pending: null, cappedOut: false, degradedTurns: degraded.turns };
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
          extraChoices: extraChoicesFor(tool.name, call.args, config),
        };
        writePending(pending);
        if (s.text.trim()) appendMessage({ role: "assistant", text: s.text.trim() });
        return {
          reply: s.text.trim(),
          toolCalls,
          pending,
          cappedOut: false,
          degradedTurns: degraded.turns,
        };
      }

      const r = await runTool(tool, call.args, config);
      toolCalls.push({ name: tool.name, ok: r.ok, args: call.args });
    }
  }

  // Budget spent. Ask once more with no tools available, so the model has to answer.
  let reply = "";
  try {
    const final = await step(backendRef, config, [], degraded);
    reply = final.text.trim();
  } catch {
    reply = "";
  }
  reply = reply ? withDegradedNote(reply, degraded.turns) : CAPPED_FALLBACK;
  appendMessage({ role: "assistant", text: reply });
  return { reply, toolCalls, pending: null, cappedOut: true, degradedTurns: degraded.turns };
}

/**
 * Say so when a turn only got through by dropping history. Silently forgetting the
 * conversation would read as the agent being erratic; naming it lets the owner decide
 * whether to re-state context or clear the chat.
 */
function withDegradedNote(reply: string, turns: number | null): string {
  if (turns === null) return reply;
  return (
    reply +
    `\n\n_(ประวัติแชทยาวเกินไป ผมตอบรอบนี้โดยใช้แค่ ${turns} ข้อความล่าสุดครับ — ` +
    "ถ้าอยากเริ่มใหม่ให้สะอาด กดล้างแชทได้)_"
  );
}

function findToolIn(tools: AgentTool[], name: string): AgentTool | undefined {
  return tools.find((t) => t.name === name) ?? (tools === ALL_TOOLS ? findTool(name) : undefined);
}
