# ExecutiveOS — Handoff & Plan

> **Purpose:** a single doc to resume this project cold if context/memory is lost. Pairs with
> `CLAUDE.md` (the authoritative phase-by-phase log) and `README.md` (user-facing overview).
> Last updated at **Phase 24** (git `8001d97`). 251 passing tests, all green.

---

## 1. What this is

An **event-driven personal "Chief of Staff" runtime** (not a chatbot). It observes the owner's activity,
derives a compact state, decides the highest-value next action with rules, and — behind explicit approval —
acts on an isolated git branch. It has grown into a proactive assistant that **proposes** work + life
actions for the owner to approve/reject, and can **listen to the owner's own dictated notes**.

**Core principle (never violate):** the LLM is a reasoning engine (CPU) **only**, never the centre. Most
of the system is deterministic rule-based code; the LLM is a "Worker" called only when reasoning is needed.
Main loop: **Observe → Understand → Predict → Act → Observe again.**

**Owner:** Thai; cannot read Chinese — respond in Thai or English only.

---

## 2. Current status — DONE through Phase 24

The full loop works and is validated (including **live against the real LLM gateway**). Phases (see
`CLAUDE.md` for the detailed entry on each):

| # | Phase | What it added |
|---|-------|---------------|
| 1 | Runtime skeleton | JSONL EventStore, CLI, config, bootstrap |
| 2 | EventBus + Watchers | git + fs watchers, `watch` daemon |
| 3 | State Builder | `state.json` / `context.json` (rule-based) |
| 4 | Planner | ranked actions + `act`/`ask` guardrail → `plan.json` |
| 5 | LLM Worker | first LLM use; action → prose Proposal (proposes, never executes) |
| 6 | Executor | applies a ChangeSet on an isolated `executive/change-*` branch |
| 7 | Synthesizer | Proposal → ChangeSet (validated before Executor) |
| 8 | Autopilot | `auto` chains plan→work→synth→execute (manual) |
| 9 | Continuous Autopilot | `auto` in the `watch` daemon behind 2 default-off gates + dedup/cooldown |
| 10 | Worker Identity | `.executive/claude.md` editable persona (can't weaken code guardrails) |
| 11 | Digest / Report | `report` → human-readable `digest.md` incl. **"Needs you"** queue |
| 12 | Watch Digest | daemon refreshes digest + alerts only on "Needs you" change |
| 13 | Full ask-queue | "Needs you" surfaces every `ask` action, not just the top |
| 14 | Notification log | durable `notifications.jsonl` of "Needs you" transitions |
| 15 | Auto-task | infer `currentTask` from git branch name |
| 16 | Auto-project | infer `currentProject` from git repo (watcher tags `repo`) |
| 17 | Auto test results | `install-hooks` → post-commit hook emits pass/fail |
| 18 | Local web GUI | `ui` → `Bun.serve` dashboard on 127.0.0.1 |
| 19 | LLM inference | guess block/deadline (suggestions only, toggle) → `inferred.json` |
| 20 | **max_tokens headroom fix** | reasoning models "think" → 1024 truncated; floor 4096 / 120s. **Fixed a latent bug** in Worker+Synth (never caught: mock-only tests). + `init` writes `.gitignore`. |
| 21 | GUI polish | Confirm buttons for suggestions; `ui` also runs watchers |
| 22 | **Proactive Advisor** | proposes work+life actions → `advisor.json` queue; GUI "Decisions for you" cards (Approve/Dismiss/edit); `propose`/`proposals` CLI; daemon toggle |
| 23 | Voice/text capture | `capture <note>` CLI + dashboard push-to-talk (own-voice, **visible**) → `system.note` feeds the Advisor |
| 23.1 | Thai/English toggle | language selector for the mic |
| 23.2 | Hold-to-talk | hold Space to dictate in the dashboard |
| 24 | Whisper transcription | `config.transcribe` block; `POST /api/transcribe` server-side proxy to Whisper endpoint; MediaRecorder dashboard mic with Web-Speech fallback; scaffolded, needs owner's endpoint+key |

**Test count:** 251 passing, 100% offline (mock backends). Several phases also **validated live** against
the 9arm Qwen gateway (`work`, `synth`, `infer`, `propose`).

---

## 3. How to run / continue

```bash
bun install
bun run typecheck          # tsc --noEmit (strict) — must stay green
bun test                   # 250 tests, offline

bun run src/index.ts init  # create .executive/ (also adds .executive/ to .gitignore in a repo)
bun run src/index.ts ui    # dashboard at localhost:4317 (+ watches git/files); the main entry point now
```
Full command list is in `README.md` / `CLAUDE.md` and `printUsage()` in `src/index.ts`.

**Dev workflow (division of labor):** the architect (Claude) writes a **scope** in `docs/scopes/`, hands it
to **claude9arm** (a cheaper Qwen worker, driven externally by the owner) to implement, then the architect
**reviews + runs every acceptance criterion for real** (never trusts the self-report), fixes defects, and
commits. In this session the architect often implemented directly (qwen relayed by the owner, who was away).
Every phase = one commit + a `CLAUDE.md` phase entry.

---

## 4. LLM gateway — critical operational knowledge

- Default backend = the owner's friend "Arm"'s **local Qwen** via `https://gateway.9arm.co` (Anthropic
  Messages API shape), model `qwen3.6-35b-a3b`. **Flat-rate, not Claude** — spends no Claude quota, and the
  owner says it never hits limits, so **live calls are OK**.
- Auth token lives ONLY in gitignored `.env` under `EXECUTIVE_WORKER_KEY` (Bun auto-loads `.env` from the
  **cwd** — a common test gotcha: run from a dir that has `.env`, or copy it in, or the call 401s).
- **Qwen3.6 has a "thinking" phase** that consumes output tokens before the answer. Too small a
  `max_tokens` → `content:[]` / `stop:max_tokens` → empty/errored calls. Phase 20 fixed this with shared
  `llmMaxTokens(config, floor=4096)` + `llmTimeoutMs(config, floor=120000)` in `src/config.ts`, used by the
  worker/synth/infer/advisor factories. Latency is variable (6s–>120s); occasional timeouts are expected
  and the daemon retries. `/no_think` did NOT help (made it worse). Headroom is the lever.
- Response parsing tolerates code fences / surrounding prose and extracts the JSON (`parseGuesses`,
  `parseDrafts`, etc.).

---

## 5. Guardrails & decisions that MUST be preserved

- **The system never decides autonomously:** relationships, morality, large spending, life-goal changes.
  It may *propose* anything (human approves), but never auto-acts on those. Confidence > 95% → act, else ask.
- **Autonomy is opt-in, layered, default-off:** autopilot (`config.autopilot.enabled` then `.apply`),
  inference (`config.infer.enabled`), advisor (`config.advisor.enabled`), capture (`config.capture.enabled`).
  Applied changes only ever land on an isolated `executive/change-*` branch; the owner merges.
- **LLM output is untrusted:** a synthesized ChangeSet is path-safety-validated before the Executor runs it,
  even dry-run. Proposals/inference/advice are suggestions until the owner confirms.

---

## 6. Remaining work

### Needs the owner
- **Phase 24 (Whisper transcription)** is code-complete/scaffolded but needs the owner to supply a real
  Whisper-compatible `/v1/audio/transcriptions` endpoint + key to validate live (the 9arm gateway is
  LLM-only, no audio endpoint).

### Deliberately deferred (need an owner decision or real pain)
- **External delivery** (email/Slack/push of the digest & approvals) — outward-facing; needs a channel
  choice + explicit approval. `notifications.jsonl` is the local substrate it will read from.
- **SQLite/Drizzle** storage — JSONL is fine until it isn't (tech-stack target, no pain yet).
- **`rules.md` / `planner.md`** — the vision's remaining 4-layer artifacts (editable decision rules /
  long-term goals). Speculative; rules already live as code in `src/planner/rules.ts`.
