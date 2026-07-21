# Scope — Phase 29: Screen-sense Layer 2 + 3 — screenshot OCR + Vision LLM (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.
> **Depends on:** Phase 28 (screen-sense Layer 1 — `src/screen/capture.ts`, `config.screen.window`, the
> `screen` config block). Build on it; do not duplicate it.

---

## 0. What this phase is (and is NOT)

Phase 28 gave Layer 1: the active window **title** (cheap, local, no image). Phase 29 adds the two deeper
layers that read the screen's **contents**, both **off by default, independently toggle-able, and
producing SUGGESTIONS ONLY** — never authoritative state:

- **Layer 2 — local OCR:** capture a screenshot → run **on-device OCR** (Windows.Media.Ocr) → feed the
  text to the existing text LLM (the worker/infer backend) → produce block/deadline/task **suggestions**.
  The image never leaves the machine.
- **Layer 3 — Vision LLM:** capture a screenshot → send the **image itself** to the multimodal
  **`qwen-vl-max`** model on the owner's 9arm gateway → produce the same suggestions. Used when the owner
  enables it directly, or as an **escalation** when Layer 2's OCR text is too thin to understand.

**Suggestions, not state (core principle — do not violate):** everything this phase produces is an
*unconfirmed guess* surfaced in the existing **"Suggestions (unconfirmed)"** section (Phase 19/21) with a
one-click **Confirm**. It NEVER emits an event, mutates State, or acts on its own. The owner confirms.

**Ethics (held from Phase 23/28):** screen contents include third parties who never consented. Therefore:
off by default; a visible **"🔴 reading screen"** indicator on the dashboard whenever Layer 2/3 runs; and
Layer 3 explicitly labeled as sending the screenshot to the owner's gateway. Local OCR (Layer 2) is
preferred; Layer 3 is opt-in.

### CRITICAL — hard guardrails (a violation of any is a defect)

- **All OFF by default.** `screen.ocr.enabled` and `screen.vision.enabled` default **false**. A config
  without them (incl. every Phase ≤28 config) loads unchanged and captures nothing.
- **Suggestions only.** No event emit, no State write, no git, no Executor. Output is written to a
  suggestions file the digest/UI read; the owner confirms via the existing emit buttons. Anything that
  auto-acts is a defect.
- **Layer 2 image stays local.** The OCR path must NOT send the screenshot anywhere. Only the extracted
  **text** goes to the text LLM (same as Phase 19 sends Context text).
- **Layer 3 is the only path that sends an image, and only to the configured gateway.** No third-party
  host, no public URL. Base64-inline the image in the request. Respect a size cap (default 2 MB): downscale
  / re-encode to fit before sending; if it still cannot fit, skip the call (log, no crash).
- **Visible indicator + never silent.** When a capture runs, the dashboard shows the "🔴 reading screen"
  state. No hidden capture.
- **Never blocks the daemon.** Wired like Phase 19 infer: behind a toggle + cooldown + in-flight lock,
  **fire-and-forget** — a slow/failed screenshot/OCR/LLM call never stalls a rebuild tick. Any throw is
  caught + logged; the daemon keeps running.
- **The Vision client is a NEW, separate HTTP shape.** The gateway's multimodal endpoint is
  **OpenAI-compatible** (`POST /v1/chat/completions`, `image_url` content parts), which is **different**
  from the Anthropic `/v1/messages` shape every existing worker/infer/advisor client uses. Do NOT try to
  reuse `AnthropicWorker`/`AnthropicInferer` for images. Write a dedicated client (§3).

### Out of scope (do NOT build)

- No always-on / hidden capture; no keystroke/clipboard capture; no video.
- No auto-confirm of suggestions; no new executor path.
- No non-Windows OCR engine (Windows.Media.Ocr only; other platforms → Layer 2 unavailable, warn once).
- No cloud OCR, no third-party image hosting.
- No change to the Planner/Worker/Executor/Synth/Autopilot/Advisor logic. Reuse the infer **Suggestion**
  surface; do not redesign it.

---

## 1. Config (`src/config.ts` — additive) + Settings persistence

Extend the `screen` block (Phase 28 added `screen.window`) with `ocr` and `vision`:

