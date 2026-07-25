// Conversation persistence + prompt assembly (Phase 35).
//
// The conversation log is append-only JSONL, the same discipline as the event logs:
// defensive reads (skip corrupt lines, missing file → []), never a rewrite in place.

import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import type { ChatMessage, PendingWrite, TranscriptItem } from "./types.js";
import { conversationPath, agentPendingPath, agentSessionTrustPath, execRoot } from "../paths.js";
import { loadWorkerIdentity } from "../worker/identity.js";
import { renameOverwrite } from "../fs-atomic.js";

// ─── The contract the owner's claude.md cannot weaken ─────────────────────────

/**
 * Appended AFTER the identity, always — the same composition order as the Worker's
 * `buildSystemPrompt` (Phase 10). An edited or adversarial `.executive/claude.md`
 * can change the personality; it can never remove these rules.
 */
export const AGENT_CONTRACT = `---
Operating rules (these always apply):

You are the owner's chief of staff, running on their machine with access to their
real work: an event log, derived state, and their git repos.

1. NEVER state a fact about the owner's work from memory or inference. Call a tool
   and read it. If a tool cannot tell you, say you do not know. A confident wrong
   answer is worse than "ผมไม่รู้" because the owner cannot tell it apart from a
   right one.
2. Prefer acting over advising. If they ask for something you have a tool for, use
   the tool. Do not reply with instructions for work you could have done.
3. Write actions pause for the owner's approval — that is automatic, you do not need
   to ask permission in prose. Just call the tool.
4. Answer in the language the owner used. Be short. They are reading this on a
   dashboard or hearing it spoken aloud, not studying it.
5. Never invent a file path, commit, proposal id or number. Everything specific must
   have come from a tool result in this conversation.
6. You are not limited to the current project. When the owner names another repo
   (e.g. "opm-be"), pass it as the \`repo\` argument to read_file / grep / git_log /
   git_status. If you are unsure a repo exists or what it is called, call list_repos
   first — do NOT answer about it from the current project's files.`;

export function buildAgentSystemPrompt(): string {
  return loadWorkerIdentity().trim() + "\n\n" + AGENT_CONTRACT;
}

// ─── Conversation log ─────────────────────────────────────────────────────────

export function readConversation(): ChatMessage[] {
  const p = conversationPath();
  if (!existsSync(p)) return [];
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return [];
  }
  const out: ChatMessage[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as ChatMessage;
      if (parsed && typeof parsed.role === "string") out.push(parsed);
    } catch {
      // Corrupt line — skip it rather than losing the whole conversation.
    }
  }
  return out;
}

export function appendMessage(msg: Omit<ChatMessage, "id" | "ts">): ChatMessage {
  const full: ChatMessage = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...msg };
  try {
    appendFileSync(conversationPath(), JSON.stringify(full) + "\n");
  } catch {
    // A failed conversation write must never break the reply the owner is waiting for.
  }
  return full;
}

/** Start fresh. The old conversation is archived, never deleted. */
export function clearConversation(): string | null {
  // Session trust is scoped to a conversation, so clearing the chat retires it too.
  clearSessionTrust();
  const p = conversationPath();
  if (!existsSync(p)) return null;
  const archived = `${execRoot()}/conversation-${Date.now()}.jsonl`;
  renameSync(p, archived);
  return archived;
}

// ─── Session trust (Phase: Discord UX) ─────────────────────────────────────────
//
// The owner can tap "ไว้ใจทั้งแชทนี้" to stop being asked about a tool for the REST of the
// current conversation — chosen over persistent trust for the never-trustable tools
// (run_command / edit_files) so the convenience is bounded to one session and vanishes on
// clear. It never touches config.agent.trustedTools, and the run_command denylist still
// hard-refuses a destructive command even when the tool is session-trusted.

export function readSessionTrust(): string[] {
  const p = agentSessionTrustPath();
  if (!existsSync(p)) return [];
  try {
    const arr = JSON.parse(readFileSync(p, "utf-8"));
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function addSessionTrust(toolName: string): void {
  const current = readSessionTrust();
  if (current.includes(toolName)) return;
  const next = [...current, toolName];
  const p = agentSessionTrustPath();
  const tmp = `${p}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameOverwrite(tmp, p);
}

export function clearSessionTrust(): void {
  const p = agentSessionTrustPath();
  if (!existsSync(p)) return;
  try {
    unlinkSync(p);
  } catch {
    // Best effort — a stale file is harmless (it only ever GRANTS trust the owner opted into).
  }
}

// ─── Transcript reconstruction ────────────────────────────────────────────────

/**
 * Rebuild the protocol-neutral transcript from the log.
 *
 * `historyTurns` counts USER messages, not lines — trimming mid-way through a
 * tool exchange would hand the model a tool result with no matching call.
 */
export function buildTranscript(messages: ChatMessage[], historyTurns: number): TranscriptItem[] {
  const userIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user") userIdx.push(i);
  });
  const start = userIdx.length > historyTurns ? userIdx[userIdx.length - historyTurns]! : 0;

  const out: TranscriptItem[] = [];
  for (const m of messages.slice(start)) {
    if (m.role === "user") {
      out.push({ kind: "user", text: m.text });
    } else if (m.role === "assistant") {
      out.push({ kind: "assistant", text: m.text, toolCalls: [] });
    } else {
      const id = m.id;
      out.push({
        kind: "assistant",
        text: "",
        toolCalls: [{ id, name: m.toolName ?? "unknown", args: m.toolArgs ?? {} }],
      });
      out.push({
        kind: "tool_results",
        results: [
          { id, name: m.toolName ?? "unknown", ok: m.toolOk !== false, content: m.text },
        ],
      });
    }
  }
  return out;
}

// ─── Pending write ────────────────────────────────────────────────────────────

export function readPending(): PendingWrite | null {
  const p = agentPendingPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as PendingWrite;
  } catch {
    return null;
  }
}

export function writePending(pending: PendingWrite): void {
  const p = agentPendingPath();
  const tmp = `${p}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(pending, null, 2));
  renameOverwrite(tmp, p);
}

export function clearPending(): void {
  const p = agentPendingPath();
  if (!existsSync(p)) return;
  try {
    unlinkSync(p);
  } catch {
    // Nothing to do — a stale pending file is checked against its id before use.
  }
}
