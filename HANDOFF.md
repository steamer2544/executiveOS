# ExecutiveOS — Handoff & Plan

> **Purpose:** a single doc to resume this project cold if context/memory is lost. Pairs with
> `CLAUDE.md` (the authoritative phase-by-phase log), `GOTCHA.md` (traps & non-obvious failure modes —
> read before touching PowerShell/state/tests/LLM), and `README.md` (user-facing overview).
> Last updated after **Phase 35** (the Jarvis layer — a conversational agent with hands). **578
> passing tests**, all green.

> **⏭️ Immediate next task — Phase 36: make it speak first.** Phase 35 answers and acts, but the owner
> still has to open the dashboard to start the conversation — the exact failure that made the system go
> unused in the first place. The substrate exists: `runDigestTick` already knows the moment an item
> *enters* the "Needs you" queue (that is what `notifications.jsonl` records) and the agent can now
> phrase it. What is missing is a channel that reaches the owner with the dashboard closed
> (Telegram/LINE/Discord) plus a reply path back into `runTurn`. **Outward-facing — needs an explicit
> channel choice from the owner before any code is written.** Keep the boundary Phase 35 set: **the
> Planner decides what is worth interrupting for; the agent only phrases it.** Never let the LLM decide
> when to interrupt.
>
> **⚠️ Phase 35 left exactly one thing unmeasured: does the gateway support native tool calling?** Every
> probe returned **524 — including a 1-word prompt with no tools** — so Arm's box was down and this is
> unmeasured, not negative. Run `bun scripts/probe-tools.ts` from the repo root when the box is back and
> record the verdict in `GOTCHA.md` §1. Both protocols are implemented and tested and `auto` downgrades
> on a 4xx naming `tools`, so nothing is blocked either way.
>
> **Two smaller candidates, both cheap:**
> **(a) Derive the Tesseract OCR language list from the Layer 1 window title** — `-l tha+eng`
> hallucinates Thai on English-only screens (measured — `GOTCHA.md` §2), and the window title already
> carries real Thai (it is `GetWindowTextW`, not OCR), so Thai-in-title → `tha+eng`, else `eng`.
> **(b) Feed `State.patterns` to the digest/dashboard** — Phase 33 computes them and the Planner uses
> them, but the owner cannot see the numbers a proposal cites without reading `state.json`.
>
> **Phase 34.2 added a second method: re-review the phase you just shipped, cold.** Reading 34.1 as an
> outsider — not as its author — found that it had hardened **1 of 17** identical call sites, that its
> three new tests **all passed against the un-fixed code**, that the timeout it set equalled the client
> timeout it was meant to outlive, and that its own `GOTCHA.md` entry described a bug that never
> happened (`git log -S` proved it). None of that is visible from the diff; all of it is visible from
> the call graph and `git log`. Budget one pass for it.
>
> **Phase 33 set the method for anything new: read the real event log and calibrate before writing a
> rule.** Doing that killed two rules that sounded obvious (app-switch thrash is p50=**26**/30min — the
> *baseline*, not an anomaly; repo switches are p99=**0** because only one repo is ever tagged), and
> proved a proposed 3-hour session threshold would have **never fired** (longest real session: 1.87h).
> **Layer 3 (vision) is a dead end on this gateway:** the team is allow-listed to `qwen3.6-35b-a3b`, so
> `qwen-vl-max` returns 403. It fails cleanly; Layer 2 is the path that works (and keeps the image local).
> **If the gateway starts timing out (524):** check Arm's inference box — the LiteLLM proxy reports
> `Cannot connect to host vllm.tetra-magellanic.ts.net:8000` when it is down. Nothing to fix on our side.
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

