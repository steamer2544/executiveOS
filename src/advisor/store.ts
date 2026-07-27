// Advisor queue persistence (.executive/advisor.json).
// Deterministic, local. Append-with-dedup for drafts; status update on decide.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { renameOverwrite } from "../fs-atomic.js";
import { randomUUID } from "node:crypto";
import { execRoot, advisorPath } from "../paths.js";
import type { AdvisorStore, Proposal, ProposalDraft, ProposalStatus } from "./types.js";
import { sanitizeExecutable } from "./advisor.js";

/** Read the queue defensively (missing/corrupt → empty). Never throws. */
export function readStore(): AdvisorStore {
  try {
    const raw = readFileSync(advisorPath(), "utf-8");
    const parsed = JSON.parse(raw) as AdvisorStore;
    if (parsed && Array.isArray(parsed.items)) return parsed;
  } catch {
    // fall through
  }
  return { items: [] };
}

/** Atomically write the queue. */
export function writeStore(store: AdvisorStore): void {
  const root = execRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const tmp = advisorPath() + "." + randomUUID();
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  renameOverwrite(tmp, advisorPath());
}

// ── Intent dedup (Phase 32) ──────────────────────────────────────────────────
// Title dedup alone lets the same idea queue up in four costumes:
//   "Take a 10-minute screen break" / "Stretch neck and shoulders" /
//   "Quick desk stretch and water" / "Step away for a 5-minute walk"
// The owner then triages four cards that are one decision. These helpers are pure.

const STOP = new Set([
  "a", "an", "the", "for", "to", "and", "or", "of", "in", "on", "at", "from", "with",
  "your", "you", "my", "me", "is", "it", "this", "that", "up", "out", "off", "then",
  "take", "do", "get", "make", "quick", "short", "some", "min", "mins", "minute", "minutes",
]);

/** Lowercased content words: punctuation, digits and stopwords removed. */
export function contentTokens(text: string): Set<string> {
  const words = (text.toLowerCase().match(/[\p{L}]+/gu) ?? []).filter((w) => !STOP.has(w));
  return new Set(words);
}

/** Overlap of two token sets: |A∩B| / |A∪B|. 0 when either is empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Coarse bucket for proposals that are interchangeable in practice, where wording
 * overlap is near zero but the decision is identical. Currently only self-care
 * ("rest") — the one the live queue actually duplicated. null = no bucket.
 */
export function intentBucket(text: string): string | null {
  const t = text.toLowerCase();
  if (/\b(break|stretch|walk|breathe|breathing|rest|water|hydrate|nap|pause|eyes|screen-free)\b/.test(t)) {
    return "rest";
  }
  return null;
}

/** Word-overlap above this fraction means the same intent. */
const INTENT_SIMILARITY = 0.6;
/**
 * Word overlap is only evidence when there are words to overlap: two titles that reduce
 * to a single content word each ("Fix login" vs "Fix build" → {fix}) would otherwise
 * score 1.0 and swallow unrelated proposals. Such titles fall back to exact-title dedup.
 */
const MIN_TOKENS_FOR_SIMILARITY = 2;

/**
 * True when `title` says the same thing as one of `openTitles`.
 * Compared against OPEN (pending) items only — so a self-care nudge can legitimately
 * return tomorrow once today's has been decided.
 */
export function isRepeatIntent(title: string, openTitles: string[]): boolean {
  const bucket = intentBucket(title);
  const tokens = contentTokens(title);
  for (const other of openTitles) {
    if (bucket !== null && intentBucket(other) === bucket) return true;
    const otherTokens = contentTokens(other);
    if (tokens.size < MIN_TOKENS_FOR_SIMILARITY || otherTokens.size < MIN_TOKENS_FOR_SIMILARITY) continue;
    if (jaccard(tokens, otherTokens) >= INTENT_SIMILARITY) return true;
  }
  return false;
}

/** The titles of currently-pending proposals (so the Advisor can avoid repeats). */
export function pendingTitles(store: AdvisorStore): string[] {
  return store.items.filter((i) => i.status === "pending").map((i) => i.title);
}

/**
 * Add drafts as pending proposals. Skips any whose title matches an existing
 * NON-rejected item (dedup), and caps the number of pending items at `maxOpen`
 * (oldest-pending are kept; excess new drafts are dropped). Returns the added items.
 * Applies `sanitizeExecutable` to enforce the code filter on every draft.
 */
