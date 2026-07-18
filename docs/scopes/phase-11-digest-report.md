# Scope — Phase 11: Digest / Report layer (`report` command) (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.

---

## 0. What this phase is (and is NOT)

ExecutiveOS now runs its whole loop (Phases 1–10) and can even run the Autopilot continuously in the
`watch` daemon (Phase 9). But the human's only window into "what did the system see, what did it do, and
what needs my decision?" is a scatter of raw JSON files (`state.json`, `plan.json`, `auto-report.json`,
`exec-report.json`) plus fleeting stdout lines in the daemon. That directly fights the product's whole
purpose — **reducing the owner's decision fatigue**.

**Phase 11 adds a Digest: a single `report` command that reads the existing `.executive/` artifacts and
renders one concise, human-readable Markdown summary** — "here's where things stand, here's what the
Planner recommends, here's what the Autopilot last did, and here's exactly what needs YOU." It writes
`.executive/digest.md` and prints the same to stdout.

### Core principle (do not violate)

This is a **pure presentation layer** — the same family as Phase 3 (State) and Phase 4 (Planner):
**100% deterministic, rule-based, NO LLM.** It only **reads** existing artifacts and **formats** them.

### CRITICAL — hard guardrails (a violation of any is a defect)

- **Read-only.** The Digest reads `.executive/*.json` and writes exactly ONE file: `.executive/digest.md`.
  It **never** mutates or deletes any other file, **never** runs git, **never** calls an LLM, **never**
  touches the network, **never** spawns a process. If you find yourself importing `applyChangeSet`,
  `runWorker`, `runAuto`, git, or `fetch`, stop — the scope is wrong.
- **No LLM.** Zero model calls. The summary is assembled by code from the JSON fields. (Do NOT import
  anything from `src/worker/*`, `src/synth/*`, `src/auto/*` except read-only *types* if useful.)
- **Every input is optional and untrusted.** Any of the source files may be **absent** (fresh repo) or
  **malformed** (partial write, hand-edit). `buildDigest` must degrade gracefully per-section — a missing
  or unparseable file yields a "no data yet" note for that section and the rest of the digest still
  renders. **It must never throw** on missing/malformed input.
- **Not wired into the daemon.** Phase 11 is the `report` CLI command ONLY. Do NOT auto-print it on a
  timer, do NOT wire it into `watch`. (Auto-emitting a digest each tick is a possible later phase.)
- **No external delivery.** "Report" here means a **local** Markdown digest only. No email, Slack, push,
  webhook, or any outbound transport — those are outward-facing and out of scope (a separate future
  phase with its own approval/guardrails).

### Out of scope (do NOT build)

- No config changes (`src/config.ts` untouched — no new block).
- No new event types, no reading the raw JSONL event logs (State already summarizes them; read
  `state.json`, not `events/*.jsonl`).
- No `watch`-daemon wiring, no timers, no notifications/transport.
- No edits to `src/state/*`, `src/planner/*`, `src/worker/*`, `src/executor/*`, `src/synth/*`,
  `src/auto/*`, `src/bootstrap.ts`, `src/config.ts`, or the `watch` case in `src/index.ts`.
- No SQLite, no server, no HTML output — Markdown + stdout only.

---

## 1. Data flow

```
report  (CLI)
  └ bootstrap()                                   (ensure .executive/ exists; safe/idempotent)
  └ digest = buildDigest()                        (reads the artifacts below, all OPTIONAL)
        reads (each optional, defensive parse):
          .executive/state.json        → "Now" section
          .executive/plan.json         → "Recommended action" section
          .executive/auto-report.json  → "Last Autopilot run" section
          .executive/exec-report.json  → parked-change signal for "Needs you"
          .executive/proposal.json     → worker-error signal for "Needs you"
  └ md = renderDigest(digest)                     (pure Digest → Markdown string)
  └ writeDigest(md)                               (atomic temp+rename → .executive/digest.md)
  └ print md to stdout ; exit 0
```

`buildDigest` returns a **structured `Digest`** object (so tests assert field-by-field); `renderDigest`
turns it into Markdown (so tests assert the human output separately).

---

## 2. Tech + constraints

- Bun (latest), TypeScript (strict). No new runtime deps.
- Storage: reads JSON under `.executive/`; writes `.executive/digest.md` (UTF-8 Markdown).
- Runs on Windows 11.
- **All tests OFFLINE**: seed artifacts by writing JSON files into a temp `EXECUTIVE_HOME`; assert on the
  returned `Digest` and the rendered Markdown. No network, no git, no LLM. A test that does any of those
  is a defect.
