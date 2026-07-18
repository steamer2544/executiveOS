# Scope — Phase 9: Continuous Autopilot (`watch`-daemon autonomy) (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.

---

## 0. What this phase is (and is NOT)

ExecutiveOS has a working end-to-end loop, but the human still has to **type a command** to run it.
Phase 8 gave a single `auto` command (`plan → work → synth → execute`). The `watch` daemon observes
events and rebuilds `state.json`/`plan.json` on a timer, but it **never acts** — it only ever calls the
Worker when `config.worker.autoInvoke === true`, and even then it stops at a Proposal.

**Phase 9 closes the core-principle loop: the `watch` daemon runs the Autopilot on its own, continuously,
behind two default-OFF config gates.** This is the "Observe → Understand → Predict → **Act** → Observe
again" loop running without a prompt — but every guardrail from Phases 4–8 stays exactly as-is, and the
whole feature is **off by default**.

**Core principle (do not violate):** Phase 9 is a **conductor wired into the daemon**, not a new brain.
It **reuses** `runAuto` (Phase 8) verbatim. It writes **no new LLM code, no new git code, no new
plan/proposal/changeset logic**. Its only new responsibilities are: (a) two config gates, (b) a
**re-trigger guard** so it does not re-run on an unchanged state every interval, and (c) wiring the call
into the existing `watch` rebuild cycle.

### CRITICAL — hard guardrails (a violation of any is a defect)

- **Off by default.** Both new config flags default to `false`. A config with no `autopilot` block, or
  an old Phase 1–8 config, must behave **exactly as today** (daemon observes + rebuilds state/plan,
  never runs the Autopilot). Turning the daemon on with `watch` must NOT start acting unless the owner
  explicitly set `autopilot.enabled: true`.
- **Two gates, both explicit.**
  - `autopilot.enabled: true` → the daemon runs `runAuto(..., { apply: false })` — the **dry-run** chain
    (plan → work → synth → dry-run). It produces `proposal.json` / `changeset.json` / `auto-report.json`
    for the human to review, but **applies nothing** (no branch, no commit).
  - `autopilot.enabled: true` **AND** `autopilot.apply: true` → the daemon runs
    `runAuto(..., { apply: true })`, letting Phase 6 commit to an isolated `executive/change-<id>`
    branch. `apply: true` while `enabled: false` is meaningless and MUST be treated as OFF (enabled is
    the master switch).
- **`runAuto` is the only actor.** All acting goes through the existing `runAuto`. Do NOT re-implement
  any stage, do NOT call `runWorker`/`runSynth`/`applyChangeSet` directly from the daemon, do NOT bypass
  `runAuto`'s disposition gate. Every guardrail Phase 8 enforces (acts only on `disposition === "act"`,
  never merges, unsafe changeset never applied, failing tests park on the branch) is inherited unchanged.
- **Never merges into the working branch.** Unchanged from Phase 8: applying only ever commits to
  `executive/change-<id>` and returns HEAD to the original branch. The human still does the final merge.
- **Re-trigger guard is mandatory.** The daemon rebuilds state every `state.intervalMs` (default 30 s).
  Without a guard it would re-run the whole LLM chain — and, with `apply`, create a **new branch** — on
  the *same* state every 30 s. The Autopilot MUST run at most once per distinct actionable state
  (dedup by signature) and MUST respect a cooldown between runs. See §6.
- **No overlapping runs.** `runAuto` is async and can be slow (LLM + git). The daemon MUST NOT start a
  new Autopilot run while a previous one is still in flight (a single in-flight lock). A skipped tick is
  correct behaviour, not an error.
- **The daemon never crashes over the Autopilot.** Any throw from `runAuto` is caught, logged to stderr,
  and the daemon keeps observing. An Autopilot failure must never take down the watchers.

### Out of scope (do NOT build)

