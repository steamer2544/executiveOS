# Scope — Phase 8: Autopilot (`auto` command) (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.

---

## 0. What this phase is (and is NOT)

ExecutiveOS now has every stage of its loop, but they run as **separate CLI commands** that a human
must chain by hand:

```
build-state → plan → work (→ Proposal) → synth (→ ChangeSet, dry-run) → execute --apply
```

**Phase 8 adds the Autopilot: a single `auto` command that runs the whole chain end-to-end**, gated by
the existing guardrails, so the human's job shrinks to reviewing/merging the branch the Autopilot
leaves behind.

**Core principle (do not violate):** the Autopilot is a **conductor**, not a new brain. It **reuses**
Phase 3 (state), Phase 4 (plan), Phase 5 (Worker), Phase 6 (Executor), and Phase 7 (Synthesizer)
exactly as they are. It writes **no new LLM code, no new git code** — it only orchestrates and enforces
the stop/go gates between stages.

### CRITICAL — hard guardrails (a violation of any is a defect)

- **Acts only on an `act` decision.** The Autopilot proceeds past `plan` **only when
  `plan.topAction.disposition === "act"`** (Phase 4's confidence->0.95, not-forbidden gate). If the
  top action is `"ask"` or there is none, it **STOPS and reports "needs human"** — it never calls the
  Worker/Synthesizer/Executor for an `ask` action.
- **Never merges into the working branch.** Applying reuses Phase 6's `applyChangeSet` with
  `apply: true`, which only ever commits to an isolated `executive/change-<id>` branch and returns to
  the original branch. The human still does the final merge. (Full autonomy still never touches the
  owner's branch history.)
- **`--apply` is opt-in; dry-run is the default.** `auto` alone runs the whole chain in preview
  (through the Synthesizer's dry-run) and applies **nothing**. `auto --apply` is required to let the
  Executor commit to a branch.
- **Every pre-apply gate must pass.** The Autopilot applies only when: disposition `act` **and** the
  Synthesizer's ChangeSet passes `validateChangeSet` **and** the dry-run shows all ops would succeed.
  Any gate failing → STOP, no apply.
- **Failing tests are not success.** If the applied change's test command fails, the change is left
  parked on its isolated branch (Phase 6 already commits it) and the report is flagged `ok: false`
  with "needs human" — the Autopilot never pretends a red change is done.
- **No daemon integration.** Phase 8 is the `auto` CLI command ONLY. Do NOT wire it into the `watch`
  daemon (continuous autonomy is a later phase). Do NOT auto-run it on any timer.

### Out of scope (do NOT build)

- No `watch`-daemon wiring, no timers, no background execution.
- No new LLM backend, no new git logic, no new ChangeSet/Proposal formats.
- No edits to `src/worker/*`, `src/executor/*`, `src/synth/*`, `src/planner/*`, `src/state/*`.
- No SQLite, no server, no new watchers. No config schema changes (Phase 8 reuses `config.worker` and
  `config.executor`; it adds no config block).

---

## 1. Data flow

```
runAuto(opts)
  1. buildState + writeState + plan + writePlan                 (Phase 3 + 4)
  2. GATE: plan.topAction must exist AND disposition === "act"  → else STOP ("needs human"/"no action")
  3. runWorker(context, plan, config) → Proposal; writeProposal (Phase 5)
        └ if proposal.status !== "ok" → STOP
  4. runSynth({ proposalId, explicitFiles, ... })               (Phase 7: writes changeset.json,
        │                                                         validates, DRY-RUNS the Executor)
        └ if !changeSetWritten / !validation.ok / dry-run has blocked ops → STOP
  5. if opts.apply:
        read .executive/changeset.json → applyChangeSet({ apply: TRUE })   (Phase 6: isolated branch)
        └ isolated branch + tests + commit; ok = tests passed (or none)
     else: STOP after dry-run ("preview complete — pass --apply to act")
  6. writeAutoReport(.executive/auto-report.json) + return
```

Each stage is an existing function. The Autopilot only decides whether to continue.

---

## 2. Tech + constraints

- Bun (latest), TypeScript (strict). No new runtime deps.
- Storage: JSON under `.executive/`.
- Runs on Windows 11.
- **All tests OFFLINE**: inject a `MockWorker` (Phase 5) and `MockSynthesizer` (Phase 7); git tests use
  a temp git repo. No network. A test that hits the network is a defect.
- User-facing strings in Thai or English only (English for code/logs).

### Existing functions/types you MUST import read-only (do not edit their files)

- `buildState`, `writeState` from `src/state/builder.ts`; `State`, `Context` from `src/state/types.ts`.
- `plan`, `writePlan` from `src/planner/planner.ts`; `Plan`, `ProposedAction` from `src/planner/types.ts`.
- `runWorker`, `writeProposal` from `src/worker/orchestrator.ts`; `Worker` from `src/worker/types.ts`;
  `Proposal` from `src/worker/types.ts`.
- `runSynth` from `src/synth/synth.ts`; `Synthesizer` from `src/synth/types.ts`.
- `applyChangeSet` from `src/executor/executor.ts`; `ChangeSet`, `ExecReport` from `src/executor/types.ts`.
- `changeSetPath` from `src/paths.ts`; `Config` from `src/config.ts`.

---

## 3. Files to create / edit

### Create — `src/auto/`
```
src/auto/
├── types.ts      # AutoStage, AutoOptions, AutoReport
├── auto.ts       # runAuto(opts) + writeAutoReport(r)
└── auto.test.ts  # offline tests
```

### Edit
- `src/paths.ts` — add `autoReportPath()`.
- `src/index.ts` — add the `auto` CLI command; update `--help`.

Do NOT edit any other file. In particular do NOT touch `src/config.ts` (no new config),
`src/worker/*`, `src/executor/*`, `src/synth/*`, `src/planner/*`, `src/state/*`, and do NOT modify the
`watch` daemon.

---

## 4. Types (`src/auto/types.ts`)

```ts
import type { Config } from "../config.js";
import type { ProposedAction } from "../planner/types.js";
import type { Worker } from "../worker/types.js";
import type { Synthesizer } from "../synth/types.js";

/** How far the Autopilot got before it stopped (or finished). */
export type AutoStage = "plan" | "worker" | "synth" | "execute" | "done";

export interface AutoOptions {
  repoRoot: string;
  config: Config;
  apply: boolean;              // false = whole-chain dry-run (default); true = let the Executor commit to a branch
  explicitFiles?: string[];    // forwarded to runSynth (its --files)
  workerOverride?: Worker;         // tests inject; production passes nothing
  synthOverride?: Synthesizer;     // tests inject; production passes nothing
}

export interface AutoReport {
  ok: boolean;                 // true = ran to a safe, successful conclusion (incl. "nothing to do" / correctly declined)
  stage: AutoStage;            // the furthest stage reached
  stoppedReason: string | null;// why it stopped before applying (null when it applied or completed a clean dry-run)
  needsHuman: boolean;         // true when a human must act (ask-disposition, validation/dry-run failure, or failing tests)

  topAction: ProposedAction | null;
  proposalId: string | null;
  changeSetWritten: boolean;
  validationOk: boolean | null;   // null if synth not reached
  dryRunOk: boolean | null;       // null if synth not reached
  applied: boolean;               // true only when apply:true and the Executor committed
  branch: string | null;
  commitSha: string | null;
  testPassed: boolean | null;

  messages: string[];
  generatedAt: string;            // ISO
}
```

---

## 5. Paths (`src/paths.ts` — addition only)

```ts
/** Absolute path to .executive/auto-report.json (the latest Autopilot report). */
export function autoReportPath(): string {
  return execRoot() + "/auto-report.json";
}
```

---

## 6. Orchestrator (`src/auto/auto.ts`)

```ts
export async function runAuto(opts: AutoOptions): Promise<AutoReport>;
export function writeAutoReport(r: AutoReport): void; // atomic temp+rename → autoReportPath()
```

`runAuto` behavior — **in this exact order**. Maintain a `messages: string[]` and a mutable report;
each STOP returns the report as-is (with the fields filled so far).

1. **Plan.** `const built = buildState(); writeState(built); const p = plan(built.state, built.context);
   writePlan(p);`. Set `report.topAction = p.topAction`.
2. **Gate — actionable?**
   - If `p.topAction === null` → `stage: "plan"`, `ok: true`, `needsHuman: false`,
     `stoppedReason: "no actionable topAction"`, message `"nothing to do"`, return.
   - If `p.topAction.disposition !== "act"` → `stage: "plan"`, `ok: true`, `needsHuman: true`,
     `stoppedReason: "topAction is '" + p.topAction.kind + "' with disposition 'ask' — needs human"`,
     return. **Do NOT call the Worker/Synth/Executor.**
3. **Worker.** `const proposal = await runWorker(built.context, p, opts.config, opts.workerOverride);`
   - If `proposal === null` → `stage: "worker"`, `ok: false`, `needsHuman: true`,
     `stoppedReason: "worker produced no proposal"`, return.
   - `writeProposal(proposal);` set `report.proposalId = proposal.id`.
   - If `proposal.status !== "ok"` → `stage: "worker"`, `ok: false`, `needsHuman: true`,
     `stoppedReason: "worker failed: " + (proposal.error ?? proposal.status)`, return.
4. **Synth.** `const synthReport = await runSynth({ repoRoot: opts.repoRoot, config: opts.config,
   explicitFiles: opts.explicitFiles, proposalId: proposal.id, synthOverride: opts.synthOverride });`
   - `report.changeSetWritten = synthReport.changeSetWritten;`
     `report.validationOk = synthReport.validation.ok;`
     `report.dryRunOk = synthReport.execReport ? synthReport.execReport.ok : null;`
     `report.selected… ` (push synthReport.messages into messages).
   - If `!synthReport.changeSetWritten` → `stage: "synth"`, `ok: false`, `needsHuman: true`,
     `stoppedReason: "synthesizer failed"`, return.
   - If `!synthReport.validation.ok` → `stage: "synth"`, `ok: false`, `needsHuman: true`,
     `stoppedReason: "changeset failed validation"`, return. (Safety: never apply an invalid changeset.)
   - If `synthReport.execReport && !synthReport.execReport.ok` → `stage: "synth"`, `ok: false`,
     `needsHuman: true`, `stoppedReason: "dry-run: some ops would fail"`, return.
5. **Apply gate.**
   - If `!opts.apply` → `stage: "synth"`, `ok: true`, `needsHuman: false`, `applied: false`,
     `stoppedReason: null`, message `"dry-run complete — run \`auto --apply\` to act"`, return.
   - If `opts.apply` → read the changeset Phase 7 wrote:
     `const cs = JSON.parse(readFileSync(changeSetPath(), "utf-8")) as ChangeSet;` then
     `const execReport = applyChangeSet(cs, { apply: true, repoRoot: opts.repoRoot, config: opts.config });`
     - `report.applied = execReport.committed; report.branch = execReport.branch;
       report.commitSha = execReport.commitSha; report.testPassed = execReport.testPassed;`
     - push `execReport.messages` into `messages`.
     - `stage: "execute"`. `ok = execReport.ok;`
       `needsHuman = !execReport.ok;` (a failing test / apply problem needs a human).
     - return.
6. Fill `generatedAt`, return.

> Note: `runWorker` returns the Proposal (it does NOT persist it); `runAuto` must `writeProposal` so
> that `runSynth` (which reads `proposal.json` / `proposals/<id>.json`) finds it. Passing
> `proposalId: proposal.id` makes `runSynth` read exactly that proposal.

`writeAutoReport`: atomic temp+rename to `autoReportPath()`, `JSON.stringify(r, null, 2) + "\n"` (same
pattern as `writeProposal`/`writePlan`/`writeReport`/`writeSynthReport`).

---

## 7. CLI (`src/index.ts`)

### New `auto` command

```
bun run src/index.ts auto [--apply] [--files a.ts,b.ts]
```

Steps:
1. `await bootstrap(); const config = loadConfig();`
2. Parse flags (hand-rolled, consistent with existing commands): `--apply` → boolean; `--files <csv>`
   → `explicitFiles` (split on `,`, trim, drop empties).
3. `const report = await runAuto({ repoRoot: process.cwd(), config, apply, explicitFiles });`
4. `writeAutoReport(report);`
5. Print a concise summary: stage reached, `ok`, `needsHuman`, top action (kind + disposition),
   proposal id, validation/dry-run status, and — when applied — branch, commit sha, test result, and
   the Executor's inspect/discard hints (already in `messages`). Always print `autoReportPath()`.
6. Exit `0` when `report.ok`, else `1`. (Errors from the sub-stages are captured into the report;
   still, wrap the body in try/catch like the other commands and exit 1 on an unexpected throw.)

Add to `printUsage()`:
```
  auto [--apply] [--files a,b]                  Run the whole chain (plan→work→synth→execute); dry-run unless --apply
```

---

## 8. Tests (`src/auto/auto.test.ts`) — required, `bun test`, OFFLINE

Set `EXECUTIVE_HOME` to a fresh temp dir per test; clean up after. Seed events (via the event store or
by writing JSONL) so `buildState`/`plan` produce the topAction you want. Inject `MockWorker` and
`MockSynthesizer`. For apply tests, create a temp git repo. Cover at minimum:

1. **Nothing to do:** a clean state (no failing test, not blocked, no deadline, active) → `plan`'s
   topAction is null → `runAuto` returns `stage: "plan"`, `ok: true`, `needsHuman: false`, `applied:
   false`; the injected Worker's `run` was **never called**.
2. **Ask disposition stops:** a blocked state (→ `resolve_block`, disposition `ask`) → `stage: "plan"`,
   `ok: true`, `needsHuman: true`, Worker **never called**, no branch created.
3. **Dry-run happy path (act):** a failing-tests state (→ `fix_tests`, `act`) with injected MockWorker
   + MockSynthesizer, `apply: false`, in a temp git repo → runs through synth, `changeSetWritten:
   true`, `validationOk: true`, `dryRunOk: true`, `applied: false`, `ok: true`, and **no
   `executive/change-*` branch exists** / working tree clean.
4. **Apply happy path (act):** same but `apply: true` → `stage: "execute"`, `applied: true`,
   `branch: "executive/change-<id>"`, `ok: true`; after the call HEAD is back on the original branch
   and the original tree does not contain the synthesized file.
5. **Unsafe changeset is never applied:** inject a `MockSynthesizer` variant returning a ChangeSet with
   a `../escape` path, `apply: true` → `runAuto` stops at `stage: "synth"`, `validationOk: false`,
   `ok: false`, `applied: false`, and **no branch is created** (the Executor was never called with
   `apply: true`).
6. **Worker failure stops:** inject a Worker whose `run` throws (so `runWorker` yields a
   `status: "error"` proposal) → `stage: "worker"`, `ok: false`, `needsHuman: true`, Synth never
   reached, no branch.
7. **Failing tests → parked, not success:** MockSynthesizer returns a valid ChangeSet whose `test` is
   `"exit 1"`, `apply: true` → `applied: true` (committed on the branch), `testPassed: false`,
   `ok: false`, `needsHuman: true`, HEAD back on the original branch.

All 131 existing tests must still pass. **No test may perform a network request.**

---

## 9. Acceptance criteria (Claude will verify ALL of these by running them)

- [ ] `bun run typecheck` passes (strict).
- [ ] `bun test` passes — existing 131 + new Autopilot tests, offline.
- [ ] With `config.worker.backend = "mock"`, a failing-tests state, in a temp git repo: `auto`
      (no `--apply`) runs plan→work→synth→dry-run, writes `changeset.json`, exits `0`, and **mutates
      the repo NOTHING** (no `executive/change-*` branch, working tree clean).
- [ ] `auto --apply` on the same setup creates `executive/change-<id>`, commits, returns HEAD to the
      original branch, exits `0`; the original branch is untouched.
- [ ] `auto` on a clean state prints "nothing to do", exits `0`, calls no LLM/Executor, creates no
      branch.
- [ ] `auto` on a blocked (ask) state stops at plan with a "needs human" message, exits `0`, creates
      no branch.
- [ ] A synthesizer that returns an unsafe path → `auto --apply` never applies it (no branch, exit 1).
- [ ] Reuses `config.worker` (Worker+Synth) and `config.executor` (Executor); `src/config.ts` is
      unchanged (no new config block).
- [ ] `src/worker/*`, `src/executor/*`, `src/synth/*`, `src/planner/*`, `src/state/*` are unchanged;
      nothing wired into the `watch` daemon.
- [ ] `.executive/auto-report.json` is gitignored (whole `.executive/` tree already is).
- [ ] Only the files listed in §3 were created/edited.

---

## 10. Deliverable

A commit containing `src/auto/` and the two edits (`paths.ts`, `index.ts`), plus this doc. Do NOT commit
`.executive/` runtime data. When done, hand back for review — Claude will run every item in §9 and will
NOT trust the self-report.
