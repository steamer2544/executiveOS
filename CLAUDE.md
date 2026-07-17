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
- **`.executive/claude.md`** (does not exist yet) — the *product's* AI Worker identity. It is a
  **Phase 5** artifact; the vision doc explicitly says not to start there. Do not create it early.

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
- **Phase 7 — next**: the bridge — turn a Phase 5 `Proposal` (prose) into a Phase 6 `ChangeSet`
  (executable file ops), closing the Observe→…→Act loop. Likely re-invokes the Worker in a structured
  mode; first phase where reasoning output feeds repo mutation.

## Commands

```
bun run src/index.ts init                          # create .executive/ (+ meta.json)
bun run src/index.ts emit <source> <type> [json]   # append an event (gets a seq)
bun run src/index.ts tail [n] [source]             # show last n events (seq order)
bun run src/index.ts build-state                   # derive state.json + context.json from events
bun run src/index.ts plan                          # build state + derive plan.json (rule-based)
bun run src/index.ts work                          # build state + plan, then run the Worker if actionable → proposal.json
bun run src/index.ts execute <changeset.json> [--apply]  # apply a ChangeSet on an isolated branch (dry-run without --apply)
bun run src/index.ts watch                          # start the watcher daemon (Ctrl-C to stop)
bun run typecheck                                  # tsc --noEmit
bun test                                           # unit tests
```

## Notes

- The original vision doc is `read_it_my_bro.md` (Thai).
- The owner cannot read Chinese — respond in Thai or English only.