## 2. Current status — DONE through Phase 33.1

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
| 29 | **Screen-sense Layer 2 + 3** | screenshot → **on-device OCR** (Layer 2) or **`qwen-vl-max` vision** (Layer 3, OpenAI `/v1/chat/completions`) → **suggestions only** in `screen-inferred.json`, merged into the digest. Off by default |
| 30 | **State coherence** | `currentFile` pruned to files that still exist on disk (resolves against watched roots); empty `system.task` now **clears** the task; dashboard "Clear task" button |
| 29.1 | **Layer 2 goes live** | the Defender exclusion let the capture script actually run, exposing 2 defects it had masked: `Save()` needs an `ImageCodecInfo` (not `ImageFormat`) so **no file was ever written**, and WinRT rejects mixed-separator paths. Real screenshot → real OCR → real suggestions, end to end |
| 29.2 | **Failure honesty** | `runScreenInference` no longer breaks its "never throws" contract on the vision path (it left `screen-inferred.json` **stale**), and a hard LLM failure (TLS/401/403/timeout) now reports `ocr: llm unavailable — <reason>` instead of the indistinguishable `ocr: no signal`. Verdict on Layer 3: **`qwen-vl-max` is 403 on this gateway** |
| 31 | **Tesseract OCR engine** | `config.screen.ocr.engine` = `winrt` (default) \| `tesseract` + `languages` + `tesseractPath`; `normalizeThaiOcr()` recomposes Thai sara-am; dashboard selector. **Layer 2 finally reads Thai** — WinRT never can (no `th-TH` pack exists) |
| 32 | **Signal hygiene** | five fixes read off the *real* 3,241-event log: `normalizeTitle()` kills spinner/unread-count title churn (51% of screen events were spinner frames; 790→386), `deadline` becomes clearable + an overdue one says so, post-commit hook installed, `judgeNote()` drops junk **voice** notes (typed `capture` always kept), Advisor dedup by intent+word-overlap instead of exact title |
| 32.1 | **Log compaction** | `compact [--apply]` rewrites history with the **same pure predicates as the live path** (so past and present agree by construction); dry-run default, backup to `.executive/backup-<ts>/`, `seq` never renumbered. Applied: screen 875→433, voice notes 1431→1365 |
| 33 | **Signal → Judgment** | (a) **real bug:** `ui` never persisted `digest.md`/`notifications.jsonl` — the refresh lived inline in `case "watch"` — so Phase 14's durable log was dead in the mode the owner actually runs; extracted `runDigestTick` (`src/report/tick.ts`) and wired both daemons. (b) `State.patterns` (pure, builder-computed, keeps the Planner's "State only" contract) + 3 pattern rules: `checkpoint_work`/`grinding_on_file`/`long_session`, all `ask`. (c) Advisor proposals must cite checkable `evidence`; generic advice + busywork banned in the prompt; `parseDrafts` **drops ungrounded drafts** |
| 33.1 | **Advisor live-validated** | the first real gateway call failed and exposed 3 defects the mock could never surface: `max_tokens` starvation (**3/3 runs**, output exactly 4096 → floor raised to 8192), a failure message that couldn't distinguish "out of budget" from "bad response", and the model reading raw ms as the wrong unit (`sessionMs: 2173707` → "~36 hours"; it is 36 **minutes**) → `patternsExplained` sends units in words |
| 34 | **Autonomy toggles** | `ui` carries the Advisor / infer / autopilot triggers that used to live only in `watch`, + an **Autonomy card** that re-reads config every tick (toggle without restart). `autopilot.apply` is deliberately **not** a dashboard toggle |
| 34.1 | **Runtime robustness** | three defects found by *reading the `ui` console*: `nextSeq`'s temp+rename lost an event to a transient Windows `EPERM` (AV/indexer holds `meta.json` for ms) → `renameOverwrite()` retries only `EPERM`/`EBUSY`/`EACCES`; `Bun.serve`'s 10s default `idleTimeout` was shorter than `/api/state` on a real log → 120s; and an executor test used `test: "true"`, which **is not a command in `cmd.exe`** → `exit 0` |
| 35 | **Jarvis layer — chat with hands** | `src/agent/`: a conversational front door that answers from real state (9 read tools) and **acts** (5 write tools) — every write parks for a one-tap confirm, and "ไว้ใจ tool นี้ตลอด" persists to `config.agent.trustedTools` (removes the prompt, never a guardrail). Two tool-call protocols (`native` + a `json` fenced fallback, `auto` downgrades on a 4xx naming `tools`) because gateway support is **unmeasured — every probe hit a 524 outage**. `edit_files` reuses Synth→Executor so code lands on `executive/change-*`. Chat panel + voice in/out, `/api/chat*`, `chat` CLI. Live-validated against a stub speaking the real Anthropic shape |
| 34.2 | **Atomic-write hardening** | review of 34.1 found the retry helper fixed **1 of 17** temp+rename sites (the per-tick `writeState`/`writePlan`/`writeDigest` are more exposed than `meta.json`) and that its 3 tests **all passed against plain `renameSync`**. `renameOverwrite` moved to `src/fs-atomic.ts` with an injectable `RenameIo` seam + real retry coverage; every atomic write routed through it; `idleTimeout` derived from `llmTimeoutMs` instead of a hardcoded 120 s that **equalled** the LLM client timeout; the 81 MB model download made non-blocking (polls the existing `/api/transcribe/status`) |

