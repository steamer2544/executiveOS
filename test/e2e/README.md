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

## dashboard-ia.e2e.mjs

**Measures the layout** (Phase 45), which is the only way a layout claim can be checked. It seeds 8
pending proposals into a temp `EXECUTIVE_HOME`, loads the dashboard at 1536×864, and asserts against the
numbers measured on the owner's real page **before** the change: `statusCard` above 300px (was 3,652),
the answer card fully above the fold (was 4,172), the whole page under 2,400px (was 4,766), the proposal
queue under 900px with 8 pending (was 2,039) with a working `+ 5 more`, an empty answer costing ≤56px
(was ~184 across three cards), no horizontal overflow at 420px (was 457), and two columns at 1280px.
Needs only Chromium; no model, no gateway, no token. Run with `bun run test:e2e:ia`.

Two things it does that are worth copying into any future e2e:

- **It refuses to run if something already holds its port.** A leftover server from a previous run
  makes the new one fail to bind silently, so the browser measures the *old* code against a *deleted*
  temp home — which looks exactly like a passing test. It also verifies the server it reached reports
  the 8 proposals it seeded, and kills its child with `taskkill /T` (on Windows `kill()` reaps the
  shell, not `bun`).
- **It plants a genuinely unbreakable token, not a realistic-looking file path.** Browsers break
  happily after `/` and `-`, so the first version of the overflow check stayed green with *every*
  containment rule deleted. A run of letters with no break opportunity is what makes it bite — and it
  immediately exposed a real overflow (1,057px at a 420px viewport) that the weak version had hidden.
