# ExecutiveOS

An **event-driven personal "Chief of Staff" runtime** — not a chatbot. It watches what you do (git
commits, file saves, test results), keeps a compact picture of your current situation, decides the
highest-value next action with plain rules, and — only when it's safe and you've allowed it — carries that
action out on an isolated git branch for you to review.

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

Phases 1–14 are done and verified end-to-end. What runs today:

- **Observe** — a `watch` daemon with git + filesystem watchers turns activity into an append-only event
  log.
- **Understand** — a rule-based State Builder derives a compact `state.json` / `context.json`.
- **Predict** — a rule-based Planner ranks actions and marks each **act** (safe to do) or **ask** (needs
  you), gated by a hard confidence guardrail.
- **Act** — a Worker (LLM) turns an `act` action into a Proposal; a Synthesizer turns that into a concrete
  ChangeSet; an Executor applies it **on an isolated `executive/change-*` branch** and runs its tests. A
  single `auto` command chains the whole thing.
- **Continuous autonomy** — the `watch` daemon can run that chain on its own, behind two default-**off**
  config gates.
- **Stay informed** — `report` renders a human-readable digest (including a **"Needs you"** queue), and
  the daemon keeps a durable `notifications` log so nothing that needs your decision is ever lost.

199 tests pass, fully offline.

---

## Quick start