**Test count:** 527 passing, 100% offline (mock backends). Several phases **validated live** against the
9arm Qwen gateway (`work`, `synth`, `infer`, `propose`); Phase-25 vendor download + browser-wasm e2e run
live too. **Screen-sensing is fully live** (real capture → real OCR → real suggestions, both engines
compared on the same image), and the **Advisor is live-validated end to end** (Phase 33.1). **Not live:**
the Layer 3 vision call — it is **403 at the gateway**, not a code problem (§6).

**Where the system stands qualitatively (measured 2026-07-23, before Phase 33):** sensing was far ahead
of reasoning — State was accurate and near-fully auto-sensed (Layer 2 OCR summarised the owner's live
work from pixels alone), yet `plan.json` was `topAction: null`: **3,174 sensed events had produced 0
decisions**, because all four Planner rules only fired when something was *broken*. Phase 33 closed that
gap; the Planner now says things like *"113 edit(s) over 11.5h with no commit — checkpoint before the
change gets too big to review"* and it reaches the "Needs you" queue.

---

## 3. How to run / continue

```bash
bun install
bun run typecheck          # tsc --noEmit (strict) — must stay green
bun test                   # 527 tests, offline
bun run test:e2e           # OPT-IN browser-wasm e2e (real Chromium via Playwright; runs under node, auto-skips
                           #   if playwright/model aren't set up — see test/e2e/README.md)

bun run src/index.ts init  # create .executive/ (also adds .executive/ to .gitignore in a repo)
bun run src/index.ts ui    # dashboard at localhost:4317 (+ watches git/files); the main entry point now
```

**Daily use is `ui` alone.** It runs the watchers, rebuilds state + plan + digest + the durable
notification log on `state.intervalMs`, runs screen-sense Layer 2, **and (Phase 34) carries the
Advisor / infer / autopilot triggers** that used to live only in `watch`. All are off by default and
switchable from the dashboard's **Autonomy** card, which re-reads config every tick — **a toggle takes
effect without a restart**. `watch` remains the headless equivalent; running both is safe but redundant.

**`autopilot.apply` is intentionally not a dashboard toggle** — it is the only switch that lets the
runtime commit without a per-action human click, so arming it stays a deliberate `config.json` edit.
`updateAutonomyConfig` ignores it in both directions; the card only reports its state.

**Read the `ui` console — its warnings are not noise.** Phase 34.1 came entirely from two lines the owner
almost ignored: an `EPERM` on `meta.json` was silently costing events their `seq`, and a `Bun.serve`
timeout meant the dashboard was serving dead requests. A `⚠️ Needs you (…)` line, by contrast, *is* the
Planner working as designed.

