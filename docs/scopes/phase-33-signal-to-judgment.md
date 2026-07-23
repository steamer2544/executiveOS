# Phase 33 — Signal → Judgment

## 0. Why

A review of the real runtime data (3,174 events, 2026-07-17 → 2026-07-23) found the system's
**sensing is far ahead of its reasoning**:

- State is accurate and near-fully auto-sensed (project, branch, tests, file, window title).
  Screen-sense Layer 2 correctly summarised the owner's live work from pixels alone.
- `plan.json` was `topAction: null` — **"No action needed."** The Planner has 4 rules and every one
  of them only fires when something is *broken*. 3,174 sensed events produced **0 decisions**.
- The Advisor's hit rate is fine (25 approved / 13 rejected / 3 pending = 61%) but the content is
  generic ("step outside for 3 minutes", "set a hydration reminder") or trivial
  ("add `console.log('entry')`, then revert"). Nothing is grounded in a specific observation.
- A real bug: `digest.md` was 12 hours stale while `state.json`/`plan.json` were current.

This phase closes those three gaps. It adds **no new sensor** — the data is already sufficient.

## 1. Guardrails (unchanged)

Everything here is **deterministic, rule-based, NO LLM** except Job 3, which only changes an
existing prompt. No new network calls, no new git operations, no new autonomy. New Planner rules
are all low-confidence → the existing `applyGuardrail()` forces `disposition: "ask"`.

## 2. Job 1 — `ui` must refresh the digest and the notification log

### Defect

The digest refresh + durable notification append live inside `case "watch"` (`src/index.ts:402-430`)
only. `case "ui"` never calls them, and `src/ui/server.ts` calls `buildDigest()` in memory to answer
`/api/state` but **never writes `digest.md` and never appends to `notifications.jsonl`**.

So when the owner runs `ui` (which also runs the watchers, and is the normal way to use the system),
**Phase 14's durable notification log is dead** — "Needs you" exists only on screen and is lost when
the tab closes. That is the exact failure Phase 14 was built to prevent.

### Fix

Extract the block into a shared, testable unit.

**New file `src/report/tick.ts`:**

```ts
export interface DigestTickState {
  lastSignature: string | null;   // null = never ticked (suppresses a spurious "cleared")
  lastItems: NeedsYouItem[];
}
export function createDigestTickState(): DigestTickState;

export interface DigestTickResult {
  digest: Digest;
  changed: boolean;            // signature differs from the previous tick
  added: NeedsYouItem[];       // written to the notification log
  resolved: NeedsYouItem[];
  cleared: boolean;            // non-empty → empty transition (and not the first tick)
}

/** Build the digest, write digest.md, append notification records for any transition,
 *  and advance `st` in place. Never throws — I/O errors propagate to the caller's try/catch. */
export function runDigestTick(st: DigestTickState): DigestTickResult;
```

Behaviour must be **byte-identical** to the current `watch` block: same signature dedup, same
`diffNeedsYou` keying, same records, same "first tick with an empty queue prints nothing" rule.

### Wiring

- `case "watch"` — replace the inline block with `runDigestTick(tickState)` and keep the existing
  stdout printing driven by the returned `changed` / `cleared` flags.
- `case "ui"` — add an interval at `config.state.intervalMs` (default 30000) that calls
  `runDigestTick(tickState)` inside a `try/catch`, printing the same `⚠️  Needs you (N)` /
  `✓ Needs-you queue cleared.` lines. Cleared by the existing `SIGINT` handler.

`src/ui/server.ts` is **not** changed — its in-memory `buildDigest()` for `/api/state` stays as is.

### Acceptance

1. `runDigestTick` on a fresh state writes `digest.md` and returns `changed:true` when the queue is
   non-empty, `cleared:false`.
2. Two consecutive ticks with an unchanged queue → the second returns `changed:false` and appends
   **no** notification records.
3. A non-empty → empty transition returns `cleared:true` and appends one `resolved` record per item.
4. A first tick with an empty queue returns `cleared:false` (no spurious "cleared" line).
5. Running `ui` for two intervals updates `digest.md`'s mtime and appends to `notifications.jsonl`
   when a "Needs you" item appears.

## 3. Job 2 — Planner rules that fire on patterns, not just breakage

### 3.1 Architectural constraint

The Planner reads **`State` only**, never the raw event logs (Phase 4 contract). Pattern metrics are
therefore derived by the **State Builder** and exposed as a new `State.patterns` block; the rules stay
pure functions of `State`.

### 3.2 Thresholds are calibrated against the real log, not guessed

Every threshold below was chosen by measuring the actual 3,174-event log. Two rules that seemed
obvious were **measured and dropped**:

| Candidate metric | Measured on the real log | Verdict |
|---|---|---|
| app switches / 30 min | p50 **26**, p90 37, max 42 | **Dropped.** Switching *is* the baseline; any rule fires constantly or never. Not a signal. |
| repo switches / 1 h | p50 0, p99 0, **max 0** (only 1 repo tagged) | **Dropped as a rule.** Zero evidence in the data; would be dead code. Metric kept for the Advisor only. |
| same-file saves / 30 min | p50 1, p90 6, p99 **17**, max 22 | Keep. Threshold **≥ 15** = top ~1%. |
| commit gap + edits | one real instance: **10.0 h gap / 78 edits** | Keep. Threshold **≥ 3 h and ≥ 20 edits**. |
| session length (15-min break) | 22 sessions, longest **1.87 h** | Keep. Threshold **≥ 90 min** (a 3 h threshold would never fire). |

