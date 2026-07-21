# ExecutiveOS

An **event-driven personal "Chief of Staff" runtime**, not a chatbot. Goal: offload boring
decisions to cut the owner's decision fatigue, keeping their brainpower for design, code,
music, reading, philosophy.

## Core principle (do not violate)

**The LLM is a reasoning engine (CPU) only — never the center of the system.** The real system
is an OS: Event Bus + Memory + State + rule-based Planner + Scheduler + Rules. Claude/Qwen are
"Workers" called only when reasoning is needed, not to decide *what* to think about.

Main loop: **Observe → Understand → Predict → Act → Observe again** (continuous, no waiting for prompts).

## Dev workflow (division of labor)

Per task:
1. **Scope** — the architect writes a detailed, context-free spec under `docs/scopes/` (files,
   I/O, data shapes, explicit acceptance criteria).
2. **Implement** — the spec is handed to **claude9arm** (a cheaper Qwen worker) who writes the code.
3. **Review + test for real** — the architect reviews against the scope and *runs* every
   acceptance criterion (never trust the self-report).
4. **Fix** — the architect patches any defect found, then commits.

Keep implementations **strictly inside scope** — every scope has a "What is NOT in scope" section.
Do not add watchers/LLM/DB/servers ahead of their phase.

## Guardrails

- Confidence > 95% → act; otherwise ask.
- The system must **never** decide autonomously: relationships, morality, large spending,
  life-goal changes.
- Every action must be inspectable and reversible.

## Tech stack

Bun → TypeScript (strict) → SQLite → Drizzle ORM → Event Bus → Temporal (optional) →
Claude Code SDK → MCP Server → VSCode Extension.
Phase 1 uses **JSONL** for the event log; SQLite/Drizzle come in a later phase.

## Layout

```
.executive/            # runtime data (gitignored) — created by `init`, not committed
├── config.json
├── events/{git,terminal,editor,system}.jsonl
└── logs/
src/                   # the runtime source
docs/scopes/           # per-phase specs (the contract handed to the implementer)
```

## Two "claude.md" files — don't confuse them

- **`CLAUDE.md`** (this file, repo root) — context for Claude Code working *on* the repo.
- **`.executive/claude.md`** (created by `init`, gitignored) — the *product's* AI Worker identity,
  owner-editable Markdown that becomes the **identity portion** of the Worker's system prompt. Added in
  **Phase 10** (deliberately deferred until the OS brain existed — the vision doc says not to *start*
  there). Default content lives in source (`src/worker/identity.ts` `DEFAULT_IDENTITY`); it is advisory
  to the Worker's reasoning and can never weaken the code-level guardrails.

## Phase status

- **Phase 1 — DONE** (`0484d1f`): runtime skeleton. JSONL EventStore (`append`/`read`/`tail`),
  idempotent `bootstrap`, config, hand-rolled CLI (`init`/`emit`/`tail`), 8 passing tests.
  Spec: `docs/scopes/phase-1-runtime.md`.
