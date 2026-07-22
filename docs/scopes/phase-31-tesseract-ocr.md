# Phase 31 — Tesseract OCR engine (Thai support for screen-sense Layer 2)

> Context-free spec. Read `CLAUDE.md` (core principle, guardrails) and `GOTCHA.md` §2 (Windows/PowerShell)
> before starting. Stay strictly inside scope — see §7 "What is NOT in scope".

## 1. Why

Screen-sense Layer 2 (Phase 29) OCRs the screen **on-device** with `Windows.Media.Ocr`. That engine has
**no Thai language pack and never will** — an elevated `Get-WindowsCapability -Online -Name "Language.OCR*"`
lists 36 languages (ar, zh-CN/HK/TW, ja, ko, ru, most of Europe) and `th-TH` is **not among them**. The
owner works in Thai, so half of what is on screen is currently unreadable (`แชท` → `FE uazå-uüum%io`).

Layer 3 (vision LLM) is not an escape hatch: the 9arm gateway team is allow-listed to `qwen3.6-35b-a3b`,
so `qwen-vl-max` returns `403 team_model_access_denied`.

**Tesseract 5.4 with `tha.traineddata` (tessdata_best) reads Thai correctly, including Thai↔English
code-switching, and runs fully offline.** It is already installed on the owner's machine and verified:

```
input image  → แชท OPM Dev - LINE / ติดอยู่ รอ API key จากทีมการเงิน / กำหนดส่ง 14 สิงหาคม 2569
tesseract -l tha+eng → แชท OPM Dev - LINE / ติดอยู่ รอ API key จากทีมการเงิน / กําหนดส่ง 14 สิงหาคม 2569
```

Environment already prepared (no install work in this phase):
- `C:\Program Files\Tesseract-OCR\tesseract.exe` (v5.4.0, via winget `UB-Mannheim.TesseractOCR`)
- `tessdata\tha.traineddata` (tessdata_best, 7.3MB) → `--list-langs` = `eng`, `osd`, `tha`

## 2. Goal

Make the OCR engine **selectable**, defaulting to today's behaviour, so the owner can switch Layer 2 to
Tesseract and have Thai work. Deterministic, on-device, **NO LLM** — this is a sensor, same family as
`capture.ts`/`screenshot.ts`.

## 3. Files to change

| File | Change |
|---|---|
| `src/screen/ocr.ts` | add the Tesseract path + a dispatcher; keep the WinRT path as-is |
| `src/screen/ocr.test.ts` | **new** — offline unit tests (pure helpers only) |
| `src/config.ts` | extend the `screen.ocr` block + `updateScreenConfig` whitelist |
| `src/screen/screen-infer.ts` | pass the engine options from config into `ocr(...)` |
| `src/ui/page.ts` | Settings card: engine selector + languages field |
| `CLAUDE.md`, `GOTCHA.md`, `HANDOFF.md` | phase entry + traps |

## 4. Config (backward compatible — absence means today's behaviour)

Extend `config.screen.ocr`:

```jsonc
"ocr": {
  "enabled": false,
  "cooldownMs": 300000,
  "minChars": 40,
  "engine": "winrt",            // "winrt" | "tesseract"   — DEFAULT "winrt"
  "languages": "tha+eng",       // tesseract only; default "tha+eng"
  "tesseractPath": null         // null → auto-detect (see §5.2)
}
```

Rules (follow the existing pattern in `loadConfig`, `GOTCHA.md` §5):
- Sub-fields are filled **only when the `screen.ocr` block is present**. Never add `screen` to
  `defaultConfig()` — absence must keep the feature off.
- An unknown/invalid `engine` value falls back to `"winrt"` (never throw).
- `updateScreenConfig(patch)` must accept the three new fields, **type-checked and whitelisted** like the
  existing ones. `tesseractPath` is a path, not a secret — but keep the rule that no raw key is ever written.

## 5. `src/screen/ocr.ts`

### 5.1 Public shape

Keep the existing export working. Add an options parameter:

```ts
export interface OcrOptions {
  engine?: "winrt" | "tesseract";
  languages?: string;       // tesseract, e.g. "tha+eng"
  tesseractPath?: string | null;
}

export function ocrImage(path: string, language?: string | null, opts?: OcrOptions): string
```

- `opts` absent or `engine !== "tesseract"` → **the existing WinRT path, unchanged**.
- Non-Windows → `""` as today (Tesseract on POSIX is out of scope; do not add a branch for it).
- Contract is unchanged: **never throws**, `""` means "OCR can't help" (the caller escalates).

### 5.2 Tesseract path resolution — pure + exported

