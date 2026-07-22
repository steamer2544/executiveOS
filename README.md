# ExecutiveOS

An **event-driven personal "Chief of Staff" runtime** — not a chatbot. It watches what you do (git
commits, file saves, test results, the window you're looking at), keeps a compact picture of your current
situation, decides the highest-value next action with plain rules, proposes things worth doing across work
*and* life, and — only when it's safe and you've allowed it — carries an action out on an isolated git
branch for you to review.

The goal is to **offload the boring decisions** so your attention stays on design, code, music, reading,
and philosophy.

> The original vision doc is [`read_it_my_bro.md`](./read_it_my_bro.md) (Thai).

---

## Core principle

**The LLM is a reasoning engine (a CPU) only — never the centre of the system.**

The real system is an OS: an Event Bus, derived State, a rule-based Planner, an Executor, and Guardrails.
An LLM (Claude, or a Qwen gateway) is a **Worker** that gets called only when actual reasoning is needed —
never to decide *what* to think about. Most of ExecutiveOS runs with **no LLM at all** and is fully
deterministic.

The main loop is continuous: **Observe → Understand → Predict → Act → Observe again.**

---

## Status — it works

Phases 1–32 are done and verified end-to-end, most of them against live data rather than only tests.
What runs today:

- **Observe without being told** — a `watch` daemon senses **git commits, branch → task, repo → project,
  file saves, test results** (via a git hook), and **which window you're looking at**, across
  **multiple repos** at once. Only *blocked* and *deadline* still need you to say so.
- **Understand** — a rule-based State Builder derives a compact `state.json` / `context.json`.
- **Predict** — a rule-based Planner ranks actions and marks each **act** (safe to do) or **ask** (needs
  you), gated by a hard confidence guardrail.
- **Act** — a Worker (LLM) turns an `act` action into a Proposal; a Synthesizer turns that into a concrete
  ChangeSet; an Executor applies it **on an isolated `executive/change-*` branch** and runs its tests. A
  single `auto` command chains the whole thing.
- **Propose, don't just answer** — an Advisor queues small reversible proposals across work *and* life for
  you to **approve or dismiss**; approving a code proposal can run the whole Synth → Executor pipeline.
- **See and click** — a local `ui` dashboard (127.0.0.1 only) shows Now / Recommended / **Needs you** /
  Decisions, with buttons for the signals no watcher can sense, and push-to-talk dictation.
- **Read the screen** (opt-in) — window titles, and on-device OCR of a screenshot to *suggest* what
  you might be blocked on. Suggestions only; you confirm with one click.
- **Stay informed** — `report` renders a human-readable digest, and the daemon keeps a durable
  `notifications` log so nothing that needs your decision is ever lost.

456 tests pass, fully offline.

---

## Quick start

Requires [Bun](https://bun.sh).

```bash
bun install
bun run src/index.ts init          # create the .executive/ runtime dir (gitignored)

bun run src/index.ts ui            # dashboard on http://127.0.0.1:4317 + watchers (Ctrl-C to stop)
```

`ui` is the one command most days: it runs the watchers *and* serves the dashboard. If you prefer the
terminal:

```bash
bun run src/index.ts watch         # just the daemon
bun run src/index.ts plan          # what's the highest-value action right now?
bun run src/index.ts report        # human-readable digest + "Needs you" queue
```

Nothing touches your repo history unless you explicitly run `execute … --apply`, `auto --apply`, or
approve an executable proposal — and even then work only ever lands on an isolated `executive/change-*`
branch that **you** merge.

### Feeding it real signals

Running `watch`/`ui` senses most of your situation on its own. To sense **test results** too, install the
git hook once; every commit then runs your tests and records pass/fail:

```bash
bun run src/index.ts install-hooks --test "bun test"   # writes .git/hooks/post-commit
```

The only signals that still need you are the ones no watcher can know — **a block** and a **deadline**
(external facts in your head). Use the dashboard buttons, or:

```bash
bun run src/index.ts emit system system.blocked '{"reason":"waiting on vendor API key"}'
bun run src/index.ts emit system system.unblocked '{}'
bun run src/index.ts emit system system.task '{"deadline":"2026-08-01"}'
bun run src/index.ts emit system system.task '{"deadline":""}'   # empty clears it
```

`report` freshens `state.json`/`plan.json` from the event log before rendering, so `emit … → report`
reflects your latest events even with no daemon running. (There's also a standalone
`scripts/exec-test.{sh,ps1}` wrapper if you prefer sensing tests per-run instead of per-commit.)

### Watching more than one repo

Add a `watch.repos` array to `.executive/config.json` and the daemon runs a watcher pair per repo. State
follows whichever repo you last touched (`activeRepo`), so Project / Branch / Task always move together.

```json
{ "watch": { "repos": [
  { "path": "C:/code/api" },
  { "path": "C:/code/web", "name": "web", "pollMs": 5000 }
] } }
```

---

## Commands

```
init                                          Create .executive/ (config, event logs, meta)
emit <source> <type> [json]                   Append an event (source: git|terminal|editor|system|screen)
tail [n] [source]                             Show the last n events (seq order)
build-state                                   Derive state.json + context.json from the event log
plan                                          Build state, then derive plan.json (rule-based)
work                                          plan, then run the Worker on an actionable action → proposal.json
synth [--files a,b] [--proposal <id>]         Turn the latest Proposal into a ChangeSet (dry-run; never applies)
execute <changeset.json> [--apply]            Apply a ChangeSet on an isolated branch (dry-run without --apply)
auto [--apply] [--files a,b]                  Run the whole chain plan→work→synth→execute (dry-run unless --apply)
report                                        Render a human-readable digest → .executive/digest.md
notifications [n]                             Show the last n "Needs you" notifications the daemon logged
compact [--apply]                             Rewrite historical logs with today's noise filters (dry-run default)
install-hooks [--test "<cmd>"]                Install a git post-commit hook that auto-emits test results
ui [--port N] [--no-watch]                    Local web dashboard (also runs the watchers unless --no-watch)
infer                                         Ask the LLM to guess block/deadline (suggestions only)
propose                                       Ask the Advisor for proactive proposals (adds to the queue)
proposals                                     List the pending proposals awaiting your approval
approve <id> [--apply] [--note ".."]          Approve a proposal (runs Synth→Executor if it is executable)
dismiss <id>                                  Reject a pending proposal
capture <note>                                Capture a quick note (feeds the Advisor)
download-model [id]                           Download a browser-wasm Whisper model for offline dictation
watch                                         Start the watcher daemon (Ctrl-C to stop)
```

Dev:

```bash
bun test          # 456 offline tests
bun run typecheck # tsc --noEmit (strict)
bun run test:e2e  # opt-in browser test for in-browser Whisper (needs Playwright + the model)
```

---

## The autonomy ladder

ExecutiveOS is designed to earn trust one notch at a time. Every step up is **opt-in** in
`.executive/config.json`:

| Level | What the `watch` daemon does | How to enable |
|-------|------------------------------|---------------|
| **Observe** (default) | Watches git/files, rebuilds `state.json`/`plan.json`/`digest.md`, logs "Needs you" notifications. **Never acts, never calls an LLM.** | on by default |
| **Suggest** | Asks an LLM to *guess* the signals it can't sense (block/deadline), or to propose actions. Both are **suggestions only** — nothing is recorded until you confirm. | `infer.enabled` / `advisor.enabled` |
| **Autopilot — dry-run** | Runs `plan → work → synth → dry-run` continuously and writes proposals/changesets for you to review. Still commits nothing. | `autopilot.enabled: true` |
| **Autopilot — apply** | Also lets the Executor commit passing changes to an isolated `executive/change-*` branch. Still never merges. | `autopilot.enabled: true` **and** `autopilot.apply: true` |

A re-trigger guard (dedup by state signature + cooldown) stops it from re-acting on an unchanged
situation, and failing tests park the change on its branch and flag it for you rather than pretending it's
done.

---

## Guardrails

- **Confidence > 95% → act; otherwise ask.** A single unbypassable gate in the Planner decides this.
- **The system never decides on its own:** relationships, morality, large spending, or life-goal changes.
  The Advisor may *suggest* in those areas, but a code filter forces any such proposal to be
  non-executable — the LLM cannot route a life or money decision into the executor.
- **Every action is inspectable and reversible.** Changes land only on an isolated `executive/change-*`
  branch; the owner is always the one who merges. Nothing rewrites your working branch history.
- **The daemon never auto-acts unless you opt in** (autopilot is default-off, and applying is a second
  separate opt-in).
- **The LLM's output is untrusted** — a synthesized ChangeSet is path-safety-validated before the Executor
  will even dry-run it.
- **Guesses are never facts.** Inference and screen-reading write to a separate "Suggestions
  (unconfirmed)" section; they never emit an event or mutate state until you click Confirm.
- **Listening is visible and off by default.** Dictation is push-to-talk with an always-shown
  "🔴 Listening…" indicator. There is deliberately **no hidden always-on room recorder** — in a shared
  space that would capture people who never consented, and an indicator on your laptop doesn't inform
  them.

---

## Architecture

```
                observe                 understand            predict            act
   git/fs  ──►  Event Bus  ──►  State Builder  ──►  Planner  ──►  Worker (LLM)  ──►  Synthesizer  ──►  Executor
   screen       (JSONL log)     state.json          plan.json     proposal.json      changeset.json     isolated branch
   watchers                     context.json        (rules only)  (reasoning)        (reasoning)        (git, rules only)
                                     │                                                                        │
                                     ├──────────────►  Digest / report  ──►  digest.md + "Needs you"  ◄───────┘
                                     │                 Notification log ──►  notifications.jsonl (durable)
                                     │
                                     ├──────────────►  Advisor (LLM)  ──►  proposal queue  ──►  you approve/dismiss
                                     └──────────────►  Infer / screen-sense (LLM)  ──►  suggestions (you confirm)
```

Four stages may call an LLM — **Worker**, **Synthesizer**, **Advisor**, and the **suggestion** layer
(infer / screen). Everything else — watchers, state, planner, executor, digest, notifications, compaction
— is 100% deterministic rule-based code.

### Data layout

Everything the runtime produces lives under `.executive/` (gitignored — never committed):

```
.executive/
├── config.json            # runtime config (worker backend, autopilot gates, screen, …)
├── claude.md              # the Worker's editable identity (system-prompt persona)
├── meta.json              # monotonic event seq counter
├── events/{git,terminal,editor,system,screen}.jsonl
├── state.json  context.json
├── plan.json   proposal.json  changeset.json  exec-report.json
├── auto-report.json  synth-report.json
├── advisor.json          # the proposal queue awaiting your decision
├── inferred.json  screen-inferred.json   # unconfirmed LLM guesses
├── digest.md             # latest human-readable digest
├── notifications.jsonl   # durable "Needs you" history
├── vendor/ models/       # browser-wasm Whisper assets (only if you download them)
└── logs/
```

### Keeping the signal clean

Sensors are noisy, and noise silently degrades everything downstream. Two mechanisms keep the log honest,
both deterministic:

- **At capture** — window titles are normalized before dedup (an agent-run terminal animates its title,
  which would otherwise log the same window hundreds of times), dictated notes pass a low-signal filter,
  vanished temp files are pruned from `currentFile`, and Advisor proposals dedup by *intent*, not just by
  title.
- **After the fact** — `compact [--apply]` rewrites the historical log with those same predicates. It is
  dry-run by default and backs every file up to `.executive/backup-<ts>/` first, so it is reversible.

---

## Configuration

`.executive/config.json` is created by `init` with safe defaults and merges forward-compatibly (old
configs keep working). Key sections:

- **`worker`** — which LLM backend the Worker/Synthesizer/Advisor use.
  - `mock` — deterministic, offline (used by every test; the safe fallback).
  - `anthropic` — POSTs to an Anthropic-compatible gateway. The default points at the owner's flat-rate
    **9arm Qwen gateway**, *not* Claude, so the runtime spends no Claude quota.
  - The auth token is **never** in source — it lives only in a gitignored `.env` under the var named by
    `worker.apiKeyEnv` (default `EXECUTIVE_WORKER_KEY`). Copy [`.env.example`](./.env.example) to `.env`
    and fill it in.
- **`autopilot`** — `{ enabled, apply, cooldownMs }`, all default-off (see the autonomy ladder).
- **`advisor`** — `{ enabled, cooldownMs, maxOpen, applyOnApprove }`. `applyOnApprove` (default off) is
  what lets approving a code proposal actually create a branch.
- **`infer`** — `{ enabled, cooldownMs }` for block/deadline guessing (default off).
- **`screen`** — `window` (title watcher), `ocr` (on-device screenshot OCR; `engine: "winrt" | "tesseract"`,
  where **tesseract is the one that reads Thai**), and `vision` (multimodal LLM). All default off.
- **`capture` / `transcribe`** — dictation: work-hours window, and which transcription backend
  (`webspeech`, `whisper-api`, or `browser-wasm`, which runs Whisper in the browser so audio never leaves
  the machine).
- **`executor`** — branch prefix + default test command.
- **`watch` / `state` / `synth`** — poll intervals, the multi-repo list, rebuild interval, file bounds.

---

## Tech stack

Bun → TypeScript (strict) → JSONL event log (SQLite/Drizzle planned) → in-process Event Bus →
Anthropic-compatible gateway. No runtime dependencies beyond Bun (Playwright is a dev-only dependency for
the opt-in browser e2e test).

---

## Development workflow

Work is done phase by phase against a written spec:

1. **Scope** — a detailed, context-free spec goes in [`docs/scopes/`](./docs/scopes) (files, I/O, data
   shapes, explicit acceptance criteria, and an explicit "what is NOT in scope").
2. **Implement** — the spec is handed to a cheaper Qwen worker that writes the code.
3. **Review + test for real** — every acceptance criterion is *run*, never trusted from a self-report.
4. **Fix + commit.**

See [`CLAUDE.md`](./CLAUDE.md) for the full phase-by-phase history and the two-`claude.md`-files note,
[`GOTCHA.md`](./GOTCHA.md) for hard-won traps (LLM gateway, Windows/PowerShell, testing), and
[`HANDOFF.md`](./HANDOFF.md) for a cold start.

---

## Not yet (deliberately)

- **External delivery** of notifications (email/Slack/webhook) — outward-facing, so it stays behind an
  explicit channel choice + approval. `notifications.jsonl` is the local substrate it will read from.
- **Vision screen-reading in practice** — the code works, but the gateway this runtime uses does not
  allow the multimodal model (HTTP 403), so on-device OCR is the working screen path. It keeps the
  image local anyway.
- **SQLite/Drizzle** storage — the JSONL log is fine until it isn't.
- **Long-term goals** (`planner.md`) and file-editable decision rules (`rules.md`).
