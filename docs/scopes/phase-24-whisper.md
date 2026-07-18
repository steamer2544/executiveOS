# Scope — Phase 24: Whisper multilingual transcription (code-switching)

> Audience: implementer with no prior context. Pairs with `HANDOFF.md`.

## 0. Why
Web Speech does one language at a time; Thai devs code-switch Thai↔English constantly. Whisper handles
code-switching well. This routes the dashboard's **own-voice** dictation to a Whisper-compatible endpoint
instead of the browser recognizer, for a much better mixed-language transcript. Same listening ethics as
`HANDOFF.md` §5 (own-voice, visible, off by default; no covert/ambient recording).

## 1. Shape
```
dashboard mic (MediaRecorder, owner's own voice)
  → POST audio blob to  /api/transcribe   (local server)
      → server forwards to a configurable OpenAI-compatible /v1/audio/transcriptions (Whisper)
      → returns { text }
  → browser emits system.note { msg: text, via: "voice" }  (feeds the Advisor, same as today)
```
The existing Web Speech path stays as a fallback (config chooses). Transcription is opt-in.

## 2. Config (`src/config.ts`, backward-compatible, default off)
```ts
transcribe?: {
  enabled?: boolean;    // default false — when true the dashboard records audio and sends it to Whisper
  baseUrl?: string;     // e.g. "https://<host>" (no trailing /v1); default "" (must be set)
  model?: string;       // e.g. "whisper-1"; default "whisper-1"
  apiKeyEnv?: string;   // env var holding the key; default "EXECUTIVE_TRANSCRIBE_KEY"
  language?: string | null; // hint ("th"), or null to auto-detect (best for code-switching); default null
};
```
Reuse the `llm*` floor helpers only for timeout if useful; transcription has no token budget.

## 3. Server (`src/ui/server.ts`)
- `GET /api/config` also returns `transcribe: { enabled }` (NOT the key/baseUrl — never leak the key to the page).
- `POST /api/transcribe`: accepts `multipart/form-data` (audio file) OR a raw audio body; forwards to
  `${baseUrl}/v1/audio/transcriptions` as multipart with `model`, optional `language`, `Authorization:
  Bearer <key from env>`; returns `{ ok, text }` or `{ ok:false, error }`. 500/timeout safe. If
  `transcribe.enabled` is false or `baseUrl` empty → `{ ok:false, error:"transcription not configured" }`.
- Key is read server-side from `process.env[apiKeyEnv]` — the browser never sees it.

## 4. Page (`src/ui/page.ts`)
- When `transcribe.enabled`: the mic uses `MediaRecorder` (getUserMedia audio) instead of SpeechRecognition.
  Record in short segments (e.g. on silence, or a manual stop / hold-to-talk release), POST each blob to
  `/api/transcribe`, and on `{text}` call `emit("system.note", { msg:text, via:"voice" })`.
- Keep the **visible "🔴 Listening…" indicator** and the off-by-default behavior unchanged.
- Fall back to the current Web Speech path when `transcribe.enabled` is false. Language selector still applies
  (passes `language` hint; `auto` recommended for mixed).

## 5. Tests (offline)
- config merge: `transcribe` defaults present + backward-compatible (no block → defaults).
- `/api/config` exposes only `{ enabled }` for transcribe (never baseUrl/key).
- `/api/transcribe` with `transcribe.enabled=false` → `{ ok:false, "not configured" }` (no network).
- (Live, owner-run) with a real endpoint+key set: a short Thai+English clip transcribes correctly.
  Cannot be tested in CI — MediaRecorder + a real Whisper endpoint are needed.

## 6. Blocker / note
The 9arm gateway is LLM-messages only — it likely has **no** audio endpoint. The owner must supply a
Whisper-compatible `/v1/audio/transcriptions` host + key (self-hosted `faster-whisper`/`whisper.cpp` server,
or a provider) and set `config.transcribe`. Build + test the scaffolding offline; the owner wires the
endpoint to validate live.

## 7. Out of scope
No diarization, no always-on/ambient capture, no storing raw audio (transcribe then discard the blob).
