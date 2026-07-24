# End-to-end tests (opt-in)

These drive a **real headless Chromium** via Playwright — heavier than the unit suite, so they are
**not** part of `bun test`. They validate the pieces unit tests can't reach: the browser-wasm
transcription path (Phase 25), which loads `transformers.js` + a Whisper model from the local server and
transcribes fake microphone audio entirely offline.

## browser-wasm.e2e.mjs

Feeds the classic `jfk.wav` into Chromium's fake mic (`--use-file-for-fake-audio-capture`), drives the
dashboard's Listening card, and asserts: mode is browser-wasm, there is exactly one Language selector
(auto/th/en) that persists to config, and the recorded audio is transcribed in-browser to the JFK line and
emitted as `system.note`. It uses a temp `EXECUTIVE_HOME` and junction-links the already-downloaded
`.executive/vendor` + `.executive/models`, so it never touches your real runtime data.

### Run it

```bash
# one-time setup
bun add -d playwright                       # already in devDependencies
bunx playwright install chromium            # downloads the browser binary (~150MB, cached globally)
bun run src/index.ts download-model         # ~81MB into .executive/{vendor,models}

# then
bun run test:e2e
```

If Playwright or the model isn't set up, the test **skips** (exit 0) with a message telling you which
prerequisite to install — it never fails just because the environment isn't wired up.

### Notes
- WebGPU is absent in headless Chromium, so it runs on WASM CPU (the fully-offline path). First run loads
  the ~81MB model, so allow ~30s for the transcription step.
- `fixtures/jfk.wav` is 48 kHz mono s16, ~11 s — the format Chromium's fake-audio capture wants.

## chat-ui.e2e.mjs

Validates the chat panel's browser-only behaviour (Phase 37): assistant replies render **markdown**
(bold / inline code / links / lists / code fences) while user messages stay literal, and the 5-second
refresh **does not yank the scroll position** when the owner has scrolled up to read older messages
(while still following new messages when already at the bottom). It seeds `conversation.jsonl` directly,
so **nothing here calls the LLM gateway** — no model, no token, no network. Needs only Chromium
(`bunx playwright install chromium`); no model download. Run with `bun run test:e2e:chat`. This test
exists because a template-literal escaping bug in the page JS (GOTCHA §8) is invisible to `bun test` —
only a real browser catches a page-script parse error.
