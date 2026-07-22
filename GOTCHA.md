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

## 2. Windows / PowerShell

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
