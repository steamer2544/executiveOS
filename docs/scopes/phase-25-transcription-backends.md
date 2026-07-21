# Scope — Phase 25: Transcription backends + Settings

> Audience: implementer with no prior context. Pairs with `HANDOFF.md` and `docs/scopes/phase-24-whisper.md`.

## 0. Why
Phase 24 added a single Whisper path (`transcribe.enabled` on/off). The owner wants to **choose among
several transcription backends and edit the settings from the dashboard**, keeping the current Web Speech
mode as one of the choices. Four modes, all opt-in, off by default:

| mode | what | key needed | privacy |
|------|------|-----------|---------|
| `webspeech` | browser SpeechRecognition (Phase 23, current) | no | audio → browser vendor (Google) |
| `whisper-api` | POST audio → local `/api/transcribe` → configurable OpenAI-compatible endpoint | yes (server-side .env) | audio → that endpoint (Groq cloud, or a **local** faster-whisper you host) |
| `browser-wasm` | Whisper runs **in the browser** via transformers.js; model+lib served from `127.0.0.1` | no | **audio never leaves the machine** |

`whisper-api` covers BOTH "Groq" and "local faster-whisper" — they differ only by `baseUrl`/`model`, so
the dashboard offers them as one-click **presets** that fill the fields.

## 1. Config (`src/config.ts`, backward-compatible)
```ts
transcribe?: {
  mode?: "webspeech" | "whisper-api" | "browser-wasm"; // default "webspeech"
  enabled?: boolean;        // LEGACY (Phase 24). If `mode` is absent: enabled → "whisper-api", else "webspeech".
  baseUrl?: string;         // whisper-api host (no trailing /v1). "" = unset.
  model?: string;           // whisper-api model (e.g. "whisper-large-v3-turbo"). Default "whisper-1".
  apiKeyEnv?: string;       // env var NAME holding the key (read server-side only). Default "EXECUTIVE_TRANSCRIBE_KEY".
  language?: string | null; // hint ("th") or null = auto (best for code-switching). Default null.
  wasmModel?: string;       // browser-wasm model id. Default "Xenova/whisper-base".
};
```
- Backward-compat merge: a Phase-24 config with only `enabled` still works (mode derived from it).
- `TRANSCRIBE_PRESETS`: `{ groq: { baseUrl, model }, local: { baseUrl, model } }` for the UI.
- `updateTranscribeConfig(patch)`: read → whitelist+validate (mode enum, string/null types) → atomic write.
  **Only the `transcribe` block is writable** via the settings API — nothing else in config.json.

## 2. Paths (`src/paths.ts`)
- `modelsDir()` → `.executive/models` (browser-wasm model files, HF layout).
- `vendorDir()` → `.executive/vendor` (transformers.js + onnxruntime wasm, served locally).

## 3. Model download (`src/ui/models.ts`, new)
- `downloadWasmAssets(modelId, { onLog? })`: server-side. Downloads (a) the transformers.js dist bundle +
  onnxruntime-web wasm into `vendorDir()`, (b) the HF model repo files into `modelsDir()/<modelId>/`
  (list via `https://huggingface.co/api/models/<id>/tree/main?recursive=1`, fetch each
  `.../resolve/main/<path>`). Skips files already present. Returns `{ ok, files, bytes, error }`.
- `wasmAssetsStatus(modelId)`: `{ libReady, modelReady, files }` — what is already on disk.
- Path-safety: every written path must stay inside `vendorDir()`/`modelsDir()` (reject `..`).

## 4. Server (`src/ui/server.ts`)
- `GET /api/config` → returns the **full `transcribe` block** (mode/baseUrl/model/apiKeyEnv/language/wasmModel)
  so the settings editor can show/edit it. **The block contains NO secret** — the actual key lives only in
  `process.env[apiKeyEnv]`, never in config — so nothing sensitive is exposed. (Test asserts the key VALUE
  never appears in the response.)
- `POST /api/settings` → body `{ transcribe: <patch> }` → `updateTranscribeConfig`; returns `{ ok, transcribe }`.
- `POST /api/transcribe` → unchanged proxy; now also refuses unless `mode === "whisper-api"` (and baseUrl set).
- `POST /api/transcribe/download` → body `{ model? }` → `downloadWasmAssets`; returns the result.
- `GET  /api/transcribe/status` → `wasmAssetsStatus`.
- `GET  /models/*` and `GET /vendor/*` → static file serving from `modelsDir()`/`vendorDir()`, **path-safety
  enforced** (no `..`, no absolute escape); 404 when absent. Correct content-types for `.wasm`/`.json`/`.js`/
  `.onnx`/`.bin`.

## 5. Page (`src/ui/page.ts`)
- New **Settings** card: a mode selector (Web Speech / Groq / Local faster-whisper / Browser-WASM), the
  relevant editable fields per mode (baseUrl/model/apiKeyEnv-name/language for whisper-api; wasmModel +
  a **Download** button + status for browser-wasm), and a **Save** button → `POST /api/settings`.
  Groq/Local are presets that prefill baseUrl+model.
- The mic routes by mode: `webspeech` (existing SpeechRecognition), `whisper-api` (existing MediaRecorder →
  `/api/transcribe`), `browser-wasm` (MediaRecorder → transformers.js pipeline loaded from `/vendor` +
  `/models`, `env.allowRemoteModels=false`, `env.localModelPath="/models/"`; transcribe locally → emit note).
- Keep the visible **"🔴 Listening…"** indicator + off-by-default behavior. The page string stays
  **self-contained** (only same-origin `/vendor`, `/models`, `/api/*` paths — no external URLs).

## 6. CLI (`src/index.ts`)
- `download-model [id]` → `downloadWasmAssets` (terminal progress; big download, better than the UI button).

## 7. Tests (offline, `src/ui/*.test.ts`)
- config merge: Phase-24 `enabled:true` → `mode:"whisper-api"`; missing block → `mode:"webspeech"`.
- `updateTranscribeConfig`: writes only the transcribe block, rejects a bad mode.
- `/api/config` exposes the transcribe block but **never the key value** (dummy env set → absent in body).
- `/api/settings` round-trips a mode change and it persists.
- `/api/transcribe` with `mode!=="whisper-api"` → `{ok:false,"not configured"}`.
- static serving: `/vendor/x` 404 when absent; a `..`-escape path is rejected (not 200).
- (Live, owner-run) Groq key set → a Thai+English clip transcribes; `download-model` then browser-wasm works
  fully offline. Browser + a real endpoint/model can't run in CI (same limit as Web Speech).

## 8. Out of scope
No diarization, no always-on/ambient capture, no storing raw audio, no writing the raw key from the UI
(the key stays a manual `.env` step — the UI only sets the env-var NAME). No new backend besides the three.