**Every atomic write now goes through `renameOverwrite` in `src/fs-atomic.ts`** (Phase 34.2) — if you
add a new `.executive/` artifact, write it as temp + `renameOverwrite`, never a bare `renameSync`. On
Windows a plain rename onto an existing file is only *probabilistically* atomic (AV / the search indexer
hold a handle for a few ms), and the failure mode is silent: the caller catches, logs one line, and the
artifact is simply not updated.
Full command list is in `README.md` / `CLAUDE.md` and `printUsage()` in `src/index.ts`.

**Dev workflow (division of labor):** the architect (Claude) writes a **scope** in `docs/scopes/`, hands it
to **claude9arm** (a cheaper Qwen worker) to implement, then the architect **reviews + runs every acceptance
criterion for real** (never trusts the self-report), fixes defects, and commits. Every phase = one commit +
a `CLAUDE.md` phase entry.

- Delegate with `claude-9arm -p "<self-contained prompt>" --allowedTools Bash Read Edit Write Glob Grep`
  (there is a `qwen-agent` skill for this). The prompt must be **standalone** — qwen has none of the
  conversation's context — with absolute paths and explicit acceptance criteria.
- **⚠️ Run it from OUTSIDE the repo.** `CLAUDE.md` is now large enough that a headless `claude-9arm`
  started *inside* the repo auto-loads it and dies on the first request with
  `ContextWindowExceededError` (**99 k input tokens before doing any work**, against a 128 k window).
  Phase 34.2 lost a run to this. The working shape: `cd <scratchpad> && claude-9arm -p "…"
  --add-dir C:/Users/yiw20/Programming/myshi/executive`, with an explicit line in the prompt saying
  **"do NOT read CLAUDE.md / HANDOFF.md / GOTCHA.md — everything you need is in the spec"**, plus
  "work file by file, grep rather than reading whole files".
- **Delegation depends on Arm's box being up.** Phase 31's runs died to a gateway outage mid-task; when
  that happens the architect finishes the work rather than blocking. Split jobs so they touch **disjoint
  files** — a parallel run whose `bun run typecheck` sees another job's half-edited file will try to
  "fix" files it was told not to touch.
- **Review qwen's output rather than trusting it.** Real defects found so far: assertions hidden inside
  un-awaited `setTimeout` (a suite that passes against deliberately broken code), a `.replace()` with a
  string instead of a global regex (fixed only the first match), whole-file rewrites via a generated
  `tmp-*.js` script that flatten non-ASCII and leave litter behind, new `it()` blocks pasted *outside*
  the `describe()` whose fixtures they use, a header comment stating the exact opposite of what the
  tests do, and a dead `const thrown = calls` placeholder where the real assertion belonged.
- **Re-run the sabotage check yourself.** Phase 34.2's qwen run reported "tests 2,3,4,5,6 failed against
  the stripped implementation" and that turned out to be exactly right — but the whole point of the
  check is that it is the one claim you cannot verify by reading the diff. Break the code, run the
  suite, restore. It costs 30 seconds.

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
- **The floor is per-caller, and 4096 is not universally enough.** Phase 33.1: the Advisor hit
  `stop_reason: max_tokens` on **3/3** live runs (output exactly 4096) once its prompt started demanding
  evidence per proposal — a longer/stricter prompt buys more *thinking*, not just more output. It floors
  at **8192** (`llmMaxTokens(config, 8192)`) and completes at ~4.5k. **If you tighten a prompt, re-measure
  the budget live** — probe the gateway directly and look at `stop_reason` + `usage.output_tokens`.