- No new LLM backend, no new git logic, no new ChangeSet/Proposal/Plan formats.
- No edits to `src/auto/*`, `src/worker/*`, `src/executor/*`, `src/synth/*`, `src/planner/*`,
  `src/state/*`. Phase 9 **calls** `runAuto`; it does not modify it. (If you find yourself needing to
  change `runAuto`, stop — the scope is wrong, flag it.)
- No auto-merge, no PR creation, no pushing to a remote, no notifications/webhooks.
- No SQLite, no server, no new watchers, no new CLI command. Phase 9 adds **no** new subcommand — it only
  changes the behaviour of the existing `watch` daemon and adds one config block.
- No change to the standalone `auto` command's behaviour or to `config.worker.autoInvoke` (leave the
  existing `autoInvoke` Worker-only path alone; the new gates are independent of it).

---

## 1. Data flow (what changes inside the `watch` rebuild cycle)

Today, each rebuild tick (startup + every `intervalMs`) does:

```
buildState → writeState → plan → writePlan → [if worker.autoInvoke] runWorker → writeProposal
```

Phase 9 appends an Autopilot step **after** the existing plan/writePlan, gated + guarded:

```
buildState → writeState → plan → writePlan → [existing autoInvoke path unchanged]
  → if config.autopilot.enabled:
       guard = shouldRunAutopilot(state, plan, guardState, config, now)   // §6
       if guard.run AND not alreadyRunning:
           alreadyRunning = true
           try:
               report = await runAuto({ repoRoot: cwd, config,
                                        apply: config.autopilot.apply === true })
               writeAutoReport(report)
               print a concise Autopilot line to stdout
               update guardState (lastActedSignature, lastActedAt) from the run   // §6
           catch err: stderr "Autopilot failed: <msg>"   // never crash
           finally: alreadyRunning = false
       else: (optionally) a quiet skip — no output, or a debug line
```

`runAuto` internally does its own `buildState`/`plan` again (Phase 8 is self-contained); that double
build is acceptable and intentional — do NOT try to pass the daemon's `built`/`plan` into `runAuto`
(its signature does not take them, and changing it is out of scope). The daemon's own `plan` result is
used **only** to compute the re-trigger signature cheaply before deciding whether to call `runAuto`.

---

## 2. Tech + constraints

- Bun (latest), TypeScript (strict). No new runtime deps.
- Storage: JSON under `.executive/` (reuses `auto-report.json`; no new persisted file required — the
  guard state lives **in memory** in the daemon process, see §6).
- Runs on Windows 11.
- **All tests OFFLINE**: the Autopilot logic under test is the **guard** (`shouldRunAutopilot`) plus the
  gate wiring — both are pure/deterministic and need no network. Do NOT write a test that boots the full
  `watch` daemon or hits the network. A test that hits the network is a defect.
- User-facing strings in Thai or English only (English for code/logs).

### Existing functions/types you MUST import read-only (do not edit their files)

- `runAuto`, `writeAutoReport` from `src/auto/auto.ts`; `AutoReport` from `src/auto/types.ts`.
- `Config` from `src/config.ts`.
- `State` from `src/state/types.ts`; `Plan`, `ProposedAction` from `src/planner/types.ts`.
- `Context` from `src/state/types.ts` (for the latest-seq lookup, if you read it from context).

---

## 3. Files to create / edit

### Create
```
src/auto/
├── guard.ts       # shouldRunAutopilot(...) + AutopilotGuardState + computeSignature(...)  (pure, no I/O)
└── guard.test.ts  # offline unit tests for the guard
```

### Edit
- `src/config.ts` — add a backward-compatible `autopilot` block + defaults + merge (see §4).
- `src/index.ts` — in the `watch` command only: after the existing plan/writePlan (both the startup
  build and the interval build), call the guard + `runAuto` per §1. Add a one-line startup banner stating
  whether the Autopilot is off / dry-run / apply. Keep an in-scope in-memory guard state + in-flight lock
  in the `watch` case.