- **Phase 2 — DONE** (qwen impl `687a034`, architect review+fixes `2bc3dfc`): monotonic **`seq`**
  (in `.executive/meta.json`) fixes `tail()` ordering; in-process **EventBus** + **StoreSink**;
  **Watcher/WatcherManager**; poll-based **GitWatcher** (`git.commit`/`git.branch_switch`) and
  **FsWatcher** (`editor.save`, ignores `.git`/`node_modules`/`.executive`); `watch` daemon.
  18 passing tests. Spec: `docs/scopes/phase-2-eventbus-watchers.md`. Reviewed live against a temp
  git repo. Fixes: rewrote GitWatcher (was `Bun.spawnAsync` + module state + `stop()` not clearing
  the interval), wired per-event stdout/log output through `attachStoreSink(onPersist)`, made the
  fs ignore segment-aware. **Windows caveat:** graceful SIGINT (exit 0) only on real console Ctrl-C;
  programmatic signals hard-terminate (process still exits, doesn't hang).
- **Phase 3 — DONE** (qwen impl + architect review, this commit): rule-based **State Builder**.
  `buildState(now?)` reads the 4 JSONL logs, sorts by `seq`, and derives a compact **`state.json`**
  (currentProject/Task/deadline, currentFile + recentFiles≤5, git.branch/lastCommit, tests,
  blocked/reason, activity idle) + a larger **`context.json`** (summary + embedded state + last 20
  events seq-asc). Rule: **newest event (highest `seq`) wins** per field. `writeState()` persists
  atomically (temp+rename). New `build-state` CLI + periodic rebuild wired into the `watch` daemon
  (every `state.intervalMs`, default 30000, plus one at startup; `clearInterval` on SIGINT). Config
  gains `state.intervalMs` (backward-compatible merge). 30 passing tests (12 new). Reviewed live:
  scripted `emit`→`build-state` field-exact, gitignore verified. Spec:
  `docs/scopes/phase-3-state-builder.md`. No qwen defects found (only harmless redundant fallback in
  the blocked/unblocked derivation — correct, left as-is).
- **Phase 4 — DONE** (qwen impl + architect review, this commit): rule-based **Planner**. `plan(state,
  context?)` (in `src/planner/`) reads the Phase 3 **`State` only** — never the raw event logs, so new
  watchers plug in without touching it — and answers *"highest-value action now?"* via an ordered rule
  set (`src/planner/rules.ts`): R1 `fix_tests` (tests failing, p100, conf0.97→**act**), R2
  `resolve_block` (p90→ask), R3 `review_deadline` (p70→ask), R4 `resume_task` (idle+task, p40→ask).
  Emits a ranked **`plan.json`** (`topAction` + `actions[]` priority-desc + provenance `basedOnState`).
  **Decides but never executes** (no git/test/commit/LLM — that's Phase 5). Guardrail is a single
  unbypassable `applyGuardrail()`: `disposition = (!forbidden && confidence > 0.95) ? "act" : "ask"`;
  the `forbidden` flag (relationships/morality/spending/life-goals) forces `ask`. New `plan` CLI +
  plan rebuild wired after each state rebuild in the `watch` daemon (no new timer). 45 passing tests
  (15 new). Reviewed live: `plan` field-exact (clean→null, failing+deadline→`fix_tests/act` +
  `review_deadline/ask`), watch plan-refresh, gitignore. Spec: `docs/scopes/phase-4-planner.md`. Only
  cleanup: removed an unused `dirname` import.
- **Phase 5 — DONE** (qwen impl + architect review, commit `be90db9`): **LLM Worker** (`src/worker/`).
  The **first phase the LLM enters**. When — and only when — `plan.topAction.disposition === "act"`,
  `runWorker(context, plan, config)` calls an LLM to turn that action into a concrete **`Proposal`**
  (suggested steps, persisted to `.executive/proposal.json` + `proposals/<id>.json`). **Scope was
  narrowed vs the original "patch/test/commit" idea: the Worker PROPOSES, never EXECUTES** — no
  git/patch/test/commit/shell/repo-reads; its whole input is the Phase 3 `Context`, its whole output a
  Proposal file. Executing a Proposal is a later phase. Backend is a config-selected `Worker`: `mock`
  (deterministic, offline — tests + default of last resort) or `anthropic` (`AnthropicWorker` → POST
  `{baseUrl}/v1/messages`, Anthropic Messages API). **Default backend = the owner's 9arm Qwen gateway**
  (`https://gateway.9arm.co`, model `qwen3.6-35b-a3b`) — a flat-rate shared server, NOT Claude, so the
  runtime spends no Claude quota. The **auth token lives only in the gitignored `.env` / env var named
  by `config.worker.apiKeyEnv` (`EXECUTIVE_WORKER_KEY`)** — never in source; `.env.example` is the
  committed template. Unbypassable guardrail gate in `runWorker` (null / `forbidden` / non-`act` →
  never call the LLM). New `work` CLI + optional Worker call in the `watch` daemon **gated by
  `config.worker.autoInvoke` (default `false` → the daemon never auto-calls the LLM)**. 70 passing
  tests (25 new, 100% offline via MockWorker). Reviewed live against every §11 criterion (clean→no-op,
  failing+mock→`ok` proposal, blocked→ask/no-op, dead-host→`error` proposal + exit 0, autoInvoke off
  vs on, gitignore, no out-of-scope primitives). Spec: `docs/scopes/phase-5-worker.md`. **No qwen
  defects found.** NOT yet run against the live gateway (integration test — spends a real token; left
  for the owner).
- **Phase 6 — DONE** (qwen impl + architect review, commit `2ea716a`): **Executor** (`src/executor/`).
  The **first phase that mutates the repo** — but still **100% deterministic, rule-based, NO LLM**
  (like Phase 3/4). `applyChangeSet(cs, {apply, repoRoot, config})` carries out a **`ChangeSet`**
  (`{id,title,ops[],test,commitMessage}`; ops = `write`/`create`/`delete` file operations) **safely,
  reversibly, and only behind explicit human approval**. Flow: `validate` (pure path-safety gate) →
  `plan` (dry-run, reads disk, mutates nothing) → **dry-run by default**, or on `--apply`: verify git
  repo + **clean working tree** → `checkout -b executive/change-<id>` → write ops → `git add -A` → run
  `test` → **commit on that branch (regardless of pass/fail)** → `checkout` back to the original branch;
  a `try/catch` always returns to the original branch on error. Emits **`.executive/exec-report.json`**.
  **Hard guardrails (all verified live):** never touches the working branch history (work lands only on
  `executive/change-<id>`); refuses on a dirty tree / outside a git repo; rejects `..`-escape /
  absolute / drive-letter / `.git` / `.executive` paths **before** any mutation; reversible via
  `git branch -D`; the owner is the final gate (Executor never merges). New `execute <changeset.json>
  [--apply]` CLI. **NOT wired into the `watch` daemon** — no autonomous execution. Config gains a
  backward-compatible `executor` block (`branchPrefix`, `defaultTestCommand`). 97 passing tests (27
  new, offline; git tests use a temp repo). Reviewed live against every §13 criterion. **Two qwen
  defects found + fixed by the architect:** (1) `planChangeSet` ran before the validation gate → a
  changeset missing `ops` crashed (`cs.ops.length` on undefined) instead of failing cleanly — now
  plans only when validation passes, + a regression test; (2) removed a dead `Config` import. Spec:
  `docs/scopes/phase-6-executor.md`.
- **Phase 7 — DONE** (qwen impl + architect review, this commit): **Synthesizer** (`src/synth/`) —
  the bridge from Phase 5 `Proposal` (prose) to Phase 6 `ChangeSet` (executable file ops), closing
  the Observe→…→Act loop. `runSynth(opts)` loads the latest (or `--proposal <id>`) Proposal, selects
  a bounded set of files (`--files`, else `State.currentFile`+`recentFiles`, capped at
  `config.synth.maxFiles`), calls a `Synthesizer` (`mock` | `anthropic`, **reusing `config.worker`** —
  no new gateway/token) to turn them into a candidate `ChangeSet`, then runs it through Phase 6's
  `validateChangeSet` **before** ever handing it to the Executor, and — only if valid — calls
  `applyChangeSet` in **dry-run only** (`apply: false`, never `true`). Writes
  `.executive/changeset.json` (candidate, always, for inspection) + `.executive/synth-report.json`.
  **The LLM's output is untrusted**: an unsafe path (`..`-escape/absolute/`.git`/`.executive`) is
  rejected by validation and never reaches the Executor, not even dry-run. New `synth [--files a,b]
  [--proposal <id>]` CLI. **NOT wired into the `watch` daemon**; does not touch `src/worker/*` or
  `src/executor/*`. Config gains a backward-compatible `synth` block (`maxFileBytes`, `maxFiles`).
  131 passing tests (34 new, 100% offline via `MockSynthesizer`). Reviewed live against every §11
  criterion in a temp git repo (mock backend, present/missing/non-`ok` proposal, `--files` vs
  State-fallback, old config without a `synth` block still merges defaults, grep confirms only
  `apply: false` in `src/synth/`, `src/worker`/`src/executor` diff is empty). **Defects found + fixed
  by the architect:** (1) two test bugs in `synth.test.ts` — repeated `writeFileSync` to the same
  event-log path truncated instead of appending (only the last event survived, so `recentFiles`
  fallback test saw 1 file instead of 3), and `createTempGitRepo()`'s happy-path tests wrote
  `src/main.ts` *after* the initial commit without ever staging it, so `isWorkingTreeClean` correctly
  failed regardless of `runSynth`'s behavior — fixed by using `appendFileSync` and committing the
  fixture file before asserting a clean tree; (2) a real CLI bug in `src/index.ts` — the `synth`
  command unconditionally printed the `changeset:` / `review … --apply` lines even when
  `changeSetWritten` was `false` (no-proposal, non-actionable-proposal, synthesizer-failure cases),
  misleadingly pointing at a file that was never written, and never surfaced `report.messages` (the
  actual reason) to the user — fixed by branching: print `report.messages` and exit early when
  `!report.changeSetWritten`, otherwise print the full validation/dry-run/changeset summary as before.
  Spec: `docs/scopes/phase-7-synthesizer.md`.
- **Phase 8 — DONE** (qwen impl + architect review, commit `a00fc0f`): **Autopilot** (`src/auto/`) —
  a single `auto` command that chains the whole loop end-to-end (**plan → work → synth → execute**),
  gated by the existing guardrails, so the human's job shrinks to reviewing/merging the isolated branch
  it leaves. It is a **conductor, not a new brain**: `runAuto(opts)` reuses Phase 3/4/5/6/7 exactly
  (no new LLM code, no new git code) and only decides whether to continue between stages. Order: plan →
  **gate** (proceed only if `topAction.disposition === "act"`; `ask`/none → STOP at plan with
  `needsHuman`, never calls the Worker/Synth/Executor) → `runWorker`+`writeProposal` → `runSynth`
  (writes changeset, validates, dry-runs) → **apply gate** (only when validation ok + dry-run all-ops
  succeed) → on `--apply` read `.executive/changeset.json` and `applyChangeSet({apply:true})` (Phase 6
  isolated branch, never merges). **dry-run is default; `--apply` opt-in.** An unsafe changeset is never
  applied even with `--apply` (validation blocks it → no branch). Failing tests → change parked on its
  branch, `ok:false`+`needsHuman:true`. Emits `.executive/auto-report.json`. **No config change**
  (reuses `config.worker`+`config.executor`). **NOT wired into the `watch` daemon** (autonomous
  continuous execution is a later phase — the owner chose the manual `auto` command only). New `auto
  [--apply] [--files a,b]` CLI. 142 passing tests (11 new, offline via MockWorker/MockSynthesizer).
  Reviewed live against every §9 criterion (dry-run→no mutation, `--apply`→branch+commit+HEAD-back,
  clean→nothing-to-do, blocked→ask/needs-human with Worker never called). Cleanup: removed a dead
  `State`/`Context` import + unused `ctx` local. **No functional defects found.** Spec:
  `docs/scopes/phase-8-autopilot.md`.
- **Phase 9 — DONE** (architect impl + review, this commit): **Continuous Autopilot** — the `watch` daemon runs the Autopilot continuously, behind two default-OFF config gates (`config.autopilot.enabled`, `config.autopilot.apply`). It reuses `runAuto` (Phase 8) verbatim: no new LLM/git/plan/proposal/changeset code. New files: `src/auto/guard.ts` (pure guard logic: `computeSignature`, `shouldRunAutopilot`, `AutopilotGuardState` + dedup by signature + cooldown) and `src/auto/guard.test.ts` (16 offline tests). Edits: `src/config.ts` (backward-compatible `autopilot` block + defaults), `src/index.ts` (`watch` case: guard state + in-flight lock, `maybeRunAutopilot` helper called after existing plan/autoInvoke, startup banner). Guard order: disabled check → signature → non-actionable skip → dedup → cooldown → run. Any `runAuto` throw is caught, logged to stderr, daemon keeps ticking. 158 passing tests (16 new). Spec: `docs/scopes/phase-9-continuous-autopilot.md`.
- **Phase 10 — DONE** (qwen impl + architect review, this commit): **Worker Identity**
  (`.executive/claude.md`) — the artifact the vision doc deliberately deferred (build the OS brain first,
  not the LLM's personality). An owner-editable Markdown file becomes the **identity portion** of the
  Worker's system prompt. New `src/worker/identity.ts`: `DEFAULT_IDENTITY` (version-controlled default
  text) + `loadWorkerIdentity()` (reads `.executive/claude.md`, falls back to the default when missing or
  blank-after-trim). `bootstrap()` writes `claude.md` from `DEFAULT_IDENTITY` **only if absent** (never
  overwrites owner edits, same idempotent pattern as `config.json`). `buildSystemPrompt(identity)` now
  composes **identity first, then a fixed `OPERATIONAL_CONTRACT` in code** ("propose, never execute;
  concise steps") — the contract is appended last so a mangled/adversarial `claude.md` can never remove
  it; `buildRequestBody`/`AnthropicWorker` thread `identity` through; `createWorker` loads it for the
  anthropic backend. **`claude.md` is advisory to reasoning ONLY — it cannot weaken any code-level
  guardrail** (`runWorker` gate, Planner `forbidden`, Executor path-safety all stay in code). **Synth
  untouched** (Worker identity only; personality would corrupt its strict-JSON output). No config change,
  no CLI change, MockWorker unchanged. New `claudeMdPath()` in `src/paths.ts`. 165 passing tests (11 new).
  Reviewed live: `init`→`claude.md`=DEFAULT, edit+re-init preserved, end-to-end custom identity appears in
  the system prompt before the contract, gitignored, out-of-scope diff empty. **No qwen defects found.**
  Spec: `docs/scopes/phase-10-worker-identity.md`.
- **Phase 11 — DONE** (qwen impl + architect review, this commit): **Digest / Report layer**
  (`src/report/`) — a single `report` command that reads the existing `.executive/` artifacts and renders
  one concise, human-readable **`.executive/digest.md`** (also printed to stdout), directly serving the
  product goal of cutting decision fatigue. **Pure presentation layer — 100% deterministic, rule-based,
  NO LLM** (same family as State/Planner). `buildDigest(opts?)` reads `state.json` (→ **Now**),
  `plan.json` (→ **Recommended action**), `auto-report.json` (→ **Last Autopilot run**), and
  `exec-report.json`/`proposal.json` (signals for **Needs you**) — **every input optional + untrusted**
  via a defensive `readJson` (missing/malformed → per-section "no data yet", **never throws**).
  `renderDigest(d)` → Markdown; `writeDigest(md)` atomic temp+rename. The **Needs you** section is the
  high-value part: it aggregates four scattered signals into one queue — plan `disposition:"ask"`,
  autopilot `needsHuman`, a parked change (`mode:"apply"`+`committed`+`testPassed:false`), and a worker
  `status:"error"` — deduped by summary. **Read-only:** writes only `digest.md`; no git/LLM/network/
  process; **not wired into the `watch` daemon**; **no external delivery** (email/Slack deliberately
  deferred — outward-facing). No config change. New `report` CLI + `digestPath()` in `src/paths.ts`. 180
  passing tests (15 new, offline). Reviewed live: fresh `init`→placeholder digest, end-to-end
  emit→plan→report shows `fix_tests (act)`, needs-you aggregation per source, gitignored, out-of-scope
  diff empty. **One cosmetic qwen defect found + fixed by the architect:** an unbalanced `)` in the
  confidence line (`… total)_` → `… total_`). Spec: `docs/scopes/phase-11-digest-report.md`.
- **Phase 12 — DONE** (qwen impl + architect review, this commit): **Watch Digest** — wires the Phase 11
  digest into the `watch` daemon so the owner sees "what needs me" live, without running `report` by
  hand. On every rebuild tick, **after the autopilot block**, the daemon refreshes `.executive/digest.md`
  (pure read-only derivation, like `state.json`/`plan.json`) and prints a **concise "Needs you" alert
  only when the queue changes** — quiet by design (same dedup-by-signature discipline as Phase 9). New
  pure helper `needsYouSignature(items)` in `src/report/digest.ts` (order-independent — sorts
  `source|summary` pairs, ignores `detail`; empty queue → `""`). Daemon holds an in-memory
  `lastNeedsSignature`; prints `⚠️  Needs you (N):` + one line per item when the signature goes to a new
  non-empty set, and `✓ Needs-you queue cleared.` on a non-empty→empty transition (the `!== null` guard
  means a queue that *starts* empty prints neither). **Read-only, no LLM, no git, acts on nothing**; the
  digest step is wrapped so any error logs to stderr and the daemon keeps ticking. **No config gate**
  (consistent with state/plan being refreshed unconditionally); `src/config.ts` unchanged. The standalone
  `report` command and the existing `buildDigest`/`renderDigest`/`writeDigest` are unchanged (only
  `needsYouSignature` added). 186 passing tests (6 new). Reviewed live: digest.md refreshed each tick,
  alert printed exactly once across 6 ticks (no spam), `cleared` printed once on unblock, clean start
  silent, out-of-scope diff empty. **No qwen defects found.** Spec: `docs/scopes/phase-12-watch-digest.md`.
- **Phase 13 — DONE** (qwen impl + architect review, this commit): **Full ask-queue in "Needs you"** — a
  surgical correctness fix in the Digest. The "Needs you" plan rule read `plan.topAction` only, so when a
  state was **both** failing-tests (`fix_tests`/`act`, p100) **and** blocked (`resolve_block`/`ask`, p90),
  the top action was `act` and the block was **masked** ("Nothing needs you"). Now `buildDigest` iterates
  **every fired `plan.actions` entry with `disposition:"ask"`** (priority-desc order preserved, dedup by
  summary kept), with a **`[topAction]` fallback** when `actions` is empty/absent (degenerate/malformed
  plan — keeps the existing "Multiple needsYou sources" fixture green and never regresses an `ask` into
  silence). **Recommended action still uses `topAction`** (a different projection — "if I do ONE thing,
  what?"). Only the plan aggregation in `buildDigest` changed; `renderDigest`/`writeDigest`/
  `needsYouSignature`/the `now`/`recommended`/`lastAutopilot` sections/`types.ts`/planner/watch are all
  unchanged (the daemon alert benefits automatically). Still pure/deterministic/NO-LLM/read-only. 190
  passing tests (4 new). Reviewed live end-to-end: failing+blocked → Recommended `fix_tests (act)` **and**
  Needs you lists `resolve_block`; after `unblocked` the item disappears. **No qwen defects found.** Spec:
  `docs/scopes/phase-13-full-ask-queue.md`.
- **Phase 14 — DONE** (qwen impl + architect review, this commit): **Notification log** — makes the
  Phase 12 "Needs you" alert **durable**. The Phase 12 alert is ephemeral stdout — if the owner is not
  watching, it is lost. Now, inside the daemon's existing signature-change block, `diffNeedsYou(prev,
  curr)` (pure, keyed by `source|summary` like `needsYouSignature`) computes items **added**/**resolved**
  and `appendNotifications()` writes one JSONL record each (`{ts, event:"added"|"resolved", source,
  summary, detail?}`) to **`.executive/notifications.jsonl`** (append-only). New `notifications [n]` CLI
  (default 10) reads them back via `readNotifications()` (defensive — skips corrupt lines, `[]` when
  missing). **Local only** — no network/email/webhook/git/LLM (external delivery still deferred as
  outward-facing). **Daemon is the only writer** (transitions are observed over time); `report` stays a
  read-only snapshot and does NOT write notifications. Append is in the existing digest `try/catch`, so a
  write error never crashes the daemon; fires only on a queue change (no per-tick spam). New files
  `src/report/notify.ts` + `notify.test.ts`; edits `src/paths.ts` (`notificationsPath()`) + `src/index.ts`
  (watch wiring adds `lastNeedsItems`; new `notifications` command). No config change; `digest.ts`
  existing functions/planner/worker/executor/synth/auto/bootstrap unchanged. 199 passing tests (9 new).
  Reviewed live: blocked→`[added] plan: … resolve_block` record persists after the daemon stops, then
  `unblocked`→`[resolved]`, exactly 2 records (no spam), `notifications` reads them back, `report`
  appends nothing, empty log → "No notifications yet." **No qwen defects found.** Spec:
  `docs/scopes/phase-14-notification-log.md`.
- **Phase 15 — DONE** (architect impl + self-review, this commit): **Auto-task from git branch** — the
  first "sense it, don't ask for it" step to cut manual `emit`s. The State Builder set `currentTask` only
  from explicit `system.task` events; now, when none is present, it **infers the task from the current
  git branch** (already derived in state) via a new pure `taskFromBranch(branch)` in `src/state/builder.ts`:
  strips a recognized type prefix (`feat/`, `fix/`, …), humanizes separators (`feat/login-page` →
  "login page"), returns `null` for default branches (`main`/`master`/…) and empties. **Explicit
  `system.task` always wins** (branch is a fallback only). Deterministic, no LLM, **no watcher/event
  change** — the existing Phase 2 GitWatcher already emits `git.branch_switch{to}`, so in real use just
  switching to a `feat/xyz` branch while `watch` runs tells the system what you're working on. 207
  passing tests (8 new). Reviewed live: `git.branch_switch → feat/dark-mode` → `report` shows
  `Task: dark mode` with zero manual emit. Implemented directly by the architect (qwen is relayed by the
  owner, who is away). No scope doc (small, in-layer change).
- **Phase 16 — DONE** (architect impl + self-review, this commit): **Auto project from git repo** — like
  Phase 15 but for `currentProject`. The GitWatcher now tags every `git.commit`/`git.branch_switch` event
  with `repo` (the repo folder basename, via a new `repoName()` helper). The State Builder infers
  `currentProject` from the newest git event carrying a `repo` when no explicit `system.task` project
  exists (explicit still wins). Deterministic, no LLM. 210 passing tests (3 new). Reviewed live: one
  `git.commit{repo:"myshi",branch:"feat/dark-mode"}` → `report` shows Project: myshi + Task: dark mode +
  Branch, zero manual emit. Files: `src/watchers/git.ts`, `src/state/builder.ts`, `builder.test.ts`.
- **Phase 17 — DONE** (architect impl + self-review, this commit): **Auto test results via git hook** —
  the last big auto-sensor, so `tests` is captured without manual `emit`. New `install-hooks [--test
  "<cmd>"]` command (`src/hooks/install.ts`) writes a POSIX-sh **`.git/hooks/post-commit`** that runs the
  project's test command and emits `system.test_result` passing/failing from its exit code. Pure
  `renderPostCommitHook(cmd, runtimeEntry)` + `installHooks()` which **refuses to clobber a pre-existing
  non-managed hook** (marker-gated) and overwrites only its own. Test command from `--test` or new
  `config.hooks.testCommand` (default null, backward-compatible merge). Runtime path resolved via
  `Bun.main`. Local/deterministic, no LLM. 215 passing tests (5 new). Reviewed live in a temp git repo:
  `install-hooks --test "true"` → real commit → `report` shows `Tests: passing`; `--test "false"` →
  commit → `Tests: failing` — fully automatic. **Note:** post-commit runs tests synchronously (commit
  already made); fine for fast suites, opt-in by design. Files: `src/hooks/install.ts` + `install.test.ts`,
  `src/config.ts`, `src/index.ts`.
- **Auto-sensing (Phase 15–17):** running `watch` now senses **project + task + branch + files +
  commits** automatically, and `install-hooks` adds **test results** on each commit. Only **blocked** and
  **deadline** still need an explicit `emit` (external facts no watcher can know).
- **Phase 18 — DONE** (architect impl + self-review, this commit): **Local web GUI** — a `ui [--port N]`
  command (default 4317) starts a `Bun.serve` dashboard bound to **127.0.0.1 only**, so the owner can see
  everything and click instead of typing. `src/ui/page.ts` `renderPage()` is a single **self-contained**
  HTML page (inline CSS+JS, no external resources) showing Now / Recommended / Needs you / Last Autopilot,
  auto-refreshing every 5s. `src/ui/server.ts` `startUiServer()` serves `GET /` (page), `GET /api/state`
  (freshens state+plan, returns the Digest + summary), and `POST /api/emit` (**whitelisted** to
  `system.blocked`/`unblocked`/`task`/`test_result` only) — the block/deadline/task buttons emit these, so
  even the un-sensable signals need no typing. Deterministic, no LLM, reuses buildState/plan/buildDigest/
  append. 221 passing tests (6 new; server exercised over a real localhost port with `port: 0`). Reviewed
  live: `ui --port 4399` → `GET /` serves the page, `/api/state` returns the digest, `POST /api/emit`
  block → `blocked:true`, a non-whitelisted type → HTTP 400. Files: `src/ui/page.ts`, `src/ui/server.ts`,
  `src/ui/ui.test.ts`, `src/index.ts`.
- **Phase 19 — DONE** (architect impl + self-review, this commit): **LLM signal inference** — the first
  feature that **deliberately departs from the deterministic core** (behind a default-OFF toggle), so the
  two un-sensable signals (**blocked**, **deadline**) can be *guessed*. `src/infer/` mirrors the Worker
  shape: `Inferer` (`mock` keyword-scan, offline | `anthropic` HTTP, reusing `config.worker`), factory,
  and `runInference(context)` → **`.executive/inferred.json`**. **Guardrail: SUGGESTIONS ONLY** — it never
  emits events or mutates real state; the digest surfaces guesses in a separate **"Suggestions
  (unconfirmed)"** section (and the GUI card), shown **only when they add info** (block guess suppressed
  if already blocked; deadline guess suppressed if a deadline is set), and the owner confirms via the
  existing `emit`/GUI buttons. New `infer` CLI; wired into the `watch` daemon behind **`config.infer.enabled`**
  (default false) + `cooldownMs` + in-flight lock, fire-and-forget so a slow/failed call never blocks the
  tick. `config.infer` block (backward-compatible). 236 passing tests (15 new, offline via MockInferer +
  parse tests). **First phase VALIDATED LIVE against the real 9arm Qwen gateway:** discovered Qwen3.6's
  "thinking" consumes the token budget → `content:[]`/`stop:max_tokens` at 1024; fixed by an inference
  max_tokens floor of 3072 (+60s timeout) in the factory — then a real `infer` correctly guessed
  `block: waiting on Stripe API key` + `deadline: 2026-08-01`, surfaced in `report`. Files: `src/infer/*`,
  `src/config.ts`, `src/paths.ts`, `src/report/{types,digest}.ts`, `src/ui/page.ts`, `src/index.ts`.
- **Phase 20 — DONE** (architect impl + self-review + live validation, this commit): **Reasoning-model
  headroom fix + polish.** (1) **Latent bug fixed:** the Worker (Phase 5) and Synthesizer (Phase 7) used
  `config.worker.maxTokens` (was 1024) — too small for a reasoning model (Qwen) that spends output tokens
  "thinking" before the answer, so a real call returned `content:[]`/`stop:max_tokens` and errored. Both
  were only ever run against the mock backend, so this was never caught. Added shared `llmMaxTokens(config,
  floor=4096)` + `llmTimeoutMs(config, floor=120000)` in `src/config.ts`, used by the worker, synth, and
  infer factories; bumped `defaultConfig` worker `maxTokens 1024→4096`, `timeoutMs 30000→120000`.
  **Validated LIVE against the real 9arm Qwen gateway:** `work` now returns a real multi-step proposal;
  `synth` calls the gateway, parses a ChangeSet, and validation runs (a toy fixture produced an empty-ops
  changeset, correctly rejected — model-quality, not the token bug). (2) **Polish:** `init` now adds
  `.executive/` to the repo's `.gitignore` when run inside a git repo (idempotent; never duplicates;
  never fails init). 236 passing tests (unchanged; the fix is in live-only paths). Files: `src/config.ts`,
  `src/worker/factory.ts`, `src/synth/factory.ts`, `src/infer/factory.ts`, `src/index.ts`.
- **Phase 21 — DONE** (architect impl + self-review + live validation, this commit): **GUI polish** — the
  two remaining nice-to-haves. (1) **Confirm buttons for LLM suggestions:** `Digest.suggestions` is now a
  structured `Suggestion[]` (`{kind, text, emit:{type,data}}`) instead of `string[]`; the GUI renders a
  **Confirm** button per suggestion that POSTs the exact `emit` (block guess → `system.blocked{reason}`,
  deadline guess → `system.task{deadline}`) — one click turns a guess into a confirmed signal. Deadline
  suggestions surface only when the model gave a concrete date (actionable). `renderDigest` uses
  `s.text`. (2) **`ui` also runs the watchers:** the `ui` command now starts the git + fs watchers by
  default (opt out with `--no-watch`) so activity is captured while the dashboard is open — one command
  instead of `ui` + `watch`. 236 passing tests (suggestion tests updated to the structured shape).
  Reviewed live (8/8): the page has the Confirm handler, `/api/state` returns structured suggestions with
  the emit payload, confirming a block guess flips `now.blocked` and clears the suggestion, and a commit
  made while `ui` runs is captured (project + branch appear). Files: `src/report/{types,digest}.ts`,
  `src/report/digest.test.ts`, `src/ui/page.ts`, `src/index.ts`.
- **Phase 22 — DONE** (architect impl + self-review + live validation, this commit): **Proactive Advisor
  / proposal queue** — the "chief of staff" turn: instead of only answering, the system **proposes** small
  reversible actions (work AND life) for the owner to **approve / dismiss** (optionally editing first).
  `src/advisor/`: `Advisor` (mock offline | anthropic, reusing `config.worker` + the Phase-20 token
  headroom), a `Proposal` queue persisted to **`.executive/advisor.json`** with add-dedup-by-title + a
  `maxOpen` cap, and `runAdvisor` (generate → enqueue) + `decideProposal` (approve/reject, applies the
  owner's edit/note, and logs approvals to the notification log). **Guardrail: PROPOSES ONLY** — approval
  is always a human click; the LLM prompt forbids proposing relationships/morality/large-spending/
  life-goal changes; approving records the decision (it has no hands for irreversible real-world actions).
  New CLI `propose` + `proposals`; GUI **"Decisions for you"** cards (Approve/Dismiss + editable action &
  note) via `/api/proposals`, `/api/propose`, `/api/proposal/decide`; daemon wiring behind
  **`config.advisor.enabled`** (default false) + cooldown + in-flight lock. `config.advisor` block
  (backward-compatible). 247 passing tests (11 new, offline via MockAdvisor). **Validated live against the
  real 9arm Qwen gateway:** `propose` returned 3 concrete cross-domain proposals (Work: run failing tests
  / Health: 5-min break / Admin: log debugging attempts), each small + reversible; GUI round-trip
  (propose→list→approve-with-note→pending shrinks) verified offline. Files: `src/advisor/*`,
  `src/config.ts`, `src/paths.ts`, `src/ui/{server,page}.ts`, `src/index.ts`.
- **Phase 23 — DONE** (architect impl + self-review + live, this commit): **Voice/text capture (own-voice,
  visible).** A `capture <note>` CLI emits `system.note{msg,via}` (fed to the Advisor's context), and the
  dashboard gains a **Listening** card: a user-initiated Web Speech push-to-talk that transcribes **the
  owner's own dictation** and posts each final utterance as `system.note`. `system.note` added to the
  GUI emit whitelist; new `GET /api/config` serves the `config.capture` block; `config.capture`
  (`enabled`/`from`/`to`, default off, 09:00–18:00) with an optional auto-start during work hours.
  **Ethical boundary (held, and re-affirmed when the owner asked to make it covert):** the listening state
  is **always shown on screen (“🔴 Listening…”)** and off by default — the runtime will **not** ship a
  hidden/always-on ambient recorder, because in a shared workplace that captures **coworkers who never
  consented**, and an on-screen indicator on the owner's laptop does not inform those third parties. The
  supported use is intentional self-dictation, not covert room capture. 250 passing tests (3 new — config
  endpoint, `system.note` emit, page has the listening/proposals UI; Web Speech itself is browser-only).
  `capture` verified live (Thai note logged). Files: `src/config.ts`, `src/ui/{server,page}.ts`,
  `src/index.ts`.
- **Phase 24 — DONE** (architect impl + self-review): **Whisper multilingual transcription** — the dashboard mic
  now routes through a configurable Whisper-compatible `/v1/audio/transcriptions` endpoint instead of browser
  Web Speech, for proper Thai↔English code-switching. `config.transcribe` block (`enabled`/`baseUrl`/`model`/
  `apiKeyEnv`/`language`, default off); `GET /api/config` exposes only `{ transcribe: { enabled } }` (never
  leaks key/baseUrl); `POST /api/transcribe` is a server-side proxy that forwards audio as multipart with
  `Authorization: Bearer <key>` read from `process.env[apiKeyEnv]`; the page uses `MediaRecorder` when
  `transcribe.enabled` is true, falls back to Web Speech when false; the "🔴 Listening…" indicator stays
  intact. 251 passing tests (1 new — `/api/transcribe` not-configured guard).
  This is scaffolding only — needs the owner to supply a real Whisper-compatible endpoint + key to validate
  live (the 9arm gateway is LLM-only, no audio endpoint). Files: `src/config.ts`, `src/ui/{server,page}.ts`,
  `src/index.ts`. Spec: `docs/scopes/phase-24-whisper.md`.
- **Phase 25 — DONE** (architect impl + self-review + live-validated where possible, this commit):
  **Transcription backends + Settings.** Phase 24 had a single on/off Whisper path; the owner wanted to
  **choose the backend and edit it from the dashboard**, keeping Web Speech as an option. Now
  `config.transcribe.mode` picks among **three backends** (all opt-in, `webspeech` default): `webspeech`
  (browser SpeechRecognition, no key), `whisper-api` (POST audio → local `/api/transcribe` → a configurable
  OpenAI-compatible endpoint — covers **Groq** cloud free-tier AND a **self-hosted faster-whisper** server,
  offered as one-click **presets**), and `browser-wasm` (Whisper runs **in the browser** via transformers.js;
  lib + model served from `127.0.0.1` so **audio never leaves the machine**). Config is **backward-compatible**
  (a Phase-24 `enabled:true` with no `mode` derives `mode:"whisper-api"`); `updateTranscribeConfig(patch)`
  writes **only the transcribe block**, whitelisted + validated, atomically. New endpoints: `POST
  /api/settings` (persist a transcribe patch), `POST /api/transcribe/download` + `GET
  /api/transcribe/status` (fetch/serve the browser-wasm assets), static `GET /vendor/*` + `/models/*`
  (path-safety enforced). `GET /api/config` now returns the full transcribe block (**which holds no secret —
  the key lives only in `process.env[apiKeyEnv]`**) + the presets; the old "never leak the key" guarantee is
  preserved and tested (the key VALUE never appears in any response). New `src/ui/models.ts`
  (`downloadWasmAssets`/`wasmAssetsStatus`: lists via HF + jsDelivr, downloads into `.executive/vendor` +
  `.executive/models`, idempotent + path-safe), `modelsDir()`/`vendorDir()` in `src/paths.ts`, a dashboard
  **Settings card** (mode selector + fields + presets + Save + Download), the mic routes by mode, and a new
  `download-model [id]` CLI. Same listening ethics (own-voice, **visible "🔴 Listening…"**, off by default);
  the page stays **self-contained** (only same-origin `/vendor`,`/models`,`/api/*` — presets fetched at
  runtime, never hardcoded). 260 passing tests (10 new). **Live-validated:** the vendor download runs for
  real (transformers.web.js + `ort-…jsep.wasm` land in `.executive/vendor`), static serving returns 200 +
  correct content-type, `/api/settings` round-trips + persists, `download-model` exits 1 cleanly on a bad id,
  HF/jsDelivr listings parse. **Not verifiable here (browser + big download, left to the owner, same status
  as Web Speech):** the in-browser transformers.js transcription itself, a full ~100MB model pull, and a
  live Groq/local endpoint with a real key. Spec: `docs/scopes/phase-25-transcription-backends.md`. Files:
  `src/config.ts`, `src/paths.ts`, `src/ui/{models,server,page}.ts`, `src/ui/ui.test.ts`, `src/config.test.ts`,
  `src/index.ts`.
- **Phase 25.1 — DONE** (architect fix + live-validated, this commit): **Minimal-set model download.** The
  owner clicked "Download" in the dashboard before the browser-wasm path had been exercised, which surfaced
  two real defects in `downloadWasmAssets`: (1) it fetched **every** onnx variant a Whisper repo ships
  (fp16/int8/bnb4/q4/quantized/uint8/merged/with_past…) → **~1.6GB** for `Xenova/whisper-base`; (2) it also
  pulled the unused `transformers.node.*` builds. Now `downloadModel` fetches ONLY the encoder +
  `decoder_model_merged` for a single dtype (`WASM_DTYPE = "q8"` → the `_quantized` files, via a
  `DTYPE_SUFFIX` map, fp32 fallback) plus the small non-onnx configs/tokenizers → **~81MB**; `downloadVendor`
  skips `.node.` builds; and `wasmAssetsStatus` now requires **both** an `encoder_model*` and a
  `decoder_model_merged*` on disk (a partial download that grabbed only decoders correctly reports
  not-ready). The page's `pipeline(...)` passes the matching `{ dtype: "q8" }`. **Live-validated:** a clean
  re-download is 16 files / 81MB (`encoder_model_quantized.onnx` 23MB + `decoder_model_merged_quantized.onnx`
  52MB + tokenizer/configs), `wasmAssetsStatus` → `{libReady:true, modelReady:true}`. Still browser-only for
  the actual in-page transcription. 260 tests green. Files: `src/ui/{models,page}.ts`.
- **Phase 25.2 — DONE** (architect fix + **live browser validation via Playwright**, this commit): the
  browser-wasm path is now **verified end-to-end in a real Chromium**, not just "files on disk". Driving the
  dashboard with Playwright + Chromium fake audio (`--use-file-for-fake-audio-capture` fed the classic
  `jfk.wav`) surfaced two real defects in the page's wasm loader: (1) it imported `transformers.web.js`,
  which is the **bundler build** with bare `import"onnxruntime-common"/"onnxruntime-web"` specifiers a plain
  browser can't resolve → "Failed to resolve module specifier" — fixed to import **`transformers.min.js`**
  (the self-contained web bundle with onnxruntime inlined; `models.ts` `libReady` checks it too); (2) the web
  build defaults `env.allowLocalModels=false`, so with `allowRemoteModels=false` it refused everything
  ("both local and remote models are disabled") — fixed by setting **`env.allowLocalModels=true`** alongside
  `allowRemoteModels=false` + `localModelPath="/models/"`. After the fix the full flow works: fake JFK audio
  → MediaRecorder → `decodeAudioData` → transformers.js pipeline (**WASM CPU, WebGPU absent in headless,
  fully offline from `/vendor`+`/models`**) → correctly transcribed *"…my fellow America ask not what your
  country can do for you…"* → emitted `system.note{via:"voice"}`. So **all four transcription modes are now
  real**: webspeech + whisper-api (config/endpoints tested) and browser-wasm (**end-to-end browser-tested**);
  only a live Groq/local key remains owner-supplied. 260 tests green. Files: `src/ui/{page,models}.ts`.
- **Loop complete (manual trigger):** `auto --apply` runs the whole chain in one command; the human
  reviews/merges the `executive/change-<id>` branch.

## Commands

```
bun run src/index.ts init                          # create .executive/ (+ meta.json)
bun run src/index.ts emit <source> <type> [json]   # append an event (gets a seq)
bun run src/index.ts tail [n] [source]             # show last n events (seq order)
bun run src/index.ts build-state                   # derive state.json + context.json from events
bun run src/index.ts plan                          # build state + derive plan.json (rule-based)
bun run src/index.ts work                          # build state + plan, then run the Worker if actionable → proposal.json
bun run src/index.ts execute <changeset.json> [--apply]  # apply a ChangeSet on an isolated branch (dry-run without --apply)
bun run src/index.ts synth [--files a,b] [--proposal <id>]  # synthesize a ChangeSet from the latest Proposal (dry-run; does NOT apply)
bun run src/index.ts auto [--apply] [--files a,b]   # run the whole chain plan→work→synth→execute (dry-run without --apply)
bun run src/index.ts report                         # render a human-readable digest of the current state → digest.md
bun run src/index.ts notifications [n]              # show the last n "Needs you" notifications (daemon-logged)
bun run src/index.ts install-hooks [--test "<cmd>"] # install a git post-commit hook that auto-emits test results
bun run src/index.ts ui [--port N] [--no-watch]     # local web dashboard + git/file watchers (Ctrl-C to stop)
bun run src/index.ts infer                          # LLM guesses block/deadline (suggestions only) → inferred.json
bun run src/index.ts propose                        # Advisor proposes proactive actions → advisor.json queue
bun run src/index.ts proposals                      # list pending proposals awaiting approval
bun run src/index.ts capture <note>                 # capture a quick note (feeds the Advisor); GUI also does this by voice
bun run src/index.ts download-model [id]            # fetch a browser-wasm Whisper model for offline transcription
bun run src/index.ts watch                          # start the watcher daemon (Ctrl-C to stop)
bun run typecheck                                  # tsc --noEmit
bun test                                           # unit tests
```

## Notes

- The original vision doc is `read_it_my_bro.md` (Thai).
- The owner cannot read Chinese — respond in Thai or English only.