Requires [Bun](https://bun.sh).

```bash
bun install
bun run src/index.ts init          # create the .executive/ runtime dir (gitignored)

# feed it some events (normally the watch daemon does this for you)
bun run src/index.ts emit system system.test_result '{"status":"failing"}'

bun run src/index.ts plan          # what's the highest-value action right now?
bun run src/index.ts report        # human-readable digest + "Needs you" queue

# or just watch — the daemon observes git/files and rebuilds state continuously
bun run src/index.ts watch         # Ctrl-C to stop
```

Nothing touches your repo history unless you explicitly run `execute … --apply` or `auto --apply`, and
even then work only ever lands on an isolated `executive/change-*` branch that **you** merge.

---

## Commands

```
init                                   Create .executive/ (config, event logs, meta)
emit <source> <type> [json]            Append an event (source: git|terminal|editor|system)
tail [n] [source]                      Show the last n events (seq order)
build-state                            Derive state.json + context.json from the event log
plan                                   Build state, then derive plan.json (rule-based)
work                                   plan, then run the Worker on an actionable top action → proposal.json
synth [--files a,b] [--proposal <id>]  Turn the latest Proposal into a ChangeSet (dry-run; never applies)
execute <changeset.json> [--apply]     Apply a ChangeSet on an isolated branch (dry-run without --apply)
auto [--apply] [--files a,b]           Run the whole chain plan→work→synth→execute (dry-run unless --apply)
report                                 Render a human-readable digest → .executive/digest.md
notifications [n]                      Show the last n "Needs you" notifications the daemon logged
watch                                  Start the watcher daemon (Ctrl-C to stop)
```

Dev:

```bash
bun test          # 199 offline tests
bun run typecheck # tsc --noEmit (strict)
```

---

## The autonomy ladder

ExecutiveOS is designed to earn trust one notch at a time. Every step up is **opt-in** in
`.executive/config.json`:

| Level | What the `watch` daemon does | How to enable |
|-------|------------------------------|---------------|
| **Observe** (default) | Watches git/files, rebuilds `state.json`/`plan.json`/`digest.md`, logs "Needs you" notifications. **Never acts, never calls an LLM.** | on by default |
| **Autopilot — dry-run** | Runs `plan → work → synth → dry-run` continuously and writes proposals/changesets for you to review. Still commits nothing. | `autopilot.enabled: true` |
| **Autopilot — apply** | Also lets the Executor commit passing changes to an isolated `executive/change-*` branch. Still never merges. | `autopilot.enabled: true` **and** `autopilot.apply: true` |

A re-trigger guard (dedup by state signature + cooldown) stops it from re-acting on an unchanged
situation, and failing tests park the change on its branch and flag it for you rather than pretending it's
done.

---

## Guardrails

- **Confidence > 95% → act; otherwise ask.** A single unbypassable gate in the Planner decides this.
- **The system never decides on its own:** relationships, morality, large spending, or life-goal changes.
  Any action touching those is forced to **ask**.
- **Every action is inspectable and reversible.** Changes land only on an isolated `executive/change-*`
  branch; the owner is always the one who merges. Nothing rewrites your working branch history.
- **The daemon never auto-acts unless you opt in** (autopilot is default-off, and applying is a second
  separate opt-in).
- **The LLM's output is untrusted** — a synthesized ChangeSet is path-safety-validated before the Executor
  will even dry-run it.

---

## Architecture

```
                observe                 understand            predict            act
   git/fs  ──►  Event Bus  ──►  State Builder  ──►  Planner  ──►  Worker (LLM)  ──►  Synthesizer  ──►  Executor
   watchers     (JSONL log)     state.json          plan.json     proposal.json      changeset.json     isolated branch
                                context.json         (rules only)  (reasoning)        (reasoning)        (git, rules only)
                                     │                                                                        │
                                     └──────────────►  Digest / report  ──►  digest.md + "Needs you"  ◄───────┘
                                                       Notification log ──►  notifications.jsonl (durable)
```

Only two stages ever call an LLM — the **Worker** (prose Proposal) and the **Synthesizer** (Proposal →
ChangeSet). Everything else — watchers, state, planner, executor, digest, notifications — is 100%
deterministic rule-based code.

### Data layout

Everything the runtime produces lives under `.executive/` (gitignored — never committed):

```
.executive/
├── config.json            # runtime config (worker backend, autopilot gates, …)
├── claude.md              # the Worker's editable identity (system-prompt persona)
├── meta.json              # monotonic event seq counter
├── events/{git,terminal,editor,system}.jsonl
├── state.json  context.json
├── plan.json   proposal.json  changeset.json  exec-report.json
├── auto-report.json  synth-report.json
├── digest.md             # latest human-readable digest
├── notifications.jsonl   # durable "Needs you" history
└── logs/
```

---

## Configuration

`.executive/config.json` is created by `init` with safe defaults and merges forward-compatibly (old
configs keep working). Key sections:

- **`worker`** — which LLM backend the Worker/Synthesizer use.
  - `mock` — deterministic, offline (used by every test; the safe fallback).
  - `anthropic` — POSTs to an Anthropic-compatible gateway. The default points at the owner's flat-rate
    **9arm Qwen gateway**, *not* Claude, so the runtime spends no Claude quota.
  - The auth token is **never** in source — it lives only in a gitignored `.env` under the var named by
    `worker.apiKeyEnv` (default `EXECUTIVE_WORKER_KEY`). Copy [`.env.example`](./.env.example) to `.env`
    and fill it in.
- **`autopilot`** — `{ enabled, apply, cooldownMs }`, all default-off (see the autonomy ladder).
- **`executor`** — branch prefix + default test command.
- **`watch` / `state` / `synth`** — poll intervals, rebuild interval, file bounds.

---

## Tech stack

Bun → TypeScript (strict) → JSONL event log (SQLite/Drizzle planned) → in-process Event Bus →
Claude Code SDK / Anthropic-compatible gateway. No runtime dependencies beyond Bun.

---

## Development workflow

Work is done phase by phase against a written spec:

1. **Scope** — a detailed, context-free spec goes in [`docs/scopes/`](./docs/scopes) (files, I/O, data
   shapes, explicit acceptance criteria, and an explicit "what is NOT in scope").
2. **Implement** — the spec is handed to a cheaper Qwen worker that writes the code.
3. **Review + test for real** — every acceptance criterion is *run*, never trusted from a self-report.
4. **Fix + commit.**

See [`CLAUDE.md`](./CLAUDE.md) for the full phase-by-phase history and the two-`claude.md`-files note.

---

## Not yet (deliberately)

- **External delivery** of notifications (email/Slack/webhook) — outward-facing, so it stays behind an
  explicit channel choice + approval. `notifications.jsonl` is the local substrate it will read from.
- **SQLite/Drizzle** storage — the JSONL log is fine until it isn't.
- **Long-term goals** (`planner.md`) and file-editable decision rules (`rules.md`).
