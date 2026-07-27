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

**The authoritative, detailed phase log is `docs/phase-log.md`** — every entry with the defects found
in review, the sabotage checks, the live-validation results and the delegation notes. It was split out
of this file on 2026-07-27, when `CLAUDE.md` crossed Claude Code's **150k-char auto-load limit** (and a
headless `claude-9arm` was dying with `ContextWindowExceededError` at 99k input tokens *before doing any
work* — see the delegation notes in `HANDOFF.md` §3). **Append new phase entries to `docs/phase-log.md`,
not here.** The table below is only the map.

Current state: **DONE through Phase 46.** 956 passing tests + **three** opt-in browser e2e
(`test:e2e`, `test:e2e:chat`, `test:e2e:ia`). The live runtime is on the **sqlite** event backend,
Discord is live, screen-sensing Layer 2 is live. Details and the current queue are in `HANDOFF.md`.

| # | Phase | What it added |
|---|-------|---------------|
| 1 | Runtime skeleton | JSONL EventStore (`append`/`read`/`tail`), idempotent `bootstrap`, config, hand-rolled CLI |
| 2 | EventBus + Watchers | monotonic `seq` (`meta.json`), in-process EventBus + StoreSink, Git + Fs watchers, `watch` daemon |
| 3 | State Builder | `state.json` / `context.json` derived from the logs; **newest `seq` wins** per field |
| 4 | Planner | ordered rule set → ranked `plan.json`; one unbypassable `applyGuardrail()` (act/ask). Decides, never executes |
| 5 | LLM Worker | the first phase the LLM enters; an `act` action → a prose **Proposal**. `mock` \| `anthropic` (the 9arm Qwen gateway) |
| 6 | Executor | applies a **ChangeSet** on an isolated `executive/change-<id>` branch; dry-run by default, path-safety gate, never merges |
| 7 | Synthesizer | Proposal → ChangeSet, **validated before** the Executor sees it; dry-run only. LLM output is untrusted |
| 8 | Autopilot | `auto` chains plan→work→synth→execute behind the existing gates; `--apply` opt-in |
| 9 | Continuous Autopilot | `auto` inside the `watch` daemon behind two default-off gates + dedup-by-signature + cooldown |
| 10 | Worker Identity | owner-editable `.executive/claude.md` persona; the `OPERATIONAL_CONTRACT` is appended **in code** so it can't be removed |
| 11 | Digest / Report | `report` → `digest.md`, incl. the aggregated **"Needs you"** queue. Pure presentation, no LLM |
| 12 | Watch Digest | the daemon refreshes the digest each tick and alerts **only when the queue changes** |
| 13 | Full ask-queue | every fired `ask` action reaches "Needs you", not just `topAction` (a block was being masked by failing tests) |
| 14 | Notification log | durable `notifications.jsonl` of "Needs you" transitions + a `notifications` CLI |
| 15 | Auto-task | infer `currentTask` from the git branch name (explicit `system.task` still wins) |
| 16 | Auto-project | infer `currentProject` from the git repo (the watcher tags every git event with `repo`) |
| 17 | Auto test results | `install-hooks` → a post-commit hook that emits `system.test_result` from the test command's exit code |
| 18 | Local web GUI | `ui` → a `Bun.serve` dashboard on 127.0.0.1 with a **whitelisted** emit endpoint |
| 19 | LLM signal inference | guess `blocked`/`deadline` → `inferred.json`, **suggestions only**, default off |
| 20 | max_tokens headroom | reasoning models spend output tokens *thinking*; shared `llmMaxTokens`/`llmTimeoutMs` floors. Fixed a latent Worker+Synth bug the mock-only tests never caught |
| 21 | GUI polish | Confirm buttons turn a suggestion into a real emit; `ui` also runs the watchers |
| 22 | **Proactive Advisor** | a proposal queue (`advisor.json`) + Approve/Dismiss cards + `propose`/`proposals` CLI + a daemon toggle. Proposes only |
| 23 (+.1/.2) | Voice/text capture | `capture` CLI + a **visible**, own-voice push-to-talk (hold Space) → `system.note`. No hidden ambient recording, ever |
| 24 | Whisper transcription | `config.transcribe` + a server-side `POST /api/transcribe` proxy (the key never reaches the page) |
| 25 (+.1–.4) | Transcription backends | `webspeech` \| `whisper-api` \| `browser-wasm` + a Settings card; the wasm path is proven end-to-end in a real Chromium |
| 26 (+26.1) | **Multi-repo watching** | `config.watch.repos[]` → one watcher pair per repo; `activeRepo` = highest-seq repo-tagged event; `state.repos[]` |
| 27 | **Approve → Execute** | approving an *executable code* proposal runs Synth→Executor onto an isolated branch; `sanitizeExecutable()` forces life/money/relationship proposals to record-only |
| — | FsWatcher temp-file fix | `isIgnoredPath()` ignores dotfiles/dot-dirs, `.tmp.` infixes and backup suffixes (temp scratch was sticking as `currentFile`) |
| 28 | **Screen-sense Layer 1** | a `screen.window{title,app}` watcher — the 5th event source. No LLM, no image. `CharSet.Unicode` so Thai titles survive |
| 29 (+.1/.2) | **Screen-sense Layer 2 + 3** | screenshot → on-device OCR, or `qwen-vl-max` vision → **suggestions only**. Layer 3 is **403 at the gateway**. Failure honesty: an outage no longer reads as "no signal" |
| 30 | State coherence | `currentFile` pruned to files that still exist on disk; an empty `system.task` now **clears** |
| 31 | **Tesseract OCR engine** | `engine = winrt \| tesseract` + `languages`; Layer 2 finally reads Thai (no `th-TH` WinRT pack exists, and never will) |
| 32 (+32.1) | **Signal hygiene + compaction** | five fixes read off the real event log (`normalizeTitle`, clearable deadline, `judgeNote`, Advisor intent-dedup) + `compact`, which rewrites history with the **same pure predicates as the live path** |
| 33 (+33.1) | **Signal → Judgment** | a real bug — `ui` never persisted `digest.md` (→ `tick.ts`, shared by both daemons); `State.patterns` + 3 pattern rules, every threshold calibrated against the real log; Advisor proposals must cite checkable evidence |
| 34 (+.1/.2) | **Autonomy toggles + robustness** | an Autonomy card that re-reads config every tick; `renameOverwrite` in `src/fs-atomic.ts` on **all 17** temp+rename sites; `idleTimeout` derived from the LLM timeout |
| 35 | **Jarvis layer — chat with hands** | `src/agent/`: 9 read + 5 write tools over existing code; **every write parks for a confirm**; two tool-call protocols; `edit_files` reuses Synth→Executor |
| 36 (+LIVE) | **Proactive nudges over Discord** | the system speaks first: a **pure** `decideNudge` rule engine + a hand-rolled zero-dep Discord adapter (`ownerId` is an auth boundary). One brain — a DM reply enters the same conversation |
| 37 | **Any-repo reach** | repo discovery by basename (unknown → `null`, replacing a silent wrong-repo fallback), `list_repos`, `repo` arg; chat markdown; a **secrets gate** on `.env`/keys/`.ssh` |
| 38 | **Sandbox `run_command`** | pure `classifyCommand` → deny/allow/ask, with a **denylist in code, not config**, refused even after the owner confirms; `NEVER_TRUSTABLE = {run_command, edit_files}` |
| — | Discord UX + session trust | replies chunked to ≤2000 chars, `type:7` button feedback, and **"ไว้ใจทั้งแชทนี้"** — session-scoped trust that resets on clear |
| 39 (+39.1) | **State decay / TTL** | only **manually-asserted** signals age out (blocked 24 h, task/project 72 h); auto-sensed ones never do. Deadline decay is opt-in + default off |
| 40 | **SQLite event storage** | `EventBackend` (`jsonl` \| `sqlite`) behind an unchanged `append`/`read`/`tail`; `bun:sqlite`, no new dependency; `seq` allocation deliberately stayed in `seq.ts`. **The live runtime runs on sqlite** |
| — | Agent gateway fixes | the temperature-0 think-loop (→ Qwen's recommended sampling), chat retry + honest Thai errors, and the budget ladder later **inverted into a context ladder** |
| 41 | **"Make me a file" works** | the gateway's **~125 s wall clock** × 33–48 tok/s ⇒ ~4,000 output tokens is a *physical* ceiling → `CONTEXT_LADDER`; new `save_file`; `run_command` had **never worked on Windows** (`sh -c`) |
| 42 (+42.1) | **Nudge quality** | the nudge sentence was built from an **internal dedup key** (the model read "needs your call" as a phone call). One shared `needsYouLabel()` for all four render sites; a readable `answered`/`expired` signal |
| 43 | **Config backup on every write** | one `writeConfigFile()` choke point → a `config-genesis.json` written once and never rotated + 10 rotating snapshots. Never throws, no restore command on purpose |
| 44 | **Working pattern surfaced** | `formatPatterns()` renders the numbers the Planner and Advisor already reason over, in **human units**, as a digest line + a Now-card row |
| 45 | **Dashboard information architecture** | the page was 4,766px (5.5 screens) with **one unbounded card at 43%** and the answer — empty — at 3.9%, measured with Playwright, not guessed. Answer first (`Where you are` → a merged `answerCard` that collapses to one line when there is nothing to say), the proposal queue bounded at 3 (**count, never detail** — the evidence line survives), config collapsed with state in the header, two width breakpoints. `top 3652→119`, page `4766→1739`, queue `2039→870`. The `🔴` indicator stays **outside** the collapsible body |
| 45.1 | **Phase 45 measured on real data** | the synthetic fixture was optimistic — real proposals carry 44–196 char evidence lines (it used ~62) and the real `Now` card is 423px, so the answer's last block fell below the fold, *the same failure one card along*. Answer now **first**; e2e fixture uses real field lengths; criterion 4a re-baselined to a >2× reduction with the derivation in the test, and the goal asserted **structurally** instead |
| 46 | **The Advisor was a no-op loop** | found in the live runtime: `enabled`, 10-min cooldown, `maxOpen: 8`, **pending exactly 8** → `addDrafts` broke on the first draft of every run while `runAdvisor` called the gateway first. **~144 wasted calls/day for 3.5 days**, and the pre-Phase-33 generic items holding the queue shut were blocking the grounded ones. Capacity gate before the call + `expireStale` → a new `expired` status (default 3 days, record kept, Phase 39's rule) + `skipped` surfaced at all four call sites. Live: the queue reopened and 3 checkably-grounded proposals appeared at once. Plus `stripBom` — a BOM'd `config.json` read as "malformed" |
| — | Candidate B | the Tesseract language list is picked from the **window title** (Thai in title → `tha+eng`, else `eng`, unknown → `tha+eng`). The load-bearing part was making the config default the sentinel `"auto"` |

- **Auto-sensing (Phase 15–17):** running `watch`/`ui` senses **project + task + branch + files +
  commits** automatically, and `install-hooks` adds **test results** on each commit. Only **blocked**
  and **deadline** still need an explicit `emit` (external facts no watcher can know).
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
bun run src/index.ts migrate-events [--apply]       # copy the JSONL event logs into .executive/events.db (dry-run without --apply)
bun run src/index.ts install-hooks [--test "<cmd>"] # install a git post-commit hook that auto-emits test results
bun run src/index.ts ui [--port N] [--no-watch]     # local web dashboard + git/file watchers (Ctrl-C to stop)
bun run src/index.ts infer                          # LLM guesses block/deadline (suggestions only) → inferred.json
bun run src/index.ts propose                        # Advisor proposes proactive actions → advisor.json queue
bun run src/index.ts proposals                      # list pending proposals awaiting approval
bun run src/index.ts chat "<message>"               # talk to the agent (reads real state, can act; writes ask first)
bun run src/index.ts capture <note>                 # capture a quick note (feeds the Advisor); GUI also does this by voice
bun run src/index.ts download-model [id]            # fetch a browser-wasm Whisper model for offline transcription
bun run src/index.ts watch                          # start the watcher daemon (Ctrl-C to stop)
bun run typecheck                                  # tsc --noEmit
bun test                                           # unit tests
```

## Notes

- The original vision doc is `read_it_my_bro.md` (Thai).
- The owner cannot read Chinese — respond in Thai or English only.
- **`docs/phase-log.md`** is the authoritative detailed phase log (split out of this file on
  2026-07-27 to stay under Claude Code's 150k-char auto-load limit). **Write new phase entries there**
  and add one row to the table above. **Keep this file small** — it is auto-loaded into every session
  and into every delegated `claude-9arm` run.
- **`GOTCHA.md`** collects hard-won traps (symptom → cause → fix) — LLM gateway, Windows/PowerShell
  (AMSI, WinRT `-Sta`, Unicode), State Builder, and testing (vacuous `setTimeout` asserts, `bun -e`
  backslash trap). Read it before touching those areas. `HANDOFF.md` is the cold-start doc.