export function addDrafts(
  store: AdvisorStore,
  drafts: ProposalDraft[],
  backend: string,
  maxOpen: number,
  now: string = new Date().toISOString()
): Proposal[] {
  // Title dedup deliberately does NOT count rejected or expired items: a decision the
  // owner declined, or a suggestion that aged out untriaged, must be allowed to come back
  // when it becomes relevant again. Without the `expired` exemption, retiring a proposal
  // would silently blacklist its title forever — the opposite of unblocking the queue.
  const seen = new Set(
    store.items
      .filter((i) => i.status !== "rejected" && i.status !== "expired")
      .map((i) => i.title.toLowerCase())
  );
  // Intent dedup is scoped to the open queue (see isRepeatIntent) and grows as we add.
  const openTitles = store.items.filter((i) => i.status === "pending").map((i) => i.title);
  let pendingCount = store.items.filter((i) => i.status === "pending").length;
  const added: Proposal[] = [];
  for (const d of drafts) {
    const key = (d.title ?? "").toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    if (isRepeatIntent(d.title, openTitles)) continue;
    if (pendingCount >= maxOpen) break;
    // Apply the code filter — runs on every draft regardless of backend.
    const sanitized = sanitizeExecutable(d);
    const p: Proposal = {
      id: randomUUID(),
      createdAt: now,
      category: d.category || "general",
      title: d.title,
      detail: d.detail || "",
      action: d.action || "",
      evidence: d.evidence || undefined,
      status: "pending",
      backend,
      executable: sanitized.executable,
      repo: sanitized.executable ? sanitized.repo : undefined,
      files: sanitized.executable ? sanitized.files : undefined,
    };
    store.items.push(p);
    added.push(p);
    seen.add(key);
    openTitles.push(d.title);
    pendingCount++;
  }
  return added;
}

/** Decide a proposal. Returns the updated Proposal, or null if the id isn't found. */
export function decide(
  store: AdvisorStore,
  id: string,
  decision: "approve" | "reject",
  edits?: { action?: string; note?: string },
  now: string = new Date().toISOString()
): Proposal | null {
  const p = store.items.find((i) => i.id === id);
  if (!p) return null;
  p.status = decision === "approve" ? "approved" : "rejected";
  p.decidedAt = now;
  if (edits?.action !== undefined && edits.action.trim() !== "") p.action = edits.action;
  if (edits?.note !== undefined && edits.note.trim() !== "") p.note = edits.note;
  return p;
}

/** Pending proposals, newest first. */
export function pending(store: AdvisorStore): Proposal[] {
  return store.items.filter((i) => i.status === "pending").slice().reverse();
}

/** How many proposals are awaiting the owner. Compared against `advisor.maxOpen`. */
export function pendingCount(store: AdvisorStore): number {
  return store.items.reduce((n, i) => (i.status === "pending" ? n + 1 : n), 0);
}

// ── Expiry (Phase 46) ────────────────────────────────────────────────────────
// The queue had no way out but a human click, so it saturated at `maxOpen` and STAYED
// there: measured on the live runtime, 8 pending for 3.5 days, every one of them a
// pre-Phase-33 generic suggestion, while `addDrafts` broke on the first draft of every
// run. Bad old proposals were permanently blocking good grounded ones.
//
// This follows the Phase 39 rule exactly: decay only ever REMOVES a stale assertion the
// owner never acted on, never invents or changes one, and an unparseable `createdAt` is
// left alone (uncertain → keep). A proposal is a suggestion about *now* — "take a break",
// "commit before this gets too big" — so unlike a deadline it does not survive being
// ignored, which is why this is on by default rather than an opt-in toggle.

/** Default age at which an untriaged proposal is retired. Config may override. */
export const PROPOSAL_TTL_DAYS = 3;

/**
 * Retire pending proposals older than `ttlDays`. Pure apart from mutating `store`;
 * returns the retired items. `ttlDays <= 0` (or non-finite) disables expiry entirely.
 */
export function expireStale(
  store: AdvisorStore,
  ttlDays: number = PROPOSAL_TTL_DAYS,
  now: Date = new Date()
): Proposal[] {
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) return [];
  const cutoff = now.getTime() - ttlDays * 24 * 60 * 60 * 1000;
  const retired: Proposal[] = [];
  for (const p of store.items) {
    if (p.status !== "pending") continue;
    const created = Date.parse(p.createdAt);
    if (!Number.isFinite(created)) continue;   // uncertain → keep
    if (created >= cutoff) continue;
    p.status = "expired";
    p.decidedAt = now.toISOString();
    retired.push(p);
  }
  return retired;
}

export type { ProposalStatus };
