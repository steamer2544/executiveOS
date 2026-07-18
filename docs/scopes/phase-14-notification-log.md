# Scope — Phase 14: Notification log (durable "Needs you" history) (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.

---

## 0. What this phase is (and is NOT)

Phase 12 made the `watch` daemon print a **"Needs you"** alert when the owner's decision queue changes.
But that alert is **ephemeral stdout** — if the owner is not watching the terminal at that moment, it
scrolls away and is **lost forever**. That fights the product's purpose (the owner should not have to
babysit a terminal to learn a decision is waiting).

**Phase 14 adds a durable notification log.** When the daemon detects that a "Needs you" item **appears**
(or is **resolved**), it appends a timestamped record to **`.executive/notifications.jsonl`**. A new
`notifications [n]` command lets the owner review "what needed me, and when" after the fact. This is the
persistent backbone any future delivery channel (email/Slack — deliberately still deferred) would read
from.

### Core principle (do not violate)

Deterministic, rule-based, **NO LLM**, **local only** (no network, no outward delivery). The daemon
already computes the "Needs you" set and detects when it changes (Phase 12); this phase only **diffs**
that set against the previous tick and **appends** records. It sends nothing anywhere.

### CRITICAL — hard guardrails (a violation of any is a defect)

- **Local + append-only.** The only new mutation is **appending** lines to `.executive/notifications.jsonl`
  (never rewrites/truncates it). No network, no email, no webhook, no git, no LLM. If you find yourself
  importing `fetch`, a mail client, or anything outward-facing, stop — that is a separate, deferred phase.
- **Daemon-only writer.** Notifications record *transitions observed over time*, so **only the `watch`
  daemon** appends them (it is the thing that sees ticks). The standalone `report` command stays a pure
  **read-only snapshot** and must NOT write notifications. The new `notifications` command only **reads**
  the log.
- **Reuse Phase 12's change point.** Append records **inside the existing signature-change block** in the
  daemon's digest step — i.e. only when `needsYouSignature` changed. On an unchanged queue, nothing is
  appended (no spam), exactly like the Phase 12 alert.
