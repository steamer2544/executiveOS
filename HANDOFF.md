# ExecutiveOS — Handoff & Plan

> **Purpose:** a single doc to resume this project cold if context/memory is lost. Pairs with
> `CLAUDE.md` (the authoritative phase-by-phase log), `GOTCHA.md` (traps & non-obvious failure modes —
> read before touching PowerShell/state/tests/LLM), and `README.md` (user-facing overview).
> Last updated after **Phase 29.2** (screen OCR live + failure honesty). **387 passing tests**, all green.

> **⏭️ Immediate next task:** screen-sensing **Layer 2 is now live** — the Defender exclusion is in place
> and the full chain (screenshot → on-device OCR → LLM suggestions) was validated end-to-end. What remains
> is the **Thai OCR language pack** (only `en-US` installed, so Thai on screen OCRs to garbage). See §6.
> **Layer 3 (vision) is a dead end on this gateway:** the team is allow-listed to `qwen3.6-35b-a3b`, so
> `qwen-vl-max` returns 403. It fails cleanly; Layer 2 is the path that works (and keeps the image local).
>
> **If every LLM feature suddenly reports "nothing found":** check whether the work **Zscaler** proxy is
> on — it MITMs TLS and Bun's `fetch` rejects the re-signed cert, and every client swallows that into a
> polite empty result. `GOTCHA.md` §1 has the diagnosis. Not a product bug.

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

## 2. Current status — DONE through Phase 30

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
| 25 | Transcription backends + Settings | `transcribe.mode` = **webspeech / whisper-api / browser-wasm**; dashboard Settings card (mode + fields + Groq/local presets + Save + Download); `POST /api/settings`, `/api/transcribe/download`+`/status`, static `/vendor`+`/models`; `download-model` CLI; browser-wasm serves lib+model from 127.0.0.1 (audio never leaves the machine) |
| 25.1–25.4 | browser-wasm polish | minimal-dtype model download (~81MB not ~1.6GB); Playwright e2e proves the in-browser transcription end-to-end; single merged language selector |
| 26 (+26.1) | **Multi-repo watching** | `config.watch.repos[]` → one git(+fs) watcher per repo via `buildWatchers`; State picks `activeRepo` (highest-seq repo-tagged event) + `state.repos[]`; Project/Branch/Task move together. 26.1: sort `repos` by seq (deterministic), not wall-clock |
| 27 | **Approve → Execute** | approving an **executable code** Advisor proposal (`executable:true`+`repo`) runs Synth→Executor onto an isolated branch (opt-in `applyOnApprove`/`--apply`); a hard `sanitizeExecutable()` filter forces life/money/relationship/goal proposals to record-only. Advisor prompt broadened to all of life; `approve`/`dismiss` CLI |
| — | FsWatcher temp-file fix | `isIgnoredPath()` now ignores dotfiles/dot-dirs + `.tmp.` infix + temp/backup suffixes (temp scratch was polluting `currentFile`) |
| 28 | **Screen-sense Layer 1** | poll-based watcher emits `screen.window{title,app}` on change (5th event source, no LLM/image); `State.currentWindow`, digest "Looking at" line. `CharSet.Unicode`+UTF-8 so Thai titles survive |
| 29 | **Screen-sense Layer 2 + 3** | screenshot → **on-device OCR** (Layer 2) or **`qwen-vl-max` vision** (Layer 3, OpenAI `/v1/chat/completions`) → **suggestions only** in `screen-inferred.json`, merged into the digest. Off by default. **Blocked by Defender/AMSI until an exclusion is added — see §6** |
| 30 | **State coherence** | `currentFile` pruned to files that still exist on disk (resolves against watched roots); empty `system.task` now **clears** the task; dashboard "Clear task" button |

**Test count:** 383 passing, 100% offline (mock backends). Several phases **validated live** against the
9arm Qwen gateway (`work`, `synth`, `infer`, `propose`); Phase-29 OCR validated live (English, generated
image); Phase-25 vendor download + browser-wasm e2e run live too. **Not yet live:** Phase-29 vision call
(owner-run, spends a token) and screenshot capture (Defender-blocked — §6).

---

## 3. How to run / continue