Do NOT edit any other file. In particular do NOT touch `src/auto/auto.ts`, `src/auto/types.ts`,
`src/worker/*`, `src/executor/*`, `src/synth/*`, `src/planner/*`, `src/state/*`, or `src/paths.ts`.

---

## 4. Config (`src/config.ts` — additive, backward-compatible)

Add to the `Config` interface:

```ts
  /** Continuous-autopilot configuration (defaults applied when absent). OFF by default. */
  autopilot?: {
    enabled?: boolean; // master switch: if true, the watch daemon runs the Autopilot each rebuild. Default false.
    apply?: boolean;   // if true (AND enabled), the daemon lets the Executor commit to an isolated branch. Default false.
    cooldownMs?: number; // minimum ms between two Autopilot runs. Default 300000 (5 min).
  };
```

Add to `defaultConfig()`:

```ts
    autopilot: {
      enabled: false,
      apply: false,
      cooldownMs: 300000,
    },
```

Add to `loadConfig()` (same merge pattern as the `synth`/`executor` blocks):

```ts
  // Merge missing autopilot fields with defaults.
  if (!parsed.autopilot) {
    parsed.autopilot = defaults.autopilot!;
  }
  parsed.autopilot.enabled = parsed.autopilot.enabled ?? defaults.autopilot!.enabled!;
  parsed.autopilot.apply = parsed.autopilot.apply ?? defaults.autopilot!.apply!;
  parsed.autopilot.cooldownMs = parsed.autopilot.cooldownMs ?? defaults.autopilot!.cooldownMs!;
```

**Backward compatibility (must verify):** a config JSON with no `autopilot` key still loads, and
`loadConfig().autopilot` is `{ enabled: false, apply: false, cooldownMs: 300000 }`. No existing field
changes meaning. `config.worker.autoInvoke` is untouched and independent.

---

## 5. Guard types (`src/auto/guard.ts`)

```ts
import type { Config } from "../config.js";
import type { State } from "../state/types.js";
import type { Plan } from "../planner/types.js";

/** In-memory state the daemon keeps between rebuild ticks to avoid re-acting. */
export interface AutopilotGuardState {
  lastActedSignature: string | null; // signature of the state we last ran the Autopilot on
  lastActedAt: number | null;        // Date.now() of the last Autopilot run (start), or null
}

/** A fresh guard state (call once when the daemon starts). */
export function freshGuardState(): AutopilotGuardState {
  return { lastActedSignature: null, lastActedAt: null };
}

/** The decision returned to the daemon. */
export interface GuardDecision {
  run: boolean;       // whether to call runAuto this tick
  signature: string;  // the signature computed for this tick (daemon stores it after a run)
  reason: string;     // short human-readable reason (for the optional skip/act log line)
}
```

### Signature — what counts as "the same state"

```ts
/**
 * A cheap, stable signature of "is there a new actionable situation?".
 * Combines the newest observed event seq with the plan's top action kind+disposition.
 * Same signature ⇒ nothing actionable has changed ⇒ do not re-run.
 */
export function computeSignature(state: State, plan: Plan, latestSeq: number): string {
  const kind = plan.topAction ? plan.topAction.kind : "none";
  const disp = plan.topAction ? plan.topAction.disposition : "none";
  return latestSeq + "|" + kind + "|" + disp;
}
```

- `latestSeq` is the highest event `seq` the daemon has observed this tick. Source it from the built
  `Context` the daemon already has: `context.events.at(-1)?.seq ?? 0` (events are seq-asc). Passing it in
  keeps `computeSignature` pure and testable. If you cannot get it from context, `state`-derived fields
  are an acceptable fallback, but seq is preferred because it is monotonic and cheap.

### The decision

```ts
/**
 * Decide whether the watch daemon should run the Autopilot this tick.
 * Pure — no I/O, no Date.now() inside (the daemon passes `now`).
 */
export function shouldRunAutopilot(args: {
  config: Config;
  state: State;
  plan: Plan;
  latestSeq: number;
  guard: AutopilotGuardState;
  now: number; // Date.now() from the caller
}): GuardDecision;
```