- **Never crashes the daemon.** The append is inside the existing digest `try/catch`; any error logs to
  stderr and ticking continues. A corrupt log line must never crash a read (`notifications` skips it,
  mirroring the EventStore's defensive read).
- **Additive to Phase 12, not a rewrite.** The Phase 12 alert print stays exactly as-is. You ADD the diff
  + append alongside it (and track the previous item list). Do not change the alert wording or the
  `report`/`buildDigest`/`renderDigest`/`needsYouSignature` behaviour.

### Out of scope (do NOT build)

- No external delivery (email/Slack/push/webhook) — still deferred; outward-facing.
- No config changes (consistent with Phase 12 being ungated — a local append is the same low-risk class
  as the unconditional state/plan/digest refresh).
- No edits to `src/report/digest.ts`'s existing functions, `src/planner/*`, `src/worker/*`,
  `src/executor/*`, `src/synth/*`, `src/auto/*`, `src/state/*`, `src/bootstrap.ts`, `src/config.ts`.
- No new event types, no SQLite, no rotation/retention policy (the log grows append-only; retention is a
  later concern).
- Notifications are NOT surfaced inside `digest.md` (the digest stays a current snapshot); reviewing them
  is via the new `notifications` command only.

---

## 1. Data flow

```
watch daemon, each rebuild tick (Phase 12 digest step):
  digest = buildDigest(); writeDigest(renderDigest(digest));      [existing]
  sig = needsYouSignature(digest.needsYou);                       [existing]
  if (sig !== lastNeedsSignature):
     [existing Phase 12 alert print — unchanged]
     ── NEW ──
     { added, removed } = diffNeedsYou(lastNeedsItems, digest.needsYou)
     records = [ {ts, event:"added",    ...item} for item in added ]
             + [ {ts, event:"resolved", ...item} for item in removed ]
     if records.length: appendNotifications(records)              (→ notifications.jsonl)
     lastNeedsSignature = sig
     lastNeedsItems     = digest.needsYou                          (NEW: track items too)

notifications [n]  (CLI):
  readNotifications() → last n records (oldest→newest), printed one per line
```

---

## 2. Tech + constraints

- Bun (latest), TypeScript (strict). No new deps.
- Storage: `.executive/notifications.jsonl` (append-only JSONL, same shape discipline as the event logs).
- Runs on Windows 11.
- **All tests OFFLINE**: `diffNeedsYou` is pure; `appendNotifications`/`readNotifications` use a temp
  `EXECUTIVE_HOME`. No network/git/LLM. The daemon wiring is verified live by the reviewer (§8).
- User-facing strings: English.

### Existing to reuse read-only

- `NeedsYouItem` from `src/report/types.ts`.
- The EventStore's defensive-read style (`src/events/store.ts`) as the model for `readNotifications`
  (skip blank/corrupt lines, never throw).
- `execRoot` from `src/paths.ts`; you will add `notificationsPath()` there.

---

## 3. Files to create / edit

### Create — `src/report/`
```
src/report/
├── notify.ts       # NotificationRecord, diffNeedsYou, appendNotifications, readNotifications
└── notify.test.ts  # offline tests
```

### Edit
- `src/paths.ts` — add `notificationsPath()`.
- `src/index.ts` —
  - `watch` case: track `lastNeedsItems`, and inside the existing signature-change block append the diff
    records (additive to the Phase 12 alert).
  - add the `notifications [n]` CLI command; update `printUsage()`.

Do NOT edit any other file.

---

## 4. Types + functions (`src/report/notify.ts`)

```ts
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import type { NeedsYouItem } from "./types.js";
import { notificationsPath, execRoot } from "../paths.js";

/** One durable notification record: a "Needs you" item appeared or was resolved. */
export interface NotificationRecord {
  ts: string;                        // ISO timestamp of the transition
  event: "added" | "resolved";       // did the item enter or leave the queue?
  source: NeedsYouItem["source"];    // "plan" | "autopilot" | "executor" | "worker"
  summary: string;
  detail?: string;
}

/** Stable key for a needs-you item (matches needsYouSignature's keying). */
function keyOf(i: NeedsYouItem): string {
  return i.source + "|" + i.summary;
}

/**
 * Diff two "Needs you" queues by {source, summary} (detail is ignored, as in needsYouSignature).
 * added   = items in curr not in prev.
 * removed = items in prev not in curr.
 * Pure — no I/O.
 */
export function diffNeedsYou(
  prev: NeedsYouItem[],
  curr: NeedsYouItem[]
): { added: NeedsYouItem[]; removed: NeedsYouItem[] } {
  const prevKeys = new Set(prev.map(keyOf));
  const currKeys = new Set(curr.map(keyOf));
  const added = curr.filter((i) => !prevKeys.has(keyOf(i)));
  const removed = prev.filter((i) => !currKeys.has(keyOf(i)));
  return { added, removed };
}

/** Append notification records to .executive/notifications.jsonl (one JSON object per line). */
export function appendNotifications(records: NotificationRecord[]): void {
  if (records.length === 0) return;
  const root = execRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(notificationsPath(), lines);
}

/**
 * Read notification records oldest→newest. Skips blank/corrupt lines (never throws).
 * Returns [] when the file does not exist.
 */
export function readNotifications(): NotificationRecord[] {
  const path = notificationsPath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const out: NotificationRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as NotificationRecord); }
    catch { /* skip a corrupt line — never crash a read */ }
  }
  return out;
}
```

- `event: "added"` when an item enters the queue; `"resolved"` when it leaves. (A single tick can produce
  both — e.g. a block resolves while a new worker error appears.)
- Flatten `source`/`summary`/`detail` onto the record (do not nest the whole item) so the log is easy to
  scan.

---

## 5. Paths (`src/paths.ts` — addition only)

```ts
/** Absolute path to .executive/notifications.jsonl (durable "Needs you" history). */
export function notificationsPath(): string {
  return execRoot() + "/notifications.jsonl";
}
```

---

## 6. Daemon wiring (`src/index.ts`, `watch` case only)

1. Alongside `let lastNeedsSignature: string | null = null;` (added in Phase 12), add:
   ```ts
   let lastNeedsItems: import("./report/types.js").NeedsYouItem[] = [];
   ```
   (or import `NeedsYouItem` at the top and type it normally). Import `diffNeedsYou` and
   `appendNotifications` from `./report/notify.js`.
2. Inside the **existing** `if (sig !== lastNeedsSignature) { … }` block (the Phase 12 alert block),
   **after** the existing alert `if/else`, and before `lastNeedsSignature = sig;`, add:
   ```ts
   // Durable notification log (append-only; local only).
   const { added, removed } = diffNeedsYou(lastNeedsItems, digest.needsYou);
   const nowTs = new Date().toISOString();
   const records = [
     ...added.map((i) => ({ ts: nowTs, event: "added" as const, source: i.source, summary: i.summary, detail: i.detail })),
     ...removed.map((i) => ({ ts: nowTs, event: "resolved" as const, source: i.source, summary: i.summary, detail: i.detail })),
   ];
   appendNotifications(records);
   lastNeedsItems = digest.needsYou;
   ```
   Keep this inside the existing `try { … } catch (digestErr) { … }` so a write error never crashes the
   daemon. Do NOT alter the Phase 12 alert prints.
3. Do NOT touch the autopilot block, the worker block, the timer, or SIGINT.

---

## 7. CLI (`src/index.ts`)

### New `notifications` command

```
bun run src/index.ts notifications [n]        # default n = 10
```

Steps:
1. `await bootstrap();`
2. Parse `n` from `args[1]` (default 10; reject non-positive with an error + exit 1, like `tail`).
3. `const all = readNotifications();` then take the last `n` (oldest→newest).
4. Print one line per record, e.g.:
   `<ts>  [<event>] <source>: <summary>` and, when present, `  — <detail>` appended.
   When the log is empty, print `No notifications yet.`.
5. Exit `0`. Wrap in try/catch like the other commands.

Add to `printUsage()`:
```
  notifications [n]                             Show the last n "Needs you" notifications (default 10)
```

---

## 8. Tests

### New — `src/report/notify.test.ts` (offline)

`diffNeedsYou` (pure):
1. **Empty → items:** `diffNeedsYou([], [a,b])` → `added:[a,b]`, `removed:[]`.
2. **Items → empty:** `diffNeedsYou([a,b], [])` → `added:[]`, `removed:[a,b]`.
3. **Partial change:** prev `[a,b]`, curr `[b,c]` → `added:[c]`, `removed:[a]`.
4. **Ignores detail:** prev `[{plan,"S",detail:"x"}]`, curr `[{plan,"S",detail:"y"}]` → `added:[]`,
   `removed:[]` (same key).
5. **Distinguishes source:** same summary, different source counts as different items.

`appendNotifications`/`readNotifications` (temp `EXECUTIVE_HOME`):
6. **Round-trip + append semantics:** append batch1, then batch2 → `readNotifications()` returns
   batch1 ++ batch2 in order (append never truncates).
7. **Missing file → []:** `readNotifications()` on a fresh home returns `[]`.
8. **Corrupt line skipped:** write a good line + `"{ broken"` + another good line → `readNotifications()`
   returns the two good records, no throw.
9. **Empty records is a no-op:** `appendNotifications([])` writes nothing / creates no bad state.

All existing tests (190) must still pass. **No test may perform a network/git/LLM request.**

---

## 9. Acceptance criteria (Claude will verify ALL of these by running them)

- [ ] `bun run typecheck` passes (strict).
- [ ] `bun test` passes — existing 190 + new notify tests, offline.
- [ ] **Durable capture (the real gap):** in a temp repo, start the daemon, cause a "Needs you" item to
      appear (seed a blocked/ask state → `resolve_block`), let a tick run, stop the daemon; then
      `notifications` shows an `[added] plan: Planner needs your call: resolve_block` record — i.e. the
      alert survived even though it also scrolled past on stdout.
- [ ] **Resolved recorded:** after the item clears (e.g. `unblocked` → next tick), `notifications` shows a
      matching `[resolved] plan: …` record.
- [ ] **No spam:** across many unchanged ticks, no duplicate records are appended (only transitions are
      logged).
- [ ] `report` does NOT write notifications (still a read-only snapshot); the standalone `notifications`
      command only reads.
- [ ] Corrupt/missing `notifications.jsonl` never crashes `notifications` (empty → "No notifications yet.").
- [ ] The daemon never crashes over the append (SIGINT still exits 0; a forced error logs to stderr and
      ticking continues).
- [ ] `src/report/digest.ts` existing functions, `src/planner/*`, `src/worker/*`, `src/executor/*`,
      `src/synth/*`, `src/auto/*`, `src/config.ts`, `src/bootstrap.ts` are **unchanged**.
- [ ] `.executive/notifications.jsonl` is gitignored (whole `.executive/` tree already is).
- [ ] Only the files listed in §3 were created/edited.

---

## 10. Deliverable

A commit containing `src/report/notify.ts` + `notify.test.ts`, the `paths.ts` addition, and the
`src/index.ts` edits (watch wiring + `notifications` command), plus this doc. Do NOT commit `.executive/`
runtime data. When done, hand back for review — Claude will run every item in §9 and will NOT trust the
self-report.

---

## 11. Design notes (rationale — not extra work)

- **Why durable, not just stdout:** the Phase 12 alert is a fine live signal, but the owner's whole reason
  for this system is to *not* have to watch. A persistent log means "what needed me while I was away" is
  answerable later — the difference between a notification and a flash of text.
- **Why daemon-only writer / read-only `report`:** notifications are about *transitions across time*, which
  only the continuously-running daemon observes. A one-off `report` has no "previous tick" to diff, so it
  correctly stays a snapshot and never fabricates transition records.
- **Why key on `source|summary` (ignore detail):** identical to `needsYouSignature`, so the notification
  log and the live alert agree on what counts as "the same item" — a wobbling `detail` string does not
  produce spurious added/resolved churn.
- **Why local file + append-only, and why no external delivery yet:** a local JSONL is the safe,
  inspectable, reversible substrate. Actual outbound delivery is outward-facing (can leak private state,
  needs credentials + explicit approval), so it stays a separate phase — but it will simply *read this
  log* and ship new records, so this phase is the right foundation to build first.