- User-facing strings: English (the digest is the owner's to read; English is fine and consistent with
  the rest of the runtime's output).

### Existing types you MAY import read-only (do NOT edit their files)

- `State` from `src/state/types.ts`.
- `Plan`, `ProposedAction` from `src/planner/types.ts`.
- `AutoReport` from `src/auto/types.ts`.
- `ExecReport` from `src/executor/types.ts`.
- `Proposal` from `src/worker/types.ts`.
- `statePath`, `planPath`, `autoReportPath`, `execReportPath`, `proposalPath`, `execRoot` from
  `src/paths.ts`; you will add `digestPath()` there.
- `bootstrap` from `src/bootstrap.ts`.

> These imports are for **types** and **paths** only. Do NOT call any behavior from worker/executor/auto.

---

## 3. Files to create / edit

### Create — `src/report/`
```
src/report/
├── types.ts        # Digest + sub-structures + DigestOptions
├── digest.ts       # buildDigest(opts?) + renderDigest(digest) + writeDigest(md)
└── digest.test.ts  # offline tests
```

### Edit
- `src/paths.ts` — add `digestPath()`.
- `src/index.ts` — add the `report` CLI command; update `printUsage()`.

Do NOT edit any other file.

---

## 4. Types (`src/report/types.ts`)

```ts
/** One item the human must decide/act on. */
export interface NeedsYouItem {
  source: "plan" | "autopilot" | "executor" | "worker"; // where it came from
  summary: string;   // one-line, human-readable
  detail?: string;   // optional extra context (reason, branch, etc.)
}

/** A structured, deterministic snapshot for rendering. Every section is optional/nullable
 *  so a fresh repo (no artifacts yet) still produces a valid Digest. */
export interface Digest {
  generatedAt: string;               // ISO — when the digest was built

  now: {
    available: boolean;              // false when state.json missing/unreadable
    project: string | null;
    task: string | null;
    deadline: string | null;
    currentFile: string | null;
    tests: "passing" | "failing" | "unknown" | null;
    blocked: boolean | null;
    blockedReason: string | null;
    branch: string | null;
    idle: boolean | null;            // true when activity.active === false
    stateGeneratedAt: string | null; // provenance/staleness
  } ;

  recommended: {
    available: boolean;              // false when plan.json missing/unreadable
    topActionKind: string | null;
    disposition: "act" | "ask" | null;
    reason: string | null;
    confidence: number | null;
    actionCount: number;             // plan.actions.length (0 when unavailable)
  };

  lastAutopilot: {
    available: boolean;              // false when auto-report.json missing/unreadable
    stage: string | null;
    ok: boolean | null;
    applied: boolean | null;
    branch: string | null;
    commitSha: string | null;
    testPassed: boolean | null;
    needsHuman: boolean | null;
    stoppedReason: string | null;
    generatedAt: string | null;
  };

  needsYou: NeedsYouItem[];          // aggregated across sources; [] when nothing pending
}

export interface DigestOptions {
  now?: string; // ISO override for deterministic tests; default new Date().toISOString()
}
```

---

## 5. Paths (`src/paths.ts` — addition only)

```ts
/** Absolute path to .executive/digest.md (the latest human-readable digest). */
export function digestPath(): string {
  return execRoot() + "/digest.md";
}
```

---

## 6. Builder + renderer (`src/report/digest.ts`)

```ts
export function buildDigest(opts?: DigestOptions): Digest;
export function renderDigest(d: Digest): string;      // → Markdown
export function writeDigest(md: string): void;        // atomic temp+rename → digestPath()
```

### `buildDigest`

- Use a small local helper to **read + JSON-parse a file defensively**: returns the parsed object or
  `null` on any error (missing file, unreadable, malformed JSON). Never throws.
  ```ts
  function readJson<T>(path: string): T | null {
    try { const raw = readFileSync(path, "utf-8"); return JSON.parse(raw) as T; }
    catch { return null; }
  }
  ```
- **now** ← `readJson<State>(statePath())`. When null → `{ available: false, ...all null }`. Else map:
  `project=state.currentProject`, `task=state.currentTask`, `deadline`, `currentFile`, `tests`,
  `blocked`, `blockedReason`, `branch=state.git.branch`, `idle = state.activity.active === false`,
  `stateGeneratedAt=state.generatedAt`, `available: true`.
- **recommended** ← `readJson<Plan>(planPath())`. When null → `{ available:false, ...null, actionCount:0 }`.
  Else: `topActionKind = plan.topAction?.kind ?? null`, `disposition = plan.topAction?.disposition ?? null`,
  `reason = plan.topAction?.reason ?? null`, `confidence = plan.topAction?.confidence ?? null`,
  `actionCount = plan.actions.length`, `available:true`.
- **lastAutopilot** ← `readJson<AutoReport>(autoReportPath())`. When null → `{ available:false, ...null }`.
  Else copy `stage, ok, applied, branch, commitSha, testPassed, needsHuman, stoppedReason,
  generatedAt`, `available:true`.
- **needsYou** — aggregate, in this order (deterministic), skipping duplicates by `summary`:
  1. **plan**: if `plan.topAction` exists AND `plan.topAction.disposition === "ask"` → push
     `{ source:"plan", summary: "Planner needs your call: " + kind, detail: reason }`.
  2. **autopilot**: if `autoReport?.needsHuman === true` → push
     `{ source:"autopilot", summary: "Autopilot stopped and needs you", detail: stoppedReason ?? undefined }`.
  3. **executor (parked change)**: `readJson<ExecReport>(execReportPath())`; if
     `exec.mode === "apply" && exec.committed === true && exec.testPassed === false` → push
     `{ source:"executor", summary: "A change is parked on " + exec.branch + " with FAILING tests",
        detail: exec.title }`.
  4. **worker**: `readJson<Proposal>(proposalPath())`; if `proposal.status === "error"` → push
     `{ source:"worker", summary: "The last Worker run errored", detail: proposal.error ?? undefined }`.
  - `needsYou` is `[]` when none apply. (Dedup: if two pushes have an identical `summary`, keep the first.)
- `generatedAt = opts?.now ?? new Date().toISOString()`.

### `renderDigest` (pure — Digest → Markdown string)

Produce clean Markdown. Exact wording is yours, but it MUST:
- Start with a top header line, e.g. `# ExecutiveOS — Digest` and the `generatedAt`.
- A `## Now` section: project/task/tests/blocked/branch/deadline/idle, or `_No state yet._` when
  `!now.available`.
- A `## Recommended action` section: the top action + disposition + confidence + `(N actions total)`,
  or `_No plan yet._` when `!recommended.available`. When `disposition === "ask"`, make it visibly a
  question for the human (e.g. prefix `⚠️` or the word "ASK").
- A `## Last Autopilot run` section: stage/ok/applied/branch/commit/testPassed, or
  `_Autopilot has not run._` when `!lastAutopilot.available`.
- A `## Needs you` section: a bullet per `NeedsYouItem` (`- **<summary>** — <detail>`), or a clear
  `_Nothing needs you right now._` when `needsYou.length === 0`.
- Never emit `undefined`/`null` literally — render a dash `—` or omit the line.

### `writeDigest`

Atomic temp+rename to `digestPath()` (same pattern as `writeProposal`/`writeAutoReport`): write to
`digestPath() + "." + randomUUID()`, then `renameSync`. Create `execRoot()` if missing.

---

## 7. CLI (`src/index.ts`)

### New `report` command

```
bun run src/index.ts report
```

Steps:
1. `await bootstrap();`
2. `const digest = buildDigest();`
3. `const md = renderDigest(digest);`
4. `writeDigest(md);`
5. `process.stdout.write(md + "\n");`
6. `process.stdout.write("\n(written to " + digestPath() + ")\n");`
7. Exit `0`. Wrap in try/catch like the other commands; on an unexpected throw, stderr + exit 1. (But
   note: `buildDigest` itself must not throw on missing/malformed artifacts — the try/catch is a
   last-resort safety net, not the primary error path.)

Add to `printUsage()`:
```
  report                                        Render a human-readable digest of the current state
```

---

## 8. Tests (`src/report/digest.test.ts`) — required, `bun test`, OFFLINE

Set `EXECUTIVE_HOME` to a fresh temp dir per test; clean up after. Seed artifacts by writing JSON files
directly (e.g. `writeFileSync(statePath(), JSON.stringify(<State>))`). Cover at minimum:

1. **Empty repo (no artifacts):** `buildDigest()` → `now.available:false`, `recommended.available:false`,
   `lastAutopilot.available:false`, `needsYou: []`; `renderDigest` contains `_No state yet._`,
   `_No plan yet._`, `_Autopilot has not run._`, `_Nothing needs you right now._`. **No throw.**
2. **State present (failing tests, blocked):** seed a `State` with `tests:"failing"`, `blocked:true` →
   `now.available:true`, `now.tests:"failing"`, `now.blocked:true`; rendered Markdown mentions failing
   tests.
3. **Plan with act disposition:** seed a `Plan` whose `topAction` is `fix_tests`/`act` →
   `recommended.topActionKind:"fix_tests"`, `disposition:"act"`, `actionCount` matches; **not** added to
   `needsYou`.
4. **Plan with ask disposition → needsYou:** seed `resolve_block`/`ask` → `needsYou` has a `source:"plan"`
   item; rendered `## Needs you` lists it.
5. **Autopilot applied:** seed an `AutoReport` with `applied:true`, `branch:"executive/change-x"`,
   `needsHuman:false` → `lastAutopilot.applied:true`, branch surfaced; **not** in `needsYou`.
6. **Autopilot needsHuman → needsYou:** seed `AutoReport` `needsHuman:true`,
   `stoppedReason:"changeset failed validation"` → `needsYou` has a `source:"autopilot"` item with that
   detail.
7. **Parked change → needsYou:** seed an `ExecReport` `mode:"apply"`, `committed:true`,
   `testPassed:false`, `branch:"executive/change-y"` → `needsYou` has a `source:"executor"` item naming
   the branch.
8. **Worker error → needsYou:** seed a `Proposal` `status:"error"`, `error:"boom"` → `needsYou` has a
   `source:"worker"` item.
9. **Malformed file degrades, does not crash:** write `state.json` = `"{ not json"` (and a valid
   `plan.json`) → `now.available:false` but `recommended.available:true`; **no throw**.
10. **Determinism:** `buildDigest({ now: "2026-01-01T00:00:00.000Z" })` twice on the same artifacts →
    identical `Digest` (deep-equal) and identical rendered Markdown.

All existing tests (165) must still pass. **No test may perform a network/git/LLM request.**

---

## 9. Acceptance criteria (Claude will verify ALL of these by running them)

- [ ] `bun run typecheck` passes (strict).
- [ ] `bun test` passes — existing 165 + new digest tests, offline.
- [ ] `report` on a fresh `init` (no state/plan yet) prints a valid digest with the "no data yet"
      placeholders, writes `.executive/digest.md`, and exits `0` **without error**.
- [ ] After seeding a failing-tests state + `plan` (`fix_tests`/`act`), `report` shows `tests: failing`
      in **Now** and `fix_tests (act)` in **Recommended action**.
- [ ] An `ask`-disposition plan, an autopilot `needsHuman` report, a parked failing-tests exec-report,
      and a worker-error proposal each surface a bullet under **Needs you** (verified individually).
- [ ] `report` writes ONLY `.executive/digest.md`; no other `.executive` file is modified, no git command
      runs, no network call, no LLM call (verify by inspection + that it works with no network/gateway).
- [ ] Missing/malformed artifacts never crash `report` (exit 0, graceful placeholders).
- [ ] `.executive/digest.md` is gitignored (whole `.executive/` tree already is).
- [ ] `src/state/*`, `src/planner/*`, `src/worker/*`, `src/executor/*`, `src/synth/*`, `src/auto/*`,
      `src/config.ts`, `src/bootstrap.ts`, and the `watch` case are **unchanged** (git diff empty there).
- [ ] Only the files listed in §3 were created/edited.

---

## 10. Deliverable

A commit containing `src/report/` and the two edits (`paths.ts`, `index.ts`), plus this doc. Do NOT commit
`.executive/` runtime data. When done, hand back for review — Claude will run every item in §9 and will
NOT trust the self-report.

---

## 11. Design notes (rationale — not extra work)

- **Why a pure read/format layer (no LLM):** the digest must be trustworthy and free — the owner reads it
  to *decide*, so it cannot hallucinate or cost tokens. Every line is a direct projection of a JSON field
  the deterministic OS already produced.
- **Why "Needs you" is computed, not stored:** it is the single most valuable part — it collapses four
  scattered signals (ask-plan, stopped autopilot, parked red change, worker error) into one list so the
  owner sees their queue at a glance. It is derived fresh each run from current artifacts.
- **Why local Markdown only:** delivery (email/Slack/push) is outward-facing — it can leak private state
  and needs explicit approval, so it is deliberately a separate future phase. A local `digest.md` +
  stdout is the safe, high-value first step and is trivially inspectable.
- **Why defensive/optional everything:** the digest is the one command the owner will run *before* the
  rest of the system has produced anything (right after `init`), and *after* partial/interrupted runs. It
  must always render something useful and never fail.