- **Wiring approved proposals to real execution** — today approving a Proposal records + logs it; it has no
  "hands" for irreversible real-world actions (by design). A future phase could route approved *work*
  proposals into the autopilot chain.

---

## 7. Layout quick-map

```
src/
├── events/        # JSONL EventStore, seq, types
├── watchers/      # git + fs watchers
├── state/         # State Builder (state.json/context.json) — incl. task/project inference
├── planner/       # rule-based Planner (plan.json) + rules.ts
├── worker/        # LLM Worker (Proposal) — mock|anthropic + identity (claude.md)
├── executor/      # applies ChangeSet on isolated branch (git, deterministic)
├── synth/         # Synthesizer (Proposal→ChangeSet)
├── auto/          # Autopilot orchestrator + guard (continuous-autonomy dedup)
├── report/        # Digest (digest.md, "Needs you") + notify (notifications.jsonl)
├── infer/         # LLM block/deadline guesses (inferred.json)
├── advisor/       # proactive proposal queue (advisor.json)
├── hooks/         # install-hooks (post-commit test emitter)
├── ui/            # Bun.serve dashboard (server.ts + page.ts)
├── config.ts  paths.ts  bootstrap.ts  index.ts (CLI)
.executive/        # runtime data (gitignored): config.json, claude.md, events/, state/plan/digest/
                   #   proposal/changeset/exec-report, auto-report, notifications, inferred, advisor.json
docs/scopes/       # per-phase specs
CLAUDE.md          # authoritative phase log + workflow + guardrails
README.md          # user-facing overview
```