Decision logic — **in this exact order**:

1. If `config.autopilot?.enabled !== true` → `{ run: false, signature, reason: "autopilot disabled" }`.
   (Master switch off. This path should be unreachable in the daemon because the caller only invokes the
   guard when enabled, but keep it defensive.)
2. Compute `signature = computeSignature(state, plan, latestSeq)`.
3. **No actionable action:** if `plan.topAction === null` OR `plan.topAction.disposition !== "act"` →
   `{ run: false, signature, reason: "nothing to act on (…)" }`. (The Autopilot would stop at the plan
   gate anyway; skip the whole chain — and, importantly, skip the LLM call — when the daemon can already
   see it is non-actionable. This is an optimisation **and** a guardrail: no needless Worker calls.)
4. **Dedup:** if `guard.lastActedSignature === signature` →
   `{ run: false, signature, reason: "already acted on this state" }`.
5. **Cooldown:** if `guard.lastActedAt !== null` AND
   `now - guard.lastActedAt < (config.autopilot.cooldownMs ?? 300000)` →
   `{ run: false, signature, reason: "cooldown (<Xms remaining)" }`.
6. Otherwise → `{ run: true, signature, reason: "act: <kind>" }`.

> Note on ordering: dedup (step 4) is checked before cooldown (step 5) so that an unchanged state is
> reported as "already acted", not "cooldown". Both skip; the reason differs for the log.

### Updating guard state after a run (done by the daemon, spec'd here)

After the daemon calls `runAuto` for a tick where `decision.run === true`, it MUST set:
```ts
guard.lastActedSignature = decision.signature;
guard.lastActedAt = <the now it passed to shouldRunAutopilot for this tick>;
```
Set these **whether or not** `runAuto` succeeded — a failed/needs-human run still "consumed" this state;
we do not want to hammer the same failing state every 30 s. (The human sees the failure in
`auto-report.json` / stderr and can change the state.) Use the **same `now`** value for the cooldown
timestamp that you passed into `shouldRunAutopilot`, so the cooldown measures from the start of the run.

---

## 6. Daemon wiring (`src/index.ts`, `watch` case only)

Keep everything inside the existing `case "watch":` block. Add:

1. **Guard state + lock**, declared once before the timer is set up:
   ```ts
   const autopilotGuard = freshGuardState();
   let autopilotRunning = false;
   ```
2. **A single helper** (a local `async function maybeRunAutopilot(built, p)` closure, or inline) called
   from **both** the startup rebuild and the interval rebuild, right after `writePlan(p)` and after the
   existing `worker.autoInvoke` block. It must:
   - Return immediately if `config.autopilot?.enabled !== true`.
   - Return immediately if `autopilotRunning` (an earlier run is still in flight → skip this tick,
     optional stderr/stdout debug line).
   - Compute `latestSeq` from `built.context.events`.
   - `const decision = shouldRunAutopilot({ config, state: built.state, plan: p, latestSeq,
     guard: autopilotGuard, now: Date.now() });` — capture that `now` in a local so you reuse it.
   - If `!decision.run` → optionally print a concise skip line (e.g. `"Autopilot: skip — " +
     decision.reason`) and return. (Skip lines are fine but keep them quiet; do NOT spam every 30 s with
     a multi-line block — one short line max, or nothing.)
   - Else set `autopilotRunning = true`, then in `try/catch/finally`:
     - `try`: `const report = await runAuto({ repoRoot: process.cwd(), config,
       apply: config.autopilot.apply === true });` then `writeAutoReport(report);` then print a concise
       Autopilot summary line (stage, ok, needsHuman, and — if applied — branch + commit + testPassed).
     - `catch (err)`: `process.stderr.write("Autopilot failed: " + (err as Error).message + "\n");`
     - `finally`: update guard state per §5 (`lastActedSignature`/`lastActedAt` using the captured `now`),
       and `autopilotRunning = false`.
   - Because the interval callback is already `async`, `await maybeRunAutopilot(...)` inside it. For the
     startup rebuild (also inside an `async` context), `await` it too.