```bash
bun install
bun run typecheck          # tsc --noEmit (strict) — must stay green
bun test                   # 383 tests, offline
bun run test:e2e           # OPT-IN browser-wasm e2e (real Chromium via Playwright; runs under node, auto-skips
                           #   if playwright/model aren't set up — see test/e2e/README.md)

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
- **Two API shapes:** everything text (worker/synth/infer/advisor) uses the **Anthropic** `/v1/messages`
  shape. **Vision (Phase 29, `qwen-vl-max`) is different** — the gateway's multimodal endpoint is
  **OpenAI-compatible** `POST /v1/chat/completions` with `image_url` base64 data-URL content parts
  (`src/screen/vision.ts`, response text at `choices[0].message.content`). Don't force images through the
  Anthropic client. Default `screen.vision.baseUrl`/`apiKeyEnv` fall back to `config.worker.*` at use time.

### Windows / PowerShell gotchas (hard-won, Phase 28–29)
- **Defender/AMSI blocks screen capture:** a PowerShell script that does `CopyFromScreen` is flagged
  "malicious content" and refused — via `-Command` **and** `-File` alike. Not code-fixable without an AV
  exclusion; do **not** obfuscate to evade it (that's detection-evasion). Capture returns null → graceful.
- **WinRT needs STA:** `Windows.Media.Ocr` / `StorageFile` async ops fault (`AggregateException`) in an MTA
  apartment; spawn `powershell -Sta`. Await `IAsyncOperation<T>` via the `[WindowsRuntimeSystemExtensions]
  .AsTask` generic bridge (see `src/screen/ocr.ts`).
- **Unicode from PowerShell:** set `[Console]::OutputEncoding = UTF8` **and**, for window titles,
  `[DllImport(..., CharSet=CharSet.Unicode)]` (the ANSI default mangles Thai to `?`).
- **`bun -e "...'$WINPATH'..."` eats backslashes** (JS string escapes) — a *test-harness* trap, not a bug;
  pass Windows paths via `process.env`, not interpolated into the `-e` string.

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

### ⏭️ Screen-sensing — Layer 2 is LIVE; two optional steps remain
Phase 29.1 got the full chain working on this machine (screenshot → OCR → suggestions, validated live).
1. ~~**Windows Defender exclusion**~~ — **done.** (Windows Security → Virus & threat protection → Manage
   settings → Exclusions → the project folder.) If capture ever returns null again, re-check it first.
2. ~~**Thai OCR pack**~~ — **does not exist.** Verified with an elevated
   `Get-WindowsCapability -Online -Name "Language.OCR*"`: Windows offers **36** OCR languages
   (ar, zh-CN/HK/TW, ja, ko, ru, most of Europe) and **`th-TH` is not one of them**. So Layer 2 is
   **English-only, permanently** — Thai on screen OCRs to garbage and no install can change that.
   (Layer 1 window titles still carry Thai correctly — different API.) See `GOTCHA.md` §2 for the
   alternatives (local Tesseract with `tha.traineddata`, a multimodal LLM, or accept English-only).
   Check what is actually installed:
   `[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]; [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | %{ $_.LanguageTag }`
2b. **Layer 3 (vision) is blocked at the gateway** — `qwen-vl-max` → `403 team_model_access_denied` (the
   team may only use `qwen3.6-35b-a3b`). Enabling the toggle is harmless (it reports `vision: unavailable`)
   but it will not produce suggestions until Arm allows the model or another multimodal endpoint is used.
3. **Turn it on** in the dashboard **Settings** card (OCR and/or Vision toggles). Vision (Layer 3) also needs
   the gateway key in `.env` (`EXECUTIVE_WORKER_KEY`, reused) — it sends the **whole screenshot** to the
   gateway, so it's the opt-in escalation; OCR keeps the image local.
4. **Verify live:** with OCR on, a capture should write suggestions to `.executive/screen-inferred.json` and
   they appear in the digest / dashboard "Suggestions (unconfirmed)" with Confirm. The vision HTTP path is
   still owner-run (spends a token). Ethics held: off by default, visible "🔴 reading screen" indicator,
   own-screen only.

### Needs the owner (to go live — code is complete)
Transcription now has **three working backends** (Phase 25); pick one in the dashboard **Settings** card:
- **Groq** (`whisper-api` preset) — free tier ~2000 req/day. Put the key in `.env` under
  `EXECUTIVE_TRANSCRIBE_KEY`, click the Groq preset, Save. Best "works today", great Thai↔English.
- **Local faster-whisper** (`whisper-api` preset) — host a `/v1/audio/transcriptions` server (e.g.
  `speaches`/`whisper.cpp`) on your machine; click the Local preset, set the URL, Save. Private, no cloud.
- **Browser-WASM** (`browser-wasm` mode) — run `download-model` (or the Settings "Download" button) once
  (~100MB into `.executive/vendor`+`/models`), then it transcribes **in the browser, fully offline**. The
  vendor download is verified working; the in-browser transcription needs one real-browser test (browser-only,
  like Web Speech).
- **Web Speech** (`webspeech`, default) — no setup, browser recognizer, one language at a time.

### Deliberately deferred (need an owner decision or real pain)
- **External delivery** (email/Slack/push of the digest & approvals) — outward-facing; needs a channel
  choice + explicit approval. `notifications.jsonl` is the local substrate it will read from.
- **SQLite/Drizzle** storage — JSONL is fine until it isn't (tech-stack target, no pain yet).
- **`rules.md` / `planner.md`** — the vision's remaining 4-layer artifacts (editable decision rules /
  long-term goals). Speculative; rules already live as code in `src/planner/rules.ts`.
- **Wiring approved proposals to real execution** — **partly done (Phase 27):** approving an *executable
  code* proposal now runs Synth→Executor onto an isolated branch. *Life/money/relationship/goal* proposals
  are still record-only by design (the `sanitizeExecutable()` filter forces it) — they have no "hands" for
  irreversible real-world actions, and that boundary is intentional.
- **Screen-sensing beyond title** is live as Phase 29 (OCR/Vision) but owner-gated on a Defender exclusion
  (§6). No always-on/hidden capture — deliberately out of scope (third-party consent).

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
├── screen/        # Layer 1 capture.ts (window title) + Layer 2/3 screenshot.ts/ocr.ts/vision.ts/screen-infer.ts
├── watchers/      # git + fs + screen (Layer 1) watchers; build.ts (multi-repo watcher assembly)
├── ui/            # Bun.serve dashboard (server.ts + page.ts) + models.ts (browser-wasm asset fetch)
├── config.ts  paths.ts  bootstrap.ts  index.ts (CLI)
.executive/        # runtime data (gitignored): config.json, claude.md, events/, state/plan/digest/
                   #   proposal/changeset/exec-report, auto-report, notifications, inferred, advisor.json,
                   #   vendor/ + models/ (browser-wasm transformers.js + Whisper model, served from 127.0.0.1)
docs/scopes/       # per-phase specs
CLAUDE.md          # authoritative phase log + workflow + guardrails
README.md          # user-facing overview
```
