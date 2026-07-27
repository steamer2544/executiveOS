# ExecutiveOS — GOTCHA.md

> Hard-won traps and non-obvious failure modes, collected so nobody re-learns them the slow way.
> Each entry: **symptom → cause → fix**, with the phase that surfaced it. Pairs with `CLAUDE.md`
> (phase log), `HANDOFF.md` (cold-start), `README.md` (user-facing).
>
> **Owner is Thai and cannot read Chinese — respond in Thai or English only.**

---

## 1. LLM gateway (the 9arm Qwen)

- **Reasoning models spend `max_tokens` on "thinking" before the answer.** *Symptom:* a real call
  returns `content:[]` / `stop_reason:"max_tokens"` and errors, but only in production (mock tests
  pass). *Cause:* Qwen3.6 emits a hidden think phase that counts toward the output budget; `1024` was
  too small. *Fix:* the shared `llmMaxTokens(config, floor=4096)` + `llmTimeoutMs(config, floor=120000)`
  in `src/config.ts` — every LLM factory (worker/synth/infer/advisor/vision) must use them. `/no_think`
  made it *worse*; headroom is the lever. (Phase 19/20)
- **`temperature: 0` (greedy decoding) makes Qwen LOOP in its think phase and burn the WHOLE budget
  with no answer.** *Symptom:* the agent replied "ขอโทษครับ พัง: … stop_reason: max_tokens" to a
  perfectly normal question ("planner คืออะไร") — `usage.output_tokens` = the entire cap, `content:[]`,
  ~90s. Raising `max_tokens` did NOT help (40k → still ran away, then a 524); it is a *loop*, not a
  budget shortfall. *Cause:* Qwen's own docs warn that greedy decoding "can lead to endless repetitions"
  in thinking mode. *Measured live on the exact failing prompt:* `temp 0` → always loops · `temp 0.3` →
  loops · `temp 0.6` alone → ~1/3 loops · `temp 0.6 + top_p 0.95 + top_k 20` (Qwen's recommended
  thinking-mode sampling) → **still ~25%** (an early "5/5" reading was luck; an 8-run stress test found the
  true rate). `/no_think` and `chat_template_kwargs:{enable_thinking:false}` are **ignored by this gateway**
  (both still looped). *Fix (two parts):* (1) the agent backend (`src/agent/protocol.ts` `step()`) sends
  `temperature:0.6, top_p:0.95, top_k:20`; (2) because sampling only halves the rate, `step()` **re-samples
  an empty `max_tokens` up to 3×** (`SAMPLE_MAX=4`, `isEmptyMaxTokens`) — each roll is independent, so ~25%
  → ~0.4%. Keep `max_tokens` at 8192: lowering it makes a genuinely-hard question (long legit thinking)
  *truncate into* an empty-max_tokens and fail, trading one bug for another. **Isolation that found it:**
  plain system + the 15 tools → normal `tool_use` in 3s; the *agent system prompt* (identity +
  AGENT_CONTRACT) is what tips it into the loop — trigger is the prompt, cure is sampling + re-sample.
  Other backends (worker/synth/infer) still use `temperature:0` and could hit this on a reasoning-heavy
  prompt — give them the same treatment if they ever return an empty `max_tokens`.
  **⚠️ SUPERSEDED IN PART — read the next entry.** The sampling half stands. The *recovery* half above
  (`SAMPLE_MAX=4` re-sampling, and the later `BUDGET_LADDER` that escalated the ceiling) was built on two
  premises that later measurement **disproved**: rolls are not independent, and a bigger ceiling cannot
  come back at all. Both were removed.
- **🧱 THE GATEWAY KILLS ANY REQUEST AT ~125 s — so there is a hard ceiling on output tokens, and
  `max_tokens` above it is a lie.** *Symptom:* the Discord bot answered "สวัสดี" with "gateway ตอบช้า
  เกินไป (ลองอัตโนมัติ 2 ครั้งแล้ว)" — three times, an hour apart, while the gateway was demonstrably
  healthy (a bare `hi` returned 200 in 1.8 s). *Cause, measured:* Cloudflare in front of the origin cuts
  every request at ~125 s (observed 125.0 / 125.1 / 125.7 / 126.4 / 127.0 / 128.2 s), and the model
  generates at **33–48 tok/s** on a real 21 k-token agent request — *slower the longer it runs*. So:
  · 3072 tokens → came back 6/6, in 47–72 s · 4096 → 5/6, in 85–124 s (the 6th hit the wall)
  · **8192 → never**. The agent's base budget was 8192 and its ladder escalated to 16384/32768 —
  **responses that can never physically exist.** Attempt 1 aborted at our 120 s deadline, the retry asked
  for *twice as much* and aborted again: 4 minutes to produce one apologetic sentence.
  **Streaming does NOT escape it** — with `stream:true` exactly two SSE chunks arrive (`message_start`,
  `content_block_start`) and then the socket is silent for the entire think, because the gateway does not
  emit thinking tokens; the proxy sees an idle connection and cuts it identically.
  *Fix:* `WALL_SAFE_MAX_TOKENS = 3072` clamps the ceiling (config may lower it, never raise it) and
  `WALL_SAFE_TIMEOUT_MS = 115_000` aborts before the wall so we classify the stall instead of parsing a
  Cloudflare HTML page. **Anything that raises `max_tokens` for the agent is a no-op at best.**