The 15-minute session-break constant is itself calibrated: the p99 inter-event gap is 318 s (~5 min),
so 15 min is comfortably outside normal working rhythm.

### 3.3 New file `src/state/patterns.ts`

```ts
export interface Patterns {
  /** ms since the newest git.commit, or null when there has never been one. */
  msSinceLastCommit: number | null;
  /** editor.save events newer than the newest git.commit (0 when no commit exists). */
  editsSinceLastCommit: number;
  /** saves of State.currentFile within the last 30 minutes. */
  sameFileSaves30m: number;
  /** length of the current continuous activity run; a gap >= 15 min starts a new run. */
  sessionMs: number | null;
  /** distinct repo changes among repo-tagged events in the last hour (observability only). */
  repoSwitches1h: number;
}

export const SESSION_BREAK_MS = 15 * 60 * 1000;

/** Pure: no I/O, no clock of its own. `events` must be seq-ascending. */
export function computePatterns(
  events: Array<{ seq: number; ts: string; type: string; data: Record<string, unknown> }>,
  nowMs: number,
  currentFile: string | null
): Patterns;
```

`State.patterns` is a **required** field on `State` (7 test fixtures gain one line). `buildState`
calls `computePatterns(allEvents, clock.getTime(), currentFile)` after `currentFile` is derived.

Malformed/unparseable `ts` values must be skipped, never crash.

### 3.4 New rules in `src/planner/rules.ts`

All three are pure `(s: State) => ProposedAction | null`, appended after `resumeTask`, all
`forbidden: false`, all confidence ≤ 0.95 → **always `ask`**.

| Rule | Fires when | Priority | Confidence |
|---|---|---|---|
| `checkpoint_work` | `msSinceLastCommit >= 3h` **and** `editsSinceLastCommit >= 20` | 60 | 0.55 |
| `grinding_on_file` | `sameFileSaves30m >= 15` **and** `tests !== "failing"` | 45 | 0.50 |
| `long_session` | `sessionMs >= 90min` | 35 | 0.50 |

`grinding_on_file` defers to `fix_tests` (it excludes `tests === "failing"`) — a red suite already has
a higher-priority rule and re-saving a file is the expected behaviour there, not a warning sign.

Reasons must name the concrete number so the line is checkable by the owner, e.g.
`"78 edit(s) over 10.0h with no commit — checkpoint on a branch?"`.

### 3.5 Acceptance

1. A state with 25 edits and a 4-hour-old commit → `checkpoint_work` present, `disposition: "ask"`.
2. Same state at 19 edits, or a 2-hour-old commit → rule silent.
3. `sameFileSaves30m: 20` with `tests: "failing"` → `grinding_on_file` silent, `fix_tests` is top.
4. `sessionMs: 95min` → `long_session` present at priority 35, below every other fired rule.
5. A healthy state with no patterns crossing a threshold → still `"No action needed."` (no new noise).
6. `computePatterns([], now, null)` → all-zero/null, no throw.
7. Replaying the real event log produces at least one `checkpoint_work` at the known 10 h / 78 edit
   point, and zero rules fire on the current healthy state.

## 4. Job 3 — Advisor proposals must be grounded

### Defect

The Advisor's prompt asks for "small, concrete, reversible" actions but never requires the proposal to
be **tied to something actually observed**, and the user message sends raw `state` + the last 20
events, which is thin on behaviour. The result is horoscope-grade advice ("stay hydrated") that any
system could emit without sensing anything, and busywork code tasks.

### Change (prompt + a required field — no new backend, no new call)

1. `ProposalDraft` and `Proposal` gain **`evidence?: string`** — the specific observation the proposal
   rests on.
2. The system prompt requires every proposal to cite evidence from the provided data, and explicitly
   **bans generic self-care/productivity advice that is not tied to an observation**. A break nudge is
   allowed only when it can cite the measured session length.
3. `buildUserMessage` additionally sends `state.patterns` and a compact **`windowHistory`** — the last
   20 distinct `screen.window` titles from `context.recentEvents` — so the model reasons about
   behaviour, not just a snapshot.
4. `parseDrafts` reads `evidence`. Drafts whose `evidence` is missing or under 8 characters are
   **dropped** — an ungrounded proposal is exactly what this job removes.
5. The dashboard card and the `proposals` CLI render the evidence line when present.

`sanitizeExecutable()` (Phase 27) and the whole approve/execute path are **untouched**.

### Acceptance

1. `parseDrafts` keeps a draft with `evidence`, drops one without, drops one with `evidence: "n/a"`.
2. `buildUserMessage` includes `patterns` and `windowHistory`; `windowHistory` is deduped and capped
   at 20.
3. The system prompt contains the ban on ungrounded generic advice.
4. Existing Phase 22/27 tests (mock advisor, sanitize, execute) stay green.

## 5. What is NOT in scope

- No new sensor, watcher, or event source.
- No new LLM call site, gateway, model, or config key for an LLM.
- No change to Worker / Executor / Synth / Autopilot / `sanitizeExecutable` / approve-execute.
- No change to `src/ui/server.ts`'s request handling (Job 1 touches the CLI wiring only).
- No autonomy change: every new Planner rule is `ask`; the Advisor still only proposes.
- No renumbering or rewriting of the event log (that is `compact`'s job, Phase 32.1).