3. **Startup banner:** after the existing "ExecutiveOS watch started…" lines, print one line describing
   the Autopilot mode:
   - `enabled !== true` → `"Autopilot: OFF (observe + rebuild only)"`
   - `enabled === true && apply !== true` → `"Autopilot: ON — dry-run (proposes, never commits)"`
   - `enabled === true && apply === true` → `"Autopilot: ON — APPLY (commits to executive/change-* branches)"`
4. **SIGINT:** no change needed beyond the existing handler; the in-flight lock means a run either
   finished or will be abandoned on process exit. Do NOT add complex drain logic — out of scope.

**Do not** change the existing `worker.autoInvoke` blocks, the state-rebuild timer interval, the log-file
mirroring, or the watchers. The Autopilot call is strictly additive and gated.

---

## 7. Tests (`src/auto/guard.test.ts`) — required, `bun test`, OFFLINE

Unit-test the **guard** (pure, deterministic — no daemon, no network, no git). Build small `State`/`Plan`
fixtures (import the types; construct minimal literals — you only need `topAction.{kind,disposition}` on
the Plan and whatever `State` requires to typecheck). Cover at minimum:

1. **Disabled → never runs:** `config.autopilot.enabled` false (and also the no-`autopilot` default
   config) → `run: false`, reason "disabled".
2. **Non-actionable → skip:** enabled, `plan.topAction === null` → `run: false`; and enabled,
   `topAction.disposition === "ask"` → `run: false` (reason mentions not-actionable). Confirms the guard
   never green-lights a chain the plan gate would reject.
3. **Fresh actionable → runs:** enabled, `topAction.disposition === "act"`, fresh guard
   (`lastActedSignature: null`, `lastActedAt: null`) → `run: true`, `signature` well-formed.
4. **Dedup:** enabled, actionable, `guard.lastActedSignature === computeSignature(...)` for the same
   `latestSeq`+action → `run: false`, reason "already acted".
5. **New seq bypasses dedup:** same action kind but a **higher `latestSeq`** than the one baked into
   `lastActedSignature` → signature differs → `run: true` (a genuinely new event should re-trigger, even
   if the action kind is unchanged).
6. **Cooldown blocks:** enabled, actionable, a **different** signature from last time (so dedup passes),
   but `now - lastActedAt < cooldownMs` → `run: false`, reason "cooldown".
7. **Cooldown elapsed → runs:** same as 6 but `now - lastActedAt >= cooldownMs` → `run: true`.
8. **Dedup precedence over cooldown:** same signature AND within cooldown → `run: false` with reason
   "already acted" (dedup checked first), not "cooldown".
9. **`computeSignature` stability:** same inputs → identical string; changing `latestSeq`, `kind`, or
   `disposition` each changes the string.

All existing tests (142) must still pass. **No test may perform a network request or spawn git.**

> You are NOT required to write an integration test that boots the `watch` daemon. The daemon wiring is
> verified by the reviewer live (§8). Keep automated tests on the pure guard + config merge.

Optionally add a `config.autopilot` merge assertion to the existing config test suite (if one exists) or
a tiny test in `guard.test.ts` that `loadConfig()` on a config without `autopilot` yields the OFF
default — but do NOT create a whole new config test file.

---

## 8. Acceptance criteria (Claude will verify ALL of these by running them)

- [ ] `bun run typecheck` passes (strict).
- [ ] `bun test` passes — existing 142 + new guard tests, offline.
- [ ] **Default OFF:** with a default `init` config (or an old config lacking `autopilot`), `watch`
      prints `"Autopilot: OFF …"`, and across multiple rebuild ticks it **never** calls `runAuto` (no
      `auto-report.json` is written by the daemon, no `executive/change-*` branch appears). Verified live
      in a temp git repo by letting the daemon tick with a failing-tests state present.
