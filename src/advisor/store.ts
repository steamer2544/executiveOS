// Advisor queue persistence (.executive/advisor.json).
// Deterministic, local. Append-with-dedup for drafts; status update on decide.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execRoot, advisorPath } from "../paths.js";
import type { AdvisorStore, Proposal, ProposalDraft, ProposalStatus } from "./types.js";

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
  renameSync(tmp, advisorPath());
}

/** The titles of currently-pending proposals (so the Advisor can avoid repeats). */
export function pendingTitles(store: AdvisorStore): string[] {
  return store.items.filter((i) => i.status === "pending").map((i) => i.title);
}

/**
 * Add drafts as pending proposals. Skips any whose title matches an existing
 * NON-rejected item (dedup), and caps the number of pending items at `maxOpen`
 * (oldest-pending are kept; excess new drafts are dropped). Returns the added items.
 */
export function addDrafts(
  store: AdvisorStore,
  drafts: ProposalDraft[],
  backend: string,
  maxOpen: number,
  now: string = new Date().toISOString()
): Proposal[] {
  const seen = new Set(store.items.filter((i) => i.status !== "rejected").map((i) => i.title.toLowerCase()));
  let pendingCount = store.items.filter((i) => i.status === "pending").length;
  const added: Proposal[] = [];
  for (const d of drafts) {
    const key = (d.title ?? "").toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    if (pendingCount >= maxOpen) break;
    const p: Proposal = {
      id: randomUUID(),
      createdAt: now,
      category: d.category || "general",
      title: d.title,
      detail: d.detail || "",
      action: d.action || "",
      status: "pending",
      backend,
    };
    store.items.push(p);
    added.push(p);
    seen.add(key);
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

export type { ProposalStatus };