- **The context is the lever, not the ceiling — and a spiral is near-deterministic per context.** Same
  incident. The old code re-rolled an empty `max_tokens` at the same ceiling on the theory that each roll
  was an independent ~25% risk. Measured on the transcript that triggered it: **0/7 with the full history,
  0/3 at 40 items, 0/3 at 20 items** — the same context reproduces the spiral, so re-rolling only buys
  another ~2 minutes of failing identically. Meanwhile **the last few turns answered 3/3 and a single turn
  4/4.** *Fix:* the ceiling ladder was **inverted into a context ladder** — `CONTEXT_LADDER = [null, 3, 1]`
  in `src/agent/loop.ts`; the backend raises a typed `ContextTooHeavyError` and the loop retries with less
  history, telling the owner when it had to. *Note it is not simply "shorter is better":* 40 items once
  answered where 20 did not — the spiral is content-dependent, so trim toward the recent turns rather than
  assuming a size threshold. **Beware the failure mode this created once:** a rung that trims to the same
  transcript as the previous one must be **skipped, not treated as the end of the ladder** — stopping there
  meant a short conversation never reached the single-turn rescue and failed outright (caught live).
- **A conversation degrades itself.** Every failed turn leaves the owner's message in
  `conversation.jsonl` with no assistant reply, so the next attempt carries one more orphan and a bigger
  context. Three failed "สวัสดี" in a row is a *self-reinforcing* state, not three unlucky rolls.
  If the agent has started failing consistently, look at the transcript before suspecting the gateway.
- **A code fix does NOT reach a running daemon until it restarts.** The owner kept seeing the think-loop
  error *after* the fix was pushed because their `ui`/Discord bot process was still running the old
  `protocol.ts` in memory. `config.json` is re-read every tick (hot), but **source is loaded once at
  process start.** After any code change to the agent/watchers/server, tell the owner to restart `ui`.
- **Two different API shapes — do not mix them.** All text (worker/synth/infer/advisor) speaks the
  **Anthropic** `POST /v1/messages` shape (text at `content[].text`). **Vision (`qwen-vl-max`, Phase 29)**
  speaks the **OpenAI-compatible** `POST /v1/chat/completions` with `image_url` base64 data-URL content
  parts (text at `choices[0].message.content`). Don't try to push images through the Anthropic client.
  (Phase 29 · `src/screen/vision.ts`)
- **The gateway team is restricted to `qwen3.6-35b-a3b` — vision is NOT available.** *Symptom:* Layer 3
  returns `HTTP 403 team_model_access_denied: This team can only access models=['qwen3.6-35b-a3b']. Tried
  to access qwen-vl-max`. *Cause:* per-team model allow-list on the gateway, nothing to do with our code.
  *Fix:* none available to us — Layer 3 needs either a different multimodal endpoint/key or the owner
  asking Arm to allow the model. **Layer 2 (on-device OCR → text LLM) is the working screen path** and it
  keeps the image local anyway. The failure is now reported as `vision: unavailable — …`, not silently.
  (Phase 29.2 live)
- **Never let a hard failure return the same value as "found nothing".** Every LLM client used to
  `catch { return [] }`, so a TLS error, a 401 and a genuinely empty answer were indistinguishable
  downstream — the digest just said "no signal". `screen-infer` now throws inside `defaultTextInfer` and
  reports `ocr: llm unavailable — <reason>`. Apply the same rule to any new client. (Phase 29.2)
- **The auth token loads from `.env` in the *cwd*.** *Symptom:* live calls 401 in a test/temp dir.
  *Cause:* Bun auto-loads `.env` from the working directory only. *Fix:* run from a dir that has `.env`
  (key `EXECUTIVE_WORKER_KEY`), or copy it in. The key lives **only** in the env var — never in
  `config.json`, never in source.
- **Latency is variable (6s → 120s) and occasional timeouts are normal.** The daemon calls are
  fire-and-forget behind a cooldown + in-flight lock; a slow/failed call must never block a rebuild tick.
