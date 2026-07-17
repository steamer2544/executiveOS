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
.executiveOS/            # runtime data (gitignored) — created by `init`, not committed
├── config.json
├── events/{git,terminal,editor,system}.jsonl
└── logs/
src/                   # the runtime source
docs/scopes/           # per-phase specs (the contract handed to the implementer)
```

## Two "claude.md" files — don't confuse them

- **`CLAUDE.md`** (this file, repo root) — context for Claude Code working *on* the repo.
- **`.executiveOS/claude.md`** (does not exist yet) — the *product's* AI Worker identity. It is a
  **Phase 5** artifact; the vision doc explicitly says not to start there. Do not create it early.

## Phase status

- **Phase 1 — DONE** (`0484d1f`): runtime skeleton. JSONL EventStore (`append`/`read`/`tail`),
  idempotent `bootstrap`, config, hand-rolled CLI (`init`/`emit`/`tail`), 8 passing tests.
  Spec: `docs/scopes/phase-1-runtime.md`.
- **Phase 2 — DONE** (qwen impl `687a034`, architect review+fixes `2bc3dfc`): monotonic **`seq`**
  (in `.executiveOS/meta.json`) fixes `tail()` ordering; in-process **EventBus** + **StoreSink**;
  **Watcher/WatcherManager**; poll-based **GitWatcher** (`git.commit`/`git.branch_switch`) and
  **FsWatcher** (`editor.save`, ignores `.git`/`node_modules`/`.executiveOS`); `watch` daemon.
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
- **Phase 4 — next**: rule-based Planner ("highest-value action now?"). Still no LLM.

## Commands

```
bun run src/index.ts init                          # create .executiveOS/ (+ meta.json)
bun run src/index.ts emit <source> <type> [json]   # append an event (gets a seq)
bun run src/index.ts tail [n] [source]             # show last n events (seq order)
bun run src/index.ts build-state                   # derive state.json + context.json from events
bun run src/index.ts watch                          # start the watcher daemon (Ctrl-C to stop)
bun run typecheck                                  # tsc --noEmit
bun test                                           # unit tests
```

## Notes

- The original vision doc is `read_it_my_bro.md` (Thai).
- The owner cannot read Chinese — respond in Thai or English only.
