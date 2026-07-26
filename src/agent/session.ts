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
   have come from a tool result in this conversation. When a tool tells you WHERE
   something ended up, repeat that location exactly as given — do not "simplify" it
   into a friendlier-sounding path. Saying a file is in the project folder when the
   tool said it was committed to a branch sends the owner hunting for a file that is
   not there.
6. You are not limited to the current project. When the owner names another repo
   (e.g. "opm-be"), pass it as the \`repo\` argument to read_file / grep / git_log /
   git_status. If you are unsure a repo exists or what it is called, call list_repos
   first — do NOT answer about it from the current project's files.
7. If you cannot do exactly what was asked, say which part you could not do and what
   you did instead. Never present a near-miss as the thing they asked for. "ผมเขียน
   ไฟล์ตรงนั้นไม่ได้ ขอ commit ไว้ที่ … แทน" is a good answer; silently delivering
   something elsewhere and calling it done is not.`;

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

// ─── Chat commands (handled WITHOUT the LLM) ──────────────────────────────────

/** Trailing politeness/softeners that change nothing about the request. */
const TRAILING = /(ครับ|คร้าบ|ค่ะ|คะ|นะ|น่ะ|ก่อน|หน่อย|ด้วย|ที|เลย|please|pls)+$/;

const CLEAR_PHRASES = new Set([
  "clear", "clearchat", "clearhistory", "reset", "resetchat", "newchat",
  "ล้างแชท", "ล้างchat", "ล้างประวัติ", "ล้างแชต", "ล้าง",
  "เคลียร์แชท", "เคลียร์", "ลบแชท", "ลบประวัติ", "เริ่มใหม่",
]);

export type ChatCommand = "clear" | null;

/**
 * Recognise a command the runtime can carry out itself.
 *
 * Two reasons this must not go through the model. It is the owner's escape hatch when a
 * conversation has gone bad — and the most likely reason it has gone bad is that the
 * gateway is unreachable, which is exactly when an LLM round-trip cannot answer. (Observed:
 * the owner typed "ล้างแชทก่อนครับ" and got a 4-minute timeout, because every Discord
 * message went straight to `runTurn` and the dashboard held the only clear button.)
 *
 * Matched on the WHOLE message, never a substring: "ล้างแชท" clears, "อย่าเพิ่งล้างแชท"
 * does not. A command that fires inside an ordinary sentence would be worse than no
 * command at all.
 */
export function matchChatCommand(text: string): ChatCommand {
  let t = (text ?? "").trim().toLowerCase();
  if (t.startsWith("/")) t = t.slice(1).trim();
  t = t.replace(/[\s​.!?。ๆฯ]+/g, "");
  // Strip softeners repeatedly: "ล้างแชทก่อนครับ" → "ล้างแชทก่อน" → "ล้างแชท".
  for (let i = 0; i < 4; i++) {
    const next = t.replace(TRAILING, "");
    if (next === t) break;
    t = next;
  }
  if (t === "") return null;
  return CLEAR_PHRASES.has(t) ? "clear" : null;
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

/**
 * Keep only the last `userTurns` user messages and everything after them.
 *
 * The recovery lever when the model spirals on a heavy context: measured on the
 * transcript that triggered it, the full 20-turn history answered 0/7 while the last
 * few turns answered 3/3 and a single turn 4/4.
 *
 * Cutting at a `kind: "user"` item can never orphan a `tool_results` from its
 * `tool_use` — `buildTranscript` always emits that pair adjacently, and the item we cut
 * at is a user message, so any surviving pair is wholly inside the slice.
 */
export function trimTranscript(items: TranscriptItem[], userTurns: number): TranscriptItem[] {
  if (userTurns <= 0) return [];
  const userIdx: number[] = [];
  items.forEach((it, i) => {
    if (it.kind === "user") userIdx.push(i);
  });
  if (userIdx.length <= userTurns) return items;
  return items.slice(userIdx[userIdx.length - userTurns]!);
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