```ts
export function resolveTesseractPath(configured?: string | null): string | null
```
Order: `configured` (if it exists on disk) → `C:\Program Files\Tesseract-OCR\tesseract.exe` →
`C:\Program Files (x86)\Tesseract-OCR\tesseract.exe` → `%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe`
→ bare `"tesseract"` (let PATH resolve it) → `null` only if nothing is plausible.
Must be testable without Tesseract installed (inject/allow a `existsSync`-style check).

### 5.3 Running it

```
<exe> <imagePath> stdout -l <languages>
```
- Use `Bun.spawnSync` with `stdout:"pipe", stderr:"pipe"` — **no PowerShell involved** (this is a plain
  exe; do not wrap it in a `.ps1`).
- `normalize()` the image path first (same reason as the WinRT path — see `GOTCHA.md` §2).
- Non-zero exit → write one line to stderr and return `""`. A missing exe (spawn throws) → `""`.
- Decode stdout as **UTF-8** (`new TextDecoder()`), then `.trim()`.

### 5.4 Unicode normalization — pure + exported (REQUIRED)

```ts
export function normalizeThaiOcr(text: string): string
```
Tesseract emits sara-am **decomposed**: `กำ` comes back as `ก` + `U+0E4D` (nikhahit) + `U+0E32` (sara aa).
Left alone, the text won't match anything the owner would type. Apply `text.normalize("NFC")` and, because
NFC alone does **not** recompose `U+0E4D U+0E32` → `U+0E33`, do that replacement explicitly first.

Test with the exact real sample: `"กํา"` (ก + U+0E4D + U+0E32) → `"กำ"` (ก + U+0E33).

## 6. Wiring

- `src/screen/screen-infer.ts`: build `OcrOptions` from `config.screen.ocr` and pass it as the third
  argument to `ocr(...)`. Update `ScreenInferDeps.ocr`'s type to match. **Do not change any other logic**
  in that file (the Phase 29.2 error-vs-no-signal distinction must stay exactly as it is).
- `src/ui/page.ts`: in the existing Settings card, add an **OCR engine** selector (`Windows (English only)`
  / `Tesseract (Thai + English)`) and a languages text field shown only for Tesseract. It saves through the
  **existing** `POST /api/settings` screen path — no new endpoint.

## 7. What is NOT in scope

- No new watcher, no event type, no state field, no planner/worker/executor/synth/advisor change.
- **Do not touch** `src/screen/screenshot.ts`, `capture.ts`, `vision.ts`, or the Layer 3 flow.
- No installer/downloader for Tesseract or `tha.traineddata` (already installed; a bundled downloader is a
  separate decision — it ships a 3rd-party binary).
- No POSIX/macOS Tesseract branch. No change to Layer 3, to the transcription backends, or to the digest.
- Do not make Tesseract the default. `"winrt"` stays the default so no existing config changes behaviour.

## 8. Tests (offline, no Tesseract required to pass)

Add `src/screen/ocr.test.ts`:
1. `normalizeThaiOcr("กํา")` → `"กำ"`; a plain ASCII string is unchanged; `""` → `""`.
2. `resolveTesseractPath("C:\\nope\\x.exe")` ignores a non-existent configured path and still returns a
   candidate (never throws).
3. `ocrImage` with `engine:"tesseract"` and a deliberately bogus exe path → returns `""` (never throws).
4. On a non-win32 platform the function returns `""` for **both** engines (guard the assertion so the
   suite stays meaningful on Windows).
5. Config: a `screen.ocr` block without the new keys loads with `engine:"winrt"` (backward compat); an
   invalid `engine` string falls back to `"winrt"`; `updateScreenConfig` round-trips the three new fields.

**Sabotage-check every new test** (`GOTCHA.md` §4): break the code, confirm the test fails. Assertions must
not sit inside an un-awaited callback.

## 9. Acceptance criteria (the architect will run each one for real)

1. `bun run typecheck` and `bun test` green; the new tests fail against the pre-fix source.
2. A config whose `screen.ocr` lacks `engine` behaves exactly as today (WinRT), proven by an actual run.
3. With `engine:"tesseract"`, `ocrImage()` on a Thai PNG returns correct Thai — specifically
   `แชท OPM Dev - LINE`, `ติดอยู่ รอ API key จากทีมการเงิน`, `กำหนดส่ง 14 สิงหาคม 2569` (note: **`กำ`
   composed**, proving §5.4 ran).
4. End-to-end: `runScreenInference` with `engine:"tesseract"` against a real screen showing Thai produces
   suggestions (or a truthful `ocr: no signal` / `ocr: llm unavailable — …`, never a crash).
5. Pointing `tesseractPath` at a non-existent file degrades to `""` + one stderr line — no crash, and the
   daemon keeps ticking.
6. The dashboard Settings card switches the engine and the choice persists across a reload.
7. `git diff` touches only the files in §3.