- [ ] **Dry-run mode:** with `autopilot.enabled: true, apply: false` and `worker.backend: "mock"`, a
      failing-tests state → the daemon runs the chain, writes `auto-report.json` with `applied: false`,
      and **creates no branch** / leaves the working tree clean. On the **next** tick with the same state,
      it does **not** re-run (dedup) — `auto-report.json`'s `generatedAt` is unchanged.
- [ ] **Apply mode:** with `autopilot.enabled: true, apply: true` (mock backend), a failing-tests state →
      the daemon creates `executive/change-<id>`, commits, and returns HEAD to the original branch; the
      original branch history is untouched. A subsequent tick on the same state does **not** create a
      second branch (dedup + cooldown).
- [ ] **Cooldown:** after an apply run, a *changed* actionable state within `cooldownMs` is **not** acted
      on until the cooldown elapses (verify with a short `cooldownMs` in config, e.g. 2000, and two ticks).
- [ ] **`apply: true` but `enabled: false` ⇒ OFF** (master switch wins; no runs, banner says OFF).
- [ ] **Ask disposition:** a blocked state with `enabled: true` → the guard reports non-actionable, the
      daemon does **not** call `runAuto` (Worker never invoked), no branch.
- [ ] **No crash on Autopilot error:** if `runAuto` throws (simulate however is convenient — e.g. mock
      backend + a deliberately broken state), the daemon logs to stderr and keeps ticking; SIGINT still
      exits 0.
- [ ] `src/auto/auto.ts`, `src/auto/types.ts`, `src/worker/*`, `src/executor/*`, `src/synth/*`,
      `src/planner/*`, `src/state/*`, `src/paths.ts` are **unchanged** (git diff empty for those paths).
- [ ] `config.worker.autoInvoke` behaviour is unchanged; the new gates are independent of it.
- [ ] `.executive/` (incl. `auto-report.json`) stays gitignored; no runtime data committed.
- [ ] Only the files listed in §3 were created/edited.

---

## 9. Deliverable

A commit containing `src/auto/guard.ts`, `src/auto/guard.test.ts`, the `src/config.ts` additions, the
`src/index.ts` `watch`-case wiring, and this doc. Do NOT commit `.executive/` runtime data. When done,
hand back for review — Claude will run every item in §8 and will NOT trust the self-report.

---

## 10. Design notes (rationale — not extra work)

- **Why two gates, both default false:** the owner's guardrails demand "every action inspectable and
  reversible" and "confidence > 95% → act; otherwise ask". Continuous *observation + proposal* is
  low-risk (produces files to review); continuous *commit* is higher-risk (creates branches). Splitting
  `enabled` (chain runs, dry-run) from `apply` (commits to a branch) lets the owner adopt autonomy in two
  safe steps, and keeps `watch` inert for everyone who never opts in.
- **Why an in-memory guard (not persisted):** the guard only needs to prevent re-acting within a single
  daemon lifetime. On restart, a fresh guard is correct — the owner restarting `watch` is a natural
  "re-evaluate now" signal, and the dedup + cooldown immediately re-establish. Persisting it would add a
  file + reconciliation logic for no real benefit, and is out of scope.
- **Why signature = seq + action:** it answers "has anything actionable changed?" cheaply without diffing
  full state. A new event bumps `seq`; a new *kind* of problem bumps the action. Same seq + same action ⇒
  the owner has not touched anything and the situation is identical ⇒ acting again would just spawn a
  duplicate branch.
- **Why the guard also short-circuits non-`act` plans:** `runAuto` would stop at its own plan gate
  anyway, but calling it every 30 s for an "ask" state still costs a `buildState`/`plan` pass and clutters
  reports. Letting the daemon's already-built plan gate it first is both cheaper and a guardrail (no
  needless Worker calls).