- **Response parsing must tolerate prose + code fences.** The model wraps JSON in ```json fences or chatty
  text; every parser strips fences and extracts the first `{…}`…last `}` before `JSON.parse`.
- **A corporate TLS proxy (Zscaler) silently kills every gateway call.** *Symptom:* every LLM feature
  reports its own polite "nothing found" — screen-infer says `"ocr: no signal"`, the advisor proposes
  nothing — because each client catches *all* errors and returns `[]`. *Cause:* the proxy re-signs the
  cert with a corporate root; `curl` succeeds (Windows cert store) but **Bun's `fetch` uses its own
  bundled CA store** → `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. *Diagnose:* `echo | openssl s_client -connect
  gateway.9arm.co:443` — a `Zscaler Inc.` issuer is the tell; or ping the gateway with a bare `fetch` and
  read the thrown error. *Fix:* turn the proxy off (it is the owner's work VPN, not always on). If it ever
  must stay on: `NODE_EXTRA_CA_CERTS=<corp-root.pem>` — but note **Bun does NOT honor it from `.env`**
  (the TLS store initializes before `.env` loads); it must be a real process env var, or use Bun's
  per-request `fetch(url, { tls: { ca } })`. Not a product bug — do not "fix" it in code. (Phase 29 live)
- **An empty `max_tokens` is usually a CEILING problem, and re-sampling alone CANNOT fix it.**
  *Symptom:* the agent answers a normal question fine, then fails a bigger one with *"the model used
  its entire token budget thinking and produced no answer"* — after burning 3–5 minutes.
  **This is NOT the temperature-0 think-loop above.** That one was a genuine non-terminating loop and
  raising `max_tokens` to 40k did **not** help. This one is the opposite: with Qwen's recommended
  sampling the thinking *does* terminate, it just needs more room than the 8192 floor. Both are true —
  do not use one to dismiss the other. *Measured live* (owner's transcript, `input_tokens` 21,493,
  15 tool schemas, asking it to build a desktop calculator): at **8192 → 1/8 runs answered**, and every
  failing run reported `output_tokens` **exactly 8192 on all four attempts**; at **32768 → 4/4
  answered**; calls that DO answer cost **937–2,775** output tokens. So the old comment's premise —
  "each roll is independent at temperature>0, so re-sampling 3× drives 25% → 0.4%" — was measurably
  wrong here: four fresh rolls produced four identical exhaustions. **The loop rate is
  prompt-dependent** (~25% on a meta-question, ~93% on an open-ended agentic ask); never generalise one
  prompt's rate. *Fix:* `BUDGET_LADDER` in `src/agent/protocol.ts` — attempt *n* gets 1x/2x/4x/4x the
  configured ceiling, so the common cheap turn stays cheap and headroom is bought only after the model
  proves it needs it (verified 6/6 after, vs 1/8 before). *Diagnosing a new instance:* the only reliable
  signal is `usage.output_tokens` + `stop_reason` **per attempt** — drop a temporary `[DBG-…]` probe
  right after `res.json()`. Every attempt pinned to the ceiling → ceiling problem; wildly varying
  numbers → real loop. *Price:* a prompt that needs the ladder answers in ~190–290 s. If that becomes
  the complaint, the lever is the 21k input tokens (system prompt + 15 tool schemas + 20 history
  turns), not the ceiling.

## 2. Windows / PowerShell

- **`Bun.spawnSync(["cmd.exe","/c", cmd])` EATS the inner double quotes — and the command then
  silently answers about the wrong thing.** *Symptom:* `run_command` reported a folder MISSING that
  `Test-Path` confirms exists; the agent told the owner their project folder did not exist.
  *Cause:* Bun escapes `"` when it builds the Windows command line, so cmd receives `\"C:\path\"`
  and treats the quote as part of the name. Measured: `if exist "C:\Users\…\project"` → MISSING,
  the unquoted form → FOUND. **This does not error** — you get a confident wrong answer, which is
  worse. *Fix:* write the command to a temp `.bat` and run `cmd.exe /d /c <file>` — a file has no
  quoting layer at all (`shellFor`/`cleanupShell` in `src/agent/tools.ts`; `src/screen/*.ts` reaches
  for the same trick with PowerShell). Most real commands quote a path, so assume this bites
  everything, not an edge case. (Phase 41)
- **`sh -c` is not available on Windows — and whether it *looks* available depends on the parent
  shell.** *Symptom:* every `run_command` returns `Executable not found in $PATH: "sh"` for the
  owner, while the identical code passes in testing on the same machine. *Cause:* Git Bash puts `sh`
  on PATH, so a daemon started from Git Bash works and one started from PowerShell does not. *Tell:*
  "works for me" where the only difference is the terminal you launched from. (Phase 41)
- **Windows Defender/AMSI blocks screen-capture scripts.** *Symptom:* `captureScreen` fails with "This
  script contains malicious content and has been blocked by your antivirus software" (exit 1).
  *Cause:* a spawned PowerShell doing `Graphics.CopyFromScreen` trips the AV screen-grab heuristic — via
  `-Command` **and** `-File` alike. *Fix:* there is **no code fix** — the owner adds a Defender exclusion
  for the runtime. **Do NOT obfuscate/encode to evade it** (that is detection-evasion, off-limits even for
  a legit feature). Capture returns `null` → the feature degrades gracefully (no crash, "no signal").
  **Resolved on this machine (Phase 29.1):** with the exclusion in place, capture works — a real
  screenshot + OCR of the live screen was validated end-to-end. (Phase 29)
- **`Image.Save(path, format, encoderParams)` does not exist.** *Symptom:* the capture `.ps1` exits
  non-zero with "Cannot find an overload for Save". *Cause:* the 3-argument overload takes an
  **`ImageCodecInfo`**, not an `ImageFormat` — passing `[ImageFormat]::Jpeg` alongside `EncoderParameters`
  never binds. *Fix:* resolve the encoder by GUID —
  `[ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.FormatID -eq [ImageFormat]::Jpeg.Guid }`.
  (Phase 29.1 · `src/screen/screenshot.ts`)
- **WinRT `StorageFile.GetFileFromPathAsync` rejects mixed-separator paths.** *Symptom:* OCR throws
  `AggregateException` even though the file plainly exists. *Cause:* paths built by `"/"`-concatenation
  (`C:\dir/tmp/shot.jpg`) are fine for `System.Drawing` but WinRT demands an OS-native absolute path.
  *Fix:* `normalize()` the path before spawning — done on **both** sides (producer `captureScreen`
  returns a normalized path, consumer `ocrImage` normalizes defensively). (Phase 29.1)
- **Windows.Media.Ocr has NO Thai language pack — Thai is unreadable by Layer 2, permanently.**
  *Symptom:* Thai on screen OCRs to garbage (`แชท` → `FE uazå-uüum%io`); Settings has no OCR checkbox
  under the Thai language. *Cause:* not a missing install — Windows simply does not ship one.
  `Get-WindowsCapability -Online -Name "Language.OCR*"` (needs elevation) lists **36** languages
  including ar/zh-CN/zh-HK/zh-TW/ja/ko/ru and most of Europe — **`th-TH` is not among them**, so
  `TryCreateFromLanguage("th")` can never succeed. *Fix:* none within the WinRT OCR engine. Options are a
  different local engine (Tesseract `tha.traineddata`), a multimodal LLM (blocked here — see §1), or
  accepting English-only OCR. **Layer 1 window titles still carry Thai fine** (that path is a Win32
  `GetWindowTextW`, not OCR). (Phase 29.3)
- **Tesseract emits Thai sara-am DECOMPOSED — recompose it or nothing matches.** *Symptom:* OCR returns
  `กํา` (ก + U+0E4D nikhahit + U+0E32 sara aa) where the owner would type `กำ` (ก + U+0E33), so string
  comparisons and the LLM both see something subtly wrong. *Cause:* the Thai model's output convention.
  *Fix:* `normalizeThaiOcr()` in `src/screen/ocr.ts` — and the replace **must be a global regex**
  (`/ํา/g`); a string first argument to `.replace()` fixes only the FIRST occurrence, leaving every later
  sara-am word decomposed. `.normalize("NFC")` alone does NOT recompose this pair. (Phase 31)
- **Adding `tha` to the Tesseract language list hallucinates Thai on screens that have none.** *Symptom:*
  a purely English screen OCRs to lines like `๓๐๒[35๐5[พ๓๐ร๓พยิ...`. *Measured on one real screenshot:*
  `-l eng` → 0 Thai chars / 8 English words; `-l tha+eng` → 59 (garbage) Thai chars / 7 English words —
  so `tha` also costs a little English accuracy. It is **not** a resolution problem (native 1536×960 and
  the 1280px downscale produce the same garbage). *Fix:* the noise is tolerable (the LLM still read the
  screen correctly), and `config.screen.ocr.languages` is settable — use `eng` when working in English.
  A smarter future option: pick the language list from the Layer 1 window title. (Phase 31)
- **WinRT async needs an STA apartment.** *Symptom:* `Windows.Media.Ocr` / `StorageFile` calls throw
  `AggregateException` at `$task.Wait(-1)`. *Cause:* a bare spawned `powershell` is MTA for WinRT
  purposes. *Fix:* spawn `powershell -Sta`, and await `IAsyncOperation<T>` via the
  `[System.WindowsRuntimeSystemExtensions].AsTask` generic-method bridge (not a hand-rolled callback
  loop). (Phase 29 · `src/screen/ocr.ts`)
- **Non-ASCII from PowerShell gets mangled to `?`.** *Symptom:* a Thai window title arrives as `???`.
  *Cause:* two layers — `[DllImport("user32.dll")]` defaults to `CharSet.Ansi` (binds `GetWindowTextA`,
  flattening Unicode *before* capture), and PowerShell's stdout defaults to the OEM codepage. *Fix:* need
  **both** `CharSet=CharSet.Unicode` on the P/Invoke **and** `[Console]::OutputEncoding =
  [System.Text.Encoding]::UTF8`; decode the pipe as UTF-8. (Phase 28 · `src/screen/capture.ts`)
- **`Graphics.CopyFromScreen` is a 1:1 blit, not a scaling copy.** *Symptom:* a "downscaled" screenshot
  is actually the cropped top-left corner. *Cause:* copying the full `$screen.Size` into a smaller bitmap
  just clips. *Fix:* capture at native resolution into a full-size bitmap, then `Graphics.DrawImage` into
  the smaller target to truly downscale. (Phase 29 · `src/screen/screenshot.ts`)
- **Prefer a temp `.ps1` via `-File` over a giant inline `-Command`.** Cleaner (no shell-escaping of a
  huge script), pass data as `$args[0..]`. (It does **not** defeat the AMSI block above.) (Phase 28/29)
- **Graceful SIGINT only on a real console Ctrl-C.** Programmatically-sent signals hard-terminate the
  `watch`/`ui` daemon on Windows (it still exits, doesn't hang) — don't rely on clean-shutdown side
  effects in a scripted kill. (Phase 2)
- **Playwright's Chromium pipe transport hangs under Bun.** *Fix:* the e2e driver runs under **`node`**
  (`bun run test:e2e` shells to `node …`), while the UI server it drives runs as a `bun` subprocess.
  (Phase 25.4 · `test/e2e/`)
- **`rename()` onto an existing file fails with `EPERM` on Windows for no lasting reason.** *Symptom:*
  `StoreSink error: EPERM: operation not permitted, rename 'meta.json.<uuid>' -> 'meta.json'` in a
  running `ui`, then the daemon carries on. *Cause:* Windows refuses to replace a destination while any
  other handle is open on it, and antivirus / the search indexer opens a file for a few ms right after
  it is written — an atomic temp+rename is therefore *probabilistically* fragile, not reliably atomic.
  *Impact:* that event lost its `seq` and was never persisted. *Fix:* `renameOverwrite()` retries
  `EPERM`/`EBUSY`/`EACCES` with a short synchronous backoff (140 ms total — 5,10,15…35 across 7 retries)
  and rethrows anything else immediately; a genuine second writer still surfaces instead of being papered
  over. **Every atomic write in the tree now goes through `renameOverwrite` in `src/fs-atomic.ts`
  (Phase 34.2)** — the same fragility applied to `writeState`/`writePlan`/`writeDigest`/the config
  updaters, which are rewritten every tick. (Phase 34.1 + 34.2 · `src/fs-atomic.ts`)
- **`true` is not a command in `cmd.exe`.** *Symptom:* an executor test that runs `test: "true"` reports
  `testPassed:false` — the assertion of the PASS path was red for a reason that had nothing to do with
  the executor. *Cause:* `spawnSync(cmd, { shell: true })` is `cmd.exe` on Windows, where the POSIX
  `true`/`false` binaries don't exist, so the spawn itself fails. *Fix:* use **`exit 0` / `exit 1`**,
  which work in both `cmd` and POSIX `sh`. (Phase 34.1 · `src/executor/executor.test.ts`)

## 3. State Builder (the derivation everyone reads from)

- **"Newest event wins" has no expiry.** *Symptom:* the dashboard shows a task/file from days ago that
  nothing has superseded (e.g. on the default branch with no newer `system.task`). *Cause:* each field is
  just the newest event of its kind, forever. *Fix (per field):* `currentFile` is filtered to files that
  still exist on disk; `system.task` can be **cleared** with an empty task. There is intentionally no
  time-based TTL (a real task can span days). (Phase 30)
- **The FsWatcher watches `<repo>/src`, so `editor.save` paths are relative to *that* dir.** *Symptom:*
  the existence filter drops every real file (`currentFile` always null). *Cause:* a path recorded as
  `synth/foo.ts` (relative to `<repo>/src`) doesn't exist relative to the repo root. *Fix:*
  `fileResolutionRoots()` resolves against the actual watched dirs (`repos[].filePaths ?? path+"/src"`,
  legacy `fs.paths`) plus cwd + cwd/src. (Phase 30 · `src/state/builder.ts`)
- **`existsSync` returns true for directories.** *Symptom:* a bare watcher path like `state` or `synth`
  (which resolve to the `src/state` / `src/synth` **dirs**) becomes `currentFile`. *Fix:* check
  `statSync(p).isFile()`, not `existsSync`. (Phase 30)
- **The FsWatcher must ignore temp/scratch files or they pollute `currentFile`.** *Symptom:* `currentFile`
  stuck on a deleted `report/.tmp-notify-test`. *Cause:* the watcher recorded atomic-write temps
  (`page.ts.tmp.<pid>.<rand>`), dotfiles, vim swaps. *Fix:* `isIgnoredPath()` ignores dotfile/dot-dir
  segments (not `.`/`..`), a `.tmp.`/`.temp.` infix, and temp/backup suffixes. (`src/watchers/fs.ts`)
- **An empty `system.task` must CLEAR, not be silently skipped.** *Symptom:* no way to remove a stale
  task. *Cause:* the old builder only set the field when the value was non-empty. *Fix:* three-way — key
  absent → unchanged, non-empty → set, empty/whitespace → clear to `null` (then the branch/repo fallback
  applies). The dashboard "Clear task" button posts an empty `system.task`. (Phase 30)
- **`state.repos` must be ordered by `seq`, not wall-clock `ts`.** *Symptom:* a ~50% flaky test; `repos[0]`
  and `activeRepo` sometimes disagree. *Cause:* two events in the same millisecond tie on `ts`. *Fix:* sort
  by the monotonic `latestActivitySeq` — the same "highest seq wins" rule `activeRepo` uses. (Phase 26.1)

## 4. Testing (how to not ship a green-but-fake suite)

- **A `toContain` substring assertion on a merged config passes for the WRONG object.** *Symptom:*
  Phase 43's decisive sabotage — moving `backupConfig()` to *after* the write, so the backup preserves
  the **new** bytes and is worthless — left **all 13 tests green**. *Cause:* the criteria asserted
  `expect(backupContent).toContain('"enabled": false')`, and `loadConfig()` merges in defaults, so the
  written config is full of default-off blocks (`screen.window`, `vision`, …). The substring is present
  either way. *Fix:* `JSON.parse` and assert the **specific field** (`advisor.enabled`), so the wrong
  object fails. *Rule:* when a test asserts on a serialized blob, ask what else in that blob could
  satisfy the assertion. (Phase 43)
- **`chmod` cannot make a write fail on Windows.** *Symptom:* two tests named "backup directory
  unwritable" and "a backup failure does not block the write" both passed — and would have passed with
  the feature deleted. *Cause:* `chmodSync(dir, 0o444)` on Windows only toggles the read-only flag and
  **does not prevent creating files inside the directory** (verified: the write succeeded), so the
  backup never failed and `expect(...).not.toThrow()` was trivially true. *Fix:* plant a regular **file**
  where the directory belongs — `mkdirSync` then throws `EEXIST`, portably. *And* assert the failure was
  real (`listConfigBackups()` is empty), not merely that nothing threw. (Phase 43)
- **An ordering assertion needs ≥3 elements, and must not sort the array it checks.** *Symptom:*
  `expect(names).toEqual([...names].sort().reverse())` — green for any input, and doubly meaningless
  with the single element the fixture produced. *Fix:* build three items with known content and assert
  the literal expected order. (Phase 43)
- **A sabotage that does not actually break anything proves nothing.** *Symptom:* a delegated run
  reported sabotage 5 (`introduce a backslash into page.ts`) as done, and left
  `var _sab = "test\<newline>";` in the source. *Cause:* a backslash **before a newline** is a
  *line continuation* — it vanishes and the emitted script stays valid JS, so the guard could never
  fire. *Fix:* verify the check goes **red** with your own eyes before trusting it; for §8 specifically,
  use a backslash that breaks syntax (`/\(/` → `/(/`). *Bonus trap:* the run also left the sabotage
  **in the committed-ready tree** — read the full diff for stray `_sab` / `tmp-*.js` / `.bak`
  scaffolding. (Phase 44)
- **Generating source through a shell heredoc can plant INVISIBLE control characters.** *Symptom:* a
  freshly written function returned `null` for every input; the source on screen looked correct and
  `tsc` was green. *Cause:* a `python - <<'PY'` heredoc turned `\b` inside a regex into a literal
  **U+0008 backspace**, so `/<script\b/` was really `/<script␈/` and never matched. The character is
  invisible in `cat`, in the editor, and in a diff. *Tell:* `fn.toString()` shows the escape as a control char (Bun prints it as \u0008); or
  `grep -rlP '[\x00-\x08\x0b\x0c\x0e-\x1f]' src/`. *Fix:* write regex- or escape-heavy code with the
  editing tool directly, never through a shell/python layer — and if you must, re-read the emitted
  bytes, not the terminal echo. Same family as §8's template-literal trap, one layer further out.
  (Phase 41)
- **Assertions inside an un-awaited `setTimeout` never run.** *Symptom:* a test "passes" even against
  deliberately-broken code. *Cause:* the test function returns before the timer fires, so bun marks it
  passed; a later throw isn't attributed. *Tell:* the `expect() calls` count is far lower than the number
  of asserts you wrote. *Fix:* make the test `async` and `await` a delay (return the promise), and
  **sabotage-check** — break the code and confirm the test now fails. (Caught in Phase 28; the same
  discipline confirmed Phase 30's tests.)
- **`bun -e "...'$WINPATH'..."` silently eats backslashes.** *Symptom:* a Windows path passed into a `-e`
  one-liner arrives mangled (`C:Usersyiw20…`), so a file "doesn't exist" and the code looks broken.
  *Cause:* JS string escapes (`\U`, `\A`, …) inside the interpolated source. *This is a test-harness bug,
  not a product bug.* *Fix:* pass Windows paths via `process.env`, never interpolated into the `-e` string.
  (Phase 27 scare + Phase 29)
- **Fixtures that reference non-existent file paths break once a real existence check lands.** e.g. the
  Phase-7 synth State-fallback fixture used fake `src/*.ts` paths; Phase 30's filter dropped them. *Fix:*
  create the files on disk (or point `config.watch.repos` at the temp dir) so the fixture reflects reality.
  (Phase 30 · `src/synth/synth.test.ts`)
- **Bun test flakiness from wall-clock ties.** Any ordering that falls back to `ts` can tie at
  millisecond resolution → non-deterministic. Order by `seq`. (see §3, Phase 26.1)
- **Isolate runtime data with `EXECUTIVE_HOME`.** Point it at a temp dir so tests never touch the real
  `.executive/`. All path helpers resolve under `execRoot()` which honors it.
- **Sabotage-check the threshold *exactly*, not just either side of it.** Phase 33 broke four things on
  purpose; three tests caught it, but flipping a session-break comparison from `>=` to `>` **escaped**,
  because the fixtures used gaps of 14 and 16 minutes and never one of exactly 15. *Fix:* for any
  constant a rule compares against, assert the boundary value itself. A sabotage that survives is telling
  you the suite has a hole, so run the check on every new threshold.
- **A test named for an invariant may not test it.** `planner.test.ts`'s "RULES and planner do not import
  event store" only asserted `RULES.length === 4` — it would have passed happily if `rules.ts` had
  started reading the event log, and it broke for the *wrong* reason (a legitimate 5th rule) in Phase 33.
  *Fix:* if the name makes an architectural claim, check the claim (read the source, assert on its
  imports) and put the count in its own test.
- **Kill leftover daemons before trusting a live daemon test.** A `ui`/`watch` run left behind by an
  aborted attempt keeps ticking against the same `EXECUTIVE_HOME` and writes the very artifacts the new
  run is supposed to produce — Phase 34's toggle test "passed" against a file the stale process had made
  minutes earlier. *Tell:* the artifact exists *before* the step that should create it. *Fix:*
  `Get-Process bun` and stop the strays (mind the owner's own long-running dashboard), then re-run from a
  fresh temp dir.
- **When a test fails, ask whether the fixture or the code is wrong.** Phase 33 hit this twice: a
  needs-you item is keyed on the action `kind`, so two `resolve_block` plans with different reasons are
  correctly *one* item; and a "session" fixture used 1-hour gaps that all exceed the 15-minute break.
  Both times the code was right. (Same lesson as Phase 32.1's window-adjacency expectation.)

## 5. Config & secrets

- **Backward-compatible defensive merge — absence means "off".** `defaultConfig()` deliberately omits
  optional blocks (`screen`, `infer`, `advisor`, `autopilot`…); `loadConfig()` fills sub-fields only when
  the block is *present*. Adding a block to `defaultConfig()` when "absent = off" would silently enable it
  for every existing config. Every new toggle defaults **false**. (Phase 28/29 pattern)
- **Secrets live only in `process.env[apiKeyEnv]`.** `config.json` stores the env-var **NAME**, never the
  value. `GET /api/config` may return the whole `transcribe`/`screen` block (the settings editor needs it)
  because it holds no secret — and there's a test asserting the key **value** never appears in the response.
  Keep it that way. (Phase 24/25/29)
- **`updateXConfig(patch)` writes the whole merged config** (materializing defaults) after a whitelisted,
  type-checked, field-by-field patch of only its own block, atomic temp+rename. That's fine — it never
  writes a raw key and never touches another block.

## 6. Guardrails you must not weaken

- **LLM output is untrusted.** A synthesized `ChangeSet` is path-safety-validated (`..`-escape / absolute /
  drive-letter / `.git` / `.executive` rejected) **before** the Executor touches it — even dry-run.
- **Applied changes land only on an isolated `executive/change-*` branch; the runtime never merges.** The
  owner is the final gate.
- **The system never auto-acts on relationships / morality / large spending / life-goals.** It may
  *propose* anything (human approves), but `sanitizeExecutable()` forces any sensitive-category or
  non-code proposal to record-only — the LLM cannot route a life/money task into the Executor. (Phase 27)
- **Screen/voice sensing: off by default, own-screen/own-voice only, visible indicator.** No always-on or
  hidden capture (third parties never consented). Layer 3 vision is labeled as sending the screenshot to
  the gateway; local OCR is preferred. (Phase 23/28/29)
- **Confidence > 95% → act, else ask.** The single `applyGuardrail()` gate; the `forbidden` flag forces
  `ask`. Every action must be inspectable and reversible.

## 7. The agent (Phase 35)

- **A large file cannot be produced in one model response, and the failure does not look like
  truncation.** *Symptom:* the owner asked for Tetris and received 9 KB of raw
  `<tool_call><function=save_file>` XML in Discord, cut off mid-line — preceded by five identical
  "path is required" errors. *Causes, all measured:* (a) a Tetris page is **still truncated at 6144
  output tokens (68 s)**, and §1's ~125 s wall caps us near there, so one-shot generation is not
  viable; (b) a tool call whose arguments overflow arrives as **`input: {}`**, which used to be run
  as a genuine empty call — hence the five errors; (c) having given up on `tool_use`, the model
  hand-writes its own `<tool_call>` template as prose. *Fix:* `save_file` has `append` so a file
  arrives in parts; `TruncatedToolCallError` is raised for an empty `tool_use` at
  `stop_reason: max_tokens` and fed back to the model as a failed tool result telling it to chunk;
  `parseXmlToolCall` reads the template; `maxToolRounds` is **20**, because 8 is enough for lookups
  and not for writing. **Chunking invents new ways to be wrong** — `incompleteHtmlReason()` catches
  both an unfinished file (the model announced success with `<script>` still open) and a lost or
  out-of-order chunk (an assembled file began with `</body>`, every closing tag balanced, no
  `<canvas>`, script dead on `getContext of null`). (Phase 41)
- **A "rejects path escape" test can pass without the check ever running.** *Symptom:* removing BOTH
  containment layers from `resolveSafePath` left the whole suite green. *Cause:* the test used
  `../../etc/passwd`, which resolves to a path that **does not exist**, so `existsSync` returned false
  and the function returned null for the wrong reason. *Fix:* plant a real file outside the root and
  assert the escape to *that* is refused. Same family as §4's vacuous-assert trap: the sabotage check is
  the only thing that finds it. (Phase 35)
- **A write tool must PARK, not run-then-report.** The loop returns a `PendingWrite` and stops; the
  owner's tap resumes it via `resumeTurn`. "Trust" (`config.agent.trustedTools`) removes the **prompt**
  only — path safety, changeset validation and the isolated-branch rule still apply to a trusted tool.
  Do not add a "trust everything" switch: that is the same line `autopilot.apply` sits behind.
- **The agent must never assert a fact it did not read.** `AGENT_CONTRACT` (in `src/agent/session.ts`,
  appended AFTER the identity like Phase 10's Worker) forbids answering about the owner's work from
  memory. Without it the model produces confident, plausible, wrong state — the one failure mode the
  owner cannot detect. Phase 33.1 already showed it will invent a *subject* while citing real numbers.
- **Never hand a language model a raw millisecond value** — restated here because the agent's tools are
  a new place to get it wrong. `humanDuration()` / `explainPatterns()` spell the unit out. See §1.
- **The 9arm gateway DOES support native `tools`** — MEASURED this session: a `/v1/messages` POST with
  all 15 tool schemas + "สวัสดี" returned 200 in ~1s with a normal `end_turn` text reply (earlier
  "UNMEASURED" was only because every probe had hit a 524 outage). `toolProtocol:"auto"` (native, downgrades
  to json on a 4xx naming `tools`) is the right default.
- **A cryptic "The operation was aborted." from the chat = a transient gateway latency spike, NOT a code
  bug.** The gateway's latency is bursty (usually 1–6s, occasionally >120s → the `AbortController` fires →
  that message). The agent chat path now **retries once** on an abort/timeout/network/5xx (`step()` in
  `protocol.ts`, `MAX_ATTEMPTS=2`; a 4xx is NOT retried — the tools-downgrade needs it) and surfaces an
  honest Thai message via `chatErrorMessage()` instead of the raw exception. If chat still fails twice,
  check §1 (Arm's box / Zscaler) — but a one-off is expected and self-heals. Debugged live by replaying the
  exact failing "สวัสดี" against the real transcript: it answered in 6.7s, proving transient.
- **The agent can reach ANY repo, not just the current one — but a named-but-unknown repo must FAIL,
  never silently fall back.** `resolveRepo` returns `null` for a name it cannot resolve (registered in
  `watch.repos` OR discovered under `agent.repoSearchRoots`); every caller turns that into an error. The
  old code fell back to the default repo, so asking about "opm-be" returned *executive's* files with
  `ok:true` and the agent confidently answered about the wrong project — the §7 confident-wrong failure
  mode, via a different door. Discovery is by BASENAME only (never builds a path from the supplied name),
  so an escaping name can't leak out. (Phase 37)

## 8. The UI page (`src/ui/page.ts` is ONE giant template literal)

- **Every regex backslash in the inline `<script>` must be DOUBLED in source.** *Symptom:* the chat page
  threw `Invalid regular expression: missing /` at load, the whole inline script failed to parse, and the
  chat card never appeared — yet `bun test` was fully green (unit tests can't run the browser JS). *Cause:*
  `renderPage()` returns a `` `…` `` template literal, so TypeScript eats the escapes **before emission**:
  `\s`→`s`, `\d`→`d`, `\*`→`*`, `\n`→a real newline, `\[`→`[`. A regex like `/^\s*(\d+\.)/` ships as
  `/^s*(d+.)/`. *Fix:* write `\\s`, `\\d`, `\\*`, `\\n`, `\\[` in source (backticks stay `` \` ``). Verify
  with `bun -e 'import{renderPage}from"./src/ui/page.ts";console.log(renderPage())'` and eyeball the emitted
  regex, or just run the browser e2e. This is the §4/§7 lesson again: **the Playwright e2e
  (`bun run test:e2e:chat`) is the only thing that catches a page-JS parse error** — mirror any new inline-JS
  logic with a check there. (Phase 37)
- **Re-confirmed live in Phase 44**, in case anyone doubts it: `"x".replace(/\d+/g, "")` written in
  `page.ts` is emitted as `"x".replace(/d+/g, "")`. **Note what that means — it does NOT throw.**
  `/d+/g` is a perfectly valid regex that matches the letter `d`, so the page loads, the script parses,
  and the behaviour is silently wrong. The unit guard added in Phase 44 (`new Function(scriptSource)`
  must not throw) therefore catches only the subset of this bug that breaks **syntax** (e.g. `/\(/` →
  `/(/`). **The silent-corruption case has no automated guard yet** — that is a named, unclaimed
  follow-up. Until it exists, the rule stands: **write no backslash in this file at all.** (Phase 44)