```ts
  screen?: {
    window?: { enabled?: boolean; pollMs?: number };            // Phase 28
    ocr?: {
      enabled?: boolean;    // Layer 2. Default false.
      cooldownMs?: number;  // min ms between OCR captures in the daemon. Default 300000 (5 min).
      minChars?: number;    // OCR text shorter than this is "too thin" → eligible to escalate. Default 40.
    };
    vision?: {
      enabled?: boolean;        // Layer 3. Default false.
      cooldownMs?: number;      // Default 600000 (10 min).
      escalateFromOcr?: boolean;// if true, a thin OCR result triggers a vision call. Default true.
      baseUrl?: string;         // OpenAI-compatible base (no trailing /v1). Default = config.worker.baseUrl.
      model?: string;           // Default "qwen-vl-max".
      apiKeyEnv?: string;       // env var NAME holding the key. Default = config.worker.apiKeyEnv.
      maxImageBytes?: number;   // cap before sending; downscale to fit. Default 2000000.
    };
  };
```

- `defaultConfig()` still adds **no** `screen` block (backward compatible). Merge each present sub-field
  defensively in `loadConfig()` (same pattern as Phase 28's `screen.window`). Vision `baseUrl`/`apiKeyEnv`
  default by falling back to `config.worker.baseUrl`/`config.worker.apiKeyEnv` at **use** time (do not bake
  the worker values into the file — read them lazily so changing `worker` still applies).
- **Settings persistence (the owner's "toggle in Settings" request):** add
  `updateScreenConfig(patch)` mirroring the existing `updateTranscribeConfig` (Phase 25): whitelist +
  type-check only the `screen.*` fields, write **only** the `screen` block, atomic temp+rename. It must
  accept toggling `window.enabled`, `ocr.enabled`, `vision.enabled` (+ their numeric fields) and never
  writes a raw key (only `apiKeyEnv` names). Never touches any non-`screen` field.

---

## 2. Capture primitives (`src/screen/screenshot.ts`, `src/screen/ocr.ts` — new, isolated + mockable)

Keep all OS-specific pixel work here, next to Phase 28's `capture.ts`, so `screen-infer.ts` stays testable
with injected mocks.

### 2a. `screenshot.ts`
```ts
export interface Screenshot { path: string; bytes: number; format: "png" | "jpeg" }
/** Capture the primary screen to a temp file under .executive/tmp, downscaled/encoded to fit
 *  `maxBytes`. Returns null if capture is unavailable (non-Windows / failure). Never throws. */
export function captureScreen(maxBytes: number): Screenshot | null;
```
- Windows impl: PowerShell + `System.Drawing` (`Graphics.CopyFromScreen`), save to a temp file. To fit
  `maxBytes`: downscale to a max width (e.g. 1280 px) and save as **JPEG** (quality ~70) when a PNG would
  exceed the cap. Write into `.executive/tmp/` (create it; it is gitignored under `.executive/`), and the
  caller deletes the file after use.
- Non-Windows / failure → `null` (warn once). No throw.

### 2b. `ocr.ts`
```ts
/** OCR a local image file to text using Windows.Media.Ocr. Returns "" if OCR is unavailable
 *  (engine/language missing, non-Windows) — never throws. */
export function ocrImage(path: string, language?: string | null): string;
```
- Windows impl: PowerShell calling the WinRT `Windows.Media.Ocr.OcrEngine`
  (`TryCreateFromLanguage("th")`/`TryCreateFromUserProfileLanguages()`), load the file via
  `BitmapDecoder`, run `RecognizeAsync`, join lines. `language` hint from `config.transcribe.language` or a
  new optional; default to user-profile languages (mixed Thai/English works if the Thai OCR pack is
  installed).
- If the OCR engine / Thai pack is unavailable → return `""` and warn once (this is the signal that Layer
  2 can't help → escalate to Layer 3 if enabled). Never throw.

Both functions are replaced by injected mocks in tests (no real PowerShell in `bun test`).

---

## 3. Vision client (`src/screen/vision.ts` — new; OpenAI-compatible, NOT Anthropic)

The multimodal call uses the gateway's **OpenAI-compatible** endpoint. Implement it fresh:

```ts
export interface VisionOptions { baseUrl: string; model: string; apiKey: string; maxTokens: number; timeoutMs: number }
/** Send one image + a prompt, return the model's raw text answer. Throws on transport/HTTP error. */
export async function visionComplete(opts: VisionOptions, prompt: string, imageDataUrl: string): Promise<string>;
```

Request — `POST {baseUrl}/v1/chat/completions`:
```jsonc
{
  "model": "qwen-vl-max",
  "max_tokens": <llmMaxTokens>,
  "temperature": 0.2,
  "messages": [
    { "role": "user", "content": [
      { "type": "text", "text": "<PROMPT>" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,<...>" } }
    ]}
  ]
}
```
- Header `Authorization: Bearer <apiKey>` (key read from `process.env[apiKeyEnv]`, never hardcoded).
- `imageDataUrl` = `data:image/{format};base64,{base64}` built from the screenshot file (format per §2a).
- Use `llmMaxTokens(config)` / `llmTimeoutMs(config)` floors (reasoning-model headroom, Phase 20) — the
  vision model also "thinks". `AbortController` timeout like the other clients.
- **Response parsing** is OpenAI shape, NOT Anthropic: the text is `choices[0].message.content` (a string).
  Write `extractOpenAiText(json)` for it (defensive: missing/empty → throw a clear error). Then reuse the
  existing tolerant suggestion parser (strip ``` fences, find the JSON) to get the structured suggestions.

Unit-test `extractOpenAiText` + the request-body builder offline (no network); the live call is owner-run.

---

## 4. Screen inference + escalation (`src/screen/screen-infer.ts` — new)

```ts
export interface ScreenInferResult {
  ran: boolean;
  layer: "none" | "ocr" | "vision";
  suggestions: Suggestion[];   // reuse src/report/types Suggestion (see §5 for the "task" addition)
  message: string;
}
export async function runScreenInference(config: Config, deps?: {
  capture?: typeof captureScreen; ocr?: typeof ocrImage; vision?: typeof visionComplete; textInfer?: ...
}): Promise<ScreenInferResult>;
```

Logic (deterministic control flow around the LLM calls):
1. If neither `screen.ocr.enabled` nor `screen.vision.enabled` → `{ ran:false, layer:"none", ... }`.
2. **Layer 2 (if `ocr.enabled`):** `shot = capture(maxBytes)`; if null → skip to step 3. `text =
   ocr(shot.path, lang)`; **delete the temp file**. If `text.length >= minChars` → ask the **text** LLM
   (reuse the infer/worker text backend — build a prompt: "Here is text read from the user's screen; infer
   any current block/deadline/task as suggestions to confirm; JSON only") → parse suggestions →
   `{ ran:true, layer:"ocr", suggestions }`. Done.
3. **Escalate / Layer 3 (if `vision.enabled` AND (Layer 2 was skipped/thin AND `escalateFromOcr`, OR
   `ocr.enabled` is false)):** `shot = capture(maxBytes)` (reuse the one from step 2 if still around);
   build the data URL; `visionComplete(...)` with the screen prompt → parse suggestions →
   `{ ran:true, layer:"vision", suggestions }`. Always delete the temp file in a `finally`.
4. If nothing produced anything → `{ ran:true, layer:<attempted>, suggestions:[], message:"no signal" }`.

Every external call (`capture`/`ocr`/`vision`/`textInfer`) is injectable via `deps` for offline tests.
The temp screenshot is **always** cleaned up (finally), even on error.

**Prompt guidance:** ask for the same suggestion kinds as Phase 19 plus an optional **task** hint (e.g. a
Trello card the owner seems to be on). Keep it "suggestions to confirm", never commands.

---

## 5. Suggestion surface (reuse Phase 19/21, avoid clobbering the daemon's own infer)

- **Extend `Suggestion.kind`** (in `src/report/types.ts`) to `"block" | "deadline" | "task"` (additive;
  `task`'s `emit` is `{ type:"system.task", data:{ task } }`). Confirm buttons already POST `emit`, so a
  `task` suggestion becomes a one-click `system.task`.
- **Storage:** write screen suggestions to a **separate** file `.executive/screen-inferred.json` (do NOT
  overwrite `inferred.json`, which the Phase 19 daemon infer owns — writing the same file would clobber).
  Shape: `{ generatedAt, layer, suggestions: Suggestion[] }`.
- **Digest (`src/report/digest.ts`):** the "Suggestions (unconfirmed)" aggregation now reads **both**
  `inferred.json` (Phase 19) and `screen-inferred.json`, merged + deduped by `text` (same defensive
  `readJson` that never throws on missing/malformed). Suppress a suggestion that adds no info (block guess
  while already blocked; deadline guess while a deadline is set — the existing rule), applied to the merged
  set.
- **UI (`src/ui/page.ts`):** the existing Suggestions card renders the merged list unchanged (it already
  renders `Digest.suggestions` with Confirm). Add the **"🔴 reading screen"** indicator (see §6). No new
  endpoint for suggestions — they ride in `/api/state`'s digest.

---

## 6. Daemon wiring + indicator (`src/index.ts`, `src/ui/server.ts`, `src/ui/page.ts`)

- **Daemon:** mirror the Phase 19 infer wiring exactly — a `screenInferRunning` in-flight lock + a
  `lastScreenInferAt` cooldown check (use the **min** of the enabled layers' cooldowns, or check each).
  After the existing infer block, if `screen.ocr.enabled || screen.vision.enabled` and not running and
  cooldown elapsed → set running, **fire-and-forget** `runScreenInference(config)`: on resolve, write
  `screen-inferred.json`; on reject, stderr; `finally` clear running + set `lastScreenInferAt`. Never
  `await` it in the tick path (don't block rebuilds).
- **Indicator:** expose a tiny live flag so the dashboard can show capture activity — e.g. `/api/state`
  (or `/api/config`) includes `screen: { active: <true while a capture is in flight>, layer }`. The page
  shows **"🔴 reading screen (ocr|vision)"** while active, and a static "screen sensing: off/on" otherwise.
  Keep it honest and visible; never capture without the flag being shown.
- **Settings card (the owner's request):** in the dashboard Settings section, add toggles for **Window /
  OCR / Vision** (three switches) + the vision `model`/`baseUrl`/`apiKeyEnv` fields, wired to a
  `POST /api/settings` (extend the existing Phase 25 settings endpoint, or add `/api/settings/screen`) that
  calls `updateScreenConfig`. `GET /api/config` returns the `screen` block (no secret — only the
  `apiKeyEnv` name, never the key value; assert this in a test, as Phase 25 does for transcribe).

---

## 7. Files to create / edit

### Create
```
src/screen/screenshot.ts        # captureScreen(maxBytes) — Windows, downscale/JPEG to fit, null-safe
src/screen/ocr.ts               # ocrImage(path, lang) — Windows.Media.Ocr, "" when unavailable
src/screen/vision.ts            # visionComplete(...) — OpenAI /v1/chat/completions, qwen-vl-max
src/screen/screen-infer.ts      # runScreenInference(config, deps) — escalation, suggestions-only
src/screen/screen-infer.test.ts # offline: mocked capture/ocr/vision → layer selection + escalation
src/screen/vision.test.ts       # offline: request-body builder + extractOpenAiText parsing
```

### Edit
- `src/config.ts` — `screen.ocr`/`screen.vision` types + merge + `updateScreenConfig`.
- `src/report/types.ts` — `Suggestion.kind` gains `"task"`.
- `src/report/digest.ts` — merge `inferred.json` + `screen-inferred.json` in the suggestions section.
- `src/paths.ts` — `screenInferredPath()` (+ a `.executive/tmp` dir helper if useful).
- `src/index.ts` — daemon wiring (toggle + cooldown + lock + fire-and-forget).
- `src/ui/server.ts` — `/api/settings` (screen) + `screen` block in `/api/config` + indicator flag.
- `src/ui/page.ts` — Settings toggles (Window/OCR/Vision), "🔴 reading screen" indicator.

Do NOT edit the Planner, Worker, Executor, Synth, Autopilot, Advisor, or Phase 28's `capture.ts`/
`watchers/screen.ts` (reuse them read-only).

---

## 8. Tests (`bun test`, OFFLINE) — required

- `vision.test.ts`: request body has `model`, `image_url` data-URL content part, `Authorization` built
  from the key; `extractOpenAiText` reads `choices[0].message.content` and throws clearly on a malformed
  shape.
- `screen-infer.test.ts` (inject `capture`/`ocr`/`vision`/`textInfer` mocks — **no PowerShell, no
  network**):
  1. Both layers off → `ran:false`, `layer:"none"`.
  2. OCR on, mock returns rich text → `layer:"ocr"`, suggestions from the text LLM mock; vision mock **not
     called**.
  3. OCR on but returns thin text (`< minChars`), vision on + `escalateFromOcr` → escalates → `layer:
     "vision"`, vision mock called once.
  4. OCR off, vision on → straight to `layer:"vision"`.
  5. `capture` returns null → no crash; result reflects no signal.
  6. Temp screenshot path is deleted in all branches (assert the mock's cleanup or that unlink was called).
  7. Suggestions are parsed into the `Suggestion` shape incl. a `task` suggestion with the right `emit`.
- `config`: `screen.ocr`/`screen.vision` default off + merge; `updateScreenConfig` writes only the
  `screen` block and rejects non-whitelisted fields; `GET /api/config` (server test, `port:0`) never
  contains the key VALUE.
- `digest`: with both `inferred.json` and `screen-inferred.json` present, the suggestions section merges +
  dedups by `text`; suppression rules still apply.

All existing tests must still pass. **No test hits the network, spawns PowerShell, or captures a real
screen.**

---

## 9. Acceptance criteria (Claude will verify ALL of these by running them)

- [ ] `bun run typecheck` passes (strict); `bun test` passes offline.
- [ ] **All off by default:** a Phase ≤28 config → no capture, no `screen-inferred.json`, dashboard shows
      "screen sensing: off". Verified live.
- [ ] **Layer 2 local:** with `ocr.enabled:true` (vision off), the daemon captures → OCRs locally →
      writes suggestions to `screen-inferred.json`; grep/network trace confirms **no image left the
      machine**. (Live on Windows with the Thai OCR pack; if the pack is absent, OCR returns "" and the
      run is a clean no-op — verify that path too.)
- [ ] **Layer 3 vision:** with `vision.enabled:true`, a capture is base64-inlined and POSTed to
      `{baseUrl}/v1/chat/completions` with `qwen-vl-max` (owner-run live against the gateway; offline the
      request builder + parser are tested). The temp screenshot is deleted afterward.
- [ ] **Escalation:** OCR-thin + vision-on + `escalateFromOcr` → exactly one vision call; OCR-rich → zero
      vision calls (verified via the mocked `screen-infer` test).
- [ ] **Suggestions only:** produced items appear in "Suggestions (unconfirmed)" with Confirm; nothing is
      emitted/acted until the owner clicks. A `task` suggestion confirms into `system.task`.
- [ ] **Indicator visible:** "🔴 reading screen" shows while a capture is in flight; never captures
      silently.
- [ ] **Settings toggles:** the dashboard Settings card toggles Window/OCR/Vision and persists via
      `updateScreenConfig`; `/api/config` exposes the `screen` block **without** the key value.
- [ ] **Never blocks / never crashes:** a slow/failed capture/OCR/vision call does not stall rebuild ticks;
      any throw is logged and the daemon keeps running; SIGINT exits cleanly.
- [ ] Planner/Worker/Executor/Synth/Autopilot/Advisor + Phase 28 files **unchanged** (git diff empty).
- [ ] `.executive/` (incl. `tmp/`, `screen-inferred.json`) stays gitignored; only §7 files created/edited.

---

## 10. Deliverable

A commit containing §7's files + this doc. Do NOT commit `.executive/` runtime data. Hand back for
review — Claude runs every item in §9 (incl. a live Windows OCR check and, where a key is available, a
live vision call) and will NOT trust the self-report.

---

## 11. Design notes (rationale — not extra work)

- **Why suggestions, never state:** screen reading is inherently noisy and privacy-heavy; a wrong guess
  must cost nothing. Routing everything through the existing confirm-first Suggestion surface keeps the
  owner in control and reuses a tested path.
- **Why local OCR before vision:** OCR keeps the image on the machine — the safest way to read contents.
  Vision is more capable but sends the whole screen (with whoever is on it) to the gateway, so it is the
  escalation, gated separately, and clearly labeled.
- **Why a separate Vision client:** the gateway speaks OpenAI `/v1/chat/completions` for `qwen-vl-max`,
  not the Anthropic `/v1/messages` the rest of the code uses. Forcing images through the Anthropic client
  would be wrong; a small dedicated client is correct and keeps the two shapes from leaking into each other.
- **Why a separate `screen-inferred.json`:** the Phase 19 daemon infer owns `inferred.json`; two writers on
  one file clobber. Separate files + a merge in the digest keeps both sources alive and independently
  toggleable.
- **Why fire-and-forget + cooldown:** capture+OCR+LLM is slow and variable; it must observe on the side,
  never on the critical path of the observe→rebuild loop.