- **A truncated answer is partly salvageable.** `salvageTruncatedArray()` (`src/advisor/anthropic.ts`)
  recovers the *completed* elements of a JSON array cut off mid-object (string-aware, so braces and
  escaped quotes inside strings don't fool it) rather than throwing away a good answer for one bad tail.
- **Never hand the model raw milliseconds.** It read `sessionMs: 2173707` as "~36 hours" — it is 36
  *minutes* — and repeated the same class of error on another run, so it is systematic, not a fluke.
  `explainPatterns()` sends units in words next to the raw numbers. Prefer pre-formatted values in any
  new prompt payload.
- Response parsing tolerates code fences / surrounding prose and extracts the JSON (`parseGuesses`,
  `parseDrafts`, etc.).
- **Make the LLM justify itself, then check the justification.** Phase 33 made every Advisor proposal
  carry an `evidence` string (ungrounded drafts are dropped at parse time). It measurably killed the
  horoscope-grade output — but it does **not** stop the model inventing a *subject*: one live run cited
  `sameFileSaves30m: 9` and `currentFile` correctly while proposing work on an "invoice quotation flow"
  that appears nowhere in the context. The evidence line is what makes that visible in seconds; treat it
  as an audit trail, not a guarantee.
- **Two API shapes:** everything text (worker/synth/infer/advisor) uses the **Anthropic** `/v1/messages`
  shape. **Vision (Phase 29, `qwen-vl-max`) is different** — the gateway's multimodal endpoint is
  **OpenAI-compatible** `POST /v1/chat/completions` with `image_url` base64 data-URL content parts
  (`src/screen/vision.ts`, response text at `choices[0].message.content`). Don't force images through the
  Anthropic client. Default `screen.vision.baseUrl`/`apiKeyEnv` fall back to `config.worker.*` at use time.
- **The team can only use `qwen3.6-35b-a3b`.** Any other model → `403 team_model_access_denied`. That is
  why Layer 3 vision cannot work here; only Arm can change it.

### Diagnosing "the LLM found nothing" (three different real causes, same symptom)
Every client used to swallow errors into an empty result, so **an outage looks exactly like a quiet day**.
Phase 29.2 fixed that for screen-infer (`ocr: llm unavailable — <reason>`); the others still report empty.
When something LLM-shaped goes silent, check in this order:
1. **Corporate TLS proxy (Zscaler).** The owner's work VPN MITMs TLS; `curl` works (Windows cert store)
   but **Bun's `fetch` uses its own CA store** → `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. Tell:
   `echo | openssl s_client -connect gateway.9arm.co:443` shows a `Zscaler Inc.` issuer. Fix: turn it off.
   (`NODE_EXTRA_CA_CERTS` also works, but **Bun ignores it from `.env`** — the TLS store initialises first.)
2. **Arm's inference box is down.** Cloudflare `524` after ~120s, and the direct call returns
   `litellm.InternalServerError: Cannot connect to host vllm.tetra-magellanic.ts.net:8000`. Even a
   one-word prompt times out. Nothing to fix on our side.
3. **Genuinely no signal** — only conclude this after ruling out 1 and 2 with a bare `fetch` probe.

### Windows / PowerShell gotchas (hard-won, Phase 28–31)
- **Defender/AMSI blocks screen capture:** a PowerShell script that does `CopyFromScreen` is flagged
  "malicious content" and refused — via `-Command` **and** `-File` alike. Not code-fixable without an AV
  exclusion; do **not** obfuscate to evade it (that's detection-evasion). Capture returns null → graceful.
  **An exclusion is in place on this machine**, so capture works; if it silently returns null again, check
  that first. Note this block **masked two real defects for a whole phase** — code that never runs never
  fails, so a "graceful degradation" path can hide broken code indefinitely.
- **`Image.Save(path, format, encoderParams)` does not bind** — the 3-arg overload wants an
  `ImageCodecInfo`; resolve it via `GetImageEncoders()` matched on `[ImageFormat]::Jpeg.Guid`.
- **WinRT `StorageFile` rejects mixed separators** (`C:\dir/tmp/x.jpg`) with an `AggregateException` even
  though the file exists — `normalize()` every path before it crosses into PowerShell.
- **There is no Thai OCR pack for `Windows.Media.Ocr`, and there never will be** — Windows ships 36 OCR
  languages and `th-TH` is not one. Use `config.screen.ocr.engine = "tesseract"` (Phase 31) for Thai.
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

### ✅ Screen-sensing is DONE and running — nothing is blocked
State on this machine: Defender exclusion in place, `screen.ocr.enabled = true`, `engine = "tesseract"`,
`languages = "tha+eng"`, Tesseract 5.4 + `tha.traineddata` installed. A capture writes suggestions to
`.executive/screen-inferred.json`, surfaced in the digest / dashboard "Suggestions (unconfirmed)" with a
Confirm button. Ethics held: opt-in, visible "🔴 reading screen" indicator, own-screen only.
Layer 3 (vision) stays off — `qwen-vl-max` is 403 at the gateway; it fails cleanly if enabled.

### ⏭️ Candidate A — surface `State.patterns` in the digest / dashboard
Phase 33 computes `patterns` (`sessionMs`, `msSinceLastCommit`, `editsSinceLastCommit`,
`sameFileSaves30m`, `repoSwitches1h`) and the Planner + Advisor both reason over them, but the owner
cannot see the numbers a proposal cites without opening `state.json`. A "Working pattern" line in the
digest and a Now-card row would close that loop. Cheap and read-only — the values already exist.

### ⏭️ Candidate B — pick the OCR language from the window title
`-l tha+eng` **hallucinates Thai on screens that contain none**. Measured on one real screenshot:
`-l eng` → 0 Thai chars / 8 English words; `-l tha+eng` → **59 garbage Thai chars** / 7 English words —
so `tha` also costs a little English accuracy. It is *not* a resolution artifact (native 1536×960 gives
the same garbage), and the LLM still read the screen correctly, so this is noise rather than breakage.

The fix is cheap and uses what already exists: Layer 1 already puts the active window title in
`State.currentWindow` **with Thai intact** (it is a `GetWindowTextW` call, not OCR). Derive the language
list from it — Thai characters in the title → `tha+eng`, otherwise `eng` — instead of always sending both.
`config.screen.ocr.languages` stays the manual override. Everything needed is in `src/state/types.ts`
(`currentWindow`) and `src/screen/screen-infer.ts` (which already reads the config block).

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
- **Screen-sensing beyond title** is fully live (Phase 29/29.1/29.2/31). No always-on/hidden capture —
  deliberately out of scope (third-party consent), and that boundary was re-affirmed when asked to make
  listening covert.
- **A better Thai OCR pipeline** (confidence filtering via Tesseract's TSV output, `--psm` tuning,
  cropping to the foreground window instead of the whole screen). Only worth it if the noise above
  actually degrades suggestions — right now it does not.

---

## 7. Layout quick-map

```
src/
├── events/        # JSONL EventStore, seq, types
├── watchers/      # git + fs watchers
├── state/         # State Builder (state.json/context.json) — incl. task/project inference
│                  #   patterns.ts = behavioural metrics (pure) so the Planner can read State only
├── planner/       # rule-based Planner (plan.json) + rules.ts (4 breakage rules + 3 pattern rules)
├── worker/        # LLM Worker (Proposal) — mock|anthropic + identity (claude.md)
├── executor/      # applies ChangeSet on isolated branch (git, deterministic)
├── synth/         # Synthesizer (Proposal→ChangeSet)
├── auto/          # Autopilot orchestrator + guard (continuous-autonomy dedup)
├── report/        # Digest (digest.md, "Needs you") + notify (notifications.jsonl)
│                  #   tick.ts = the shared digest+notification step BOTH `watch` and `ui` must call
├── capture/       # judgeNote() — drops junk voice notes before they reach the Advisor
├── compact/       # `compact` — rewrites history with the same predicates as the live path
├── infer/         # LLM block/deadline guesses (inferred.json)
├── advisor/       # proactive proposal queue (advisor.json)
├── hooks/         # install-hooks (post-commit test emitter)
├── screen/        # Layer 1 capture.ts (window title) + Layer 2/3 screenshot.ts/ocr.ts/vision.ts/screen-infer.ts
│                  #   ocr.ts holds BOTH engines: runWinRtOcr (PowerShell/WinRT) + Tesseract (plain exe)
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
