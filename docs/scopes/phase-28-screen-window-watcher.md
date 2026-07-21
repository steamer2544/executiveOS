# Scope — Phase 28: Screen-sense Layer 1 — window-title watcher (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.

---

## 0. What this phase is (and is NOT)

ExecutiveOS senses the owner's work from git + files + voice notes, but it cannot see what the owner is
*looking at* — a Trello board, a LINE chat, a YouTube video, a doc. The owner does not want to wire up a
separate API for each service. The universal, low-friction sensor is **the screen itself** — but reading
the full screen has real privacy weight, so it is built in **escalating layers, each independently
toggle-able, off by default.**

**Phase 28 builds Layer 1 only: a deterministic watcher that reads the ACTIVE WINDOW TITLE (and its
process name) and emits an event when it changes.** No screenshots, no OCR, no LLM, no image leaves the
machine. A browser puts the page title in its window title, so Layer 1 alone yields meaningful context
like `"Sprint Board | Trello"`, `"อธิบาย Rust ownership - YouTube"`, `"แชท OPM Dev — LINE"`. Those events
flow into the event log → `Context` → so the existing Advisor / infer already "see" what the owner is
doing, with almost zero privacy blast radius (a title is not the screen contents).

Layers 2 (screenshot + local OCR) and 3 (screenshot → vision LLM) are **Phase 29 — do NOT build them
here.** This phase must not capture a screenshot, must not call any LLM, and must not read pixels.

**Core principle (do not violate):** this is the deterministic core — a poll-based watcher exactly like
the GitWatcher (Phase 2). Newest event wins. No intelligence.

### CRITICAL — hard guardrails (a violation of any is a defect)

- **Off by default.** `config.screen.window.enabled` defaults **false**. A config without a `screen` block
  (every existing config) must load unchanged and start **no** screen watcher. `watch`/`ui` behave exactly
  as today unless the owner opts in.
- **Title + process name ONLY.** Emit the foreground window's title and process name. Do NOT capture the
  screen, do NOT read window contents, do NOT take a screenshot, do NOT call OCR or any LLM. Reading
  anything beyond the title/process name is a defect (that is Phase 29).
- **Local only, no network.** Nothing this phase does touches the network.
- **Dedup — no spam.** Emit an event only when `(title, app)` **changes** from the last observed value
  (same discipline as GitWatcher's sha/branch dedup). Polling the same window every 3 s must produce **one**
  event, not one per poll.
- **Cross-platform safe.** The runtime targets Windows 11 but the code must not crash elsewhere. On a
  platform where the capture command is unavailable, warn once to stderr and keep polling (return `null`,
  emit nothing) — mirror the GitWatcher's "not a git repo → warn once, keep polling" behavior.
- **The daemon never crashes over this watcher.** Any error in the poll is caught and logged; the daemon
  keeps running.

### Out of scope (do NOT build)

- No screenshots, OCR, vision, or any LLM (Phase 29).
- No per-app parsing (e.g. do NOT try to extract the Trello card list from the title — just pass the raw
  title through; interpretation is the Advisor/infer's job, and deeper reading is Phase 29).
- No new suggestion type, no digest "suggestions" changes, no Planner change.
- No browser-URL extraction via UI Automation / extensions (title only in this phase).
- No SQLite, no server route changes beyond optionally showing the current window in the existing
  `/api/state` payload (see §5).

---

## 1. Config (`src/config.ts` — additive, backward-compatible)

Add a `screen` block. **This phase only implements `screen.window`**; define just that (Phase 29 will add
`screen.ocr` / `screen.vision`).

```ts
  /** Screen-sensing (Layer 1 here). Each layer is independently toggle-able; all OFF by default. */
  screen?: {
    window?: {
      enabled?: boolean; // Layer 1: emit the active window title/process on change. Default false.
      pollMs?: number;   // poll cadence. Default 3000.
    };
  };
```

- `defaultConfig()` **does not** add a `screen` key (default = no screen sensing; backward compatible).
- In `loadConfig()`, merge defensively: if `parsed.screen?.window` is present, fill
  `enabled ?? false` and `pollMs ?? 3000`. If `parsed.screen` is absent, leave it `undefined` (do not
  fabricate one — absence means "no screen sensing", which the daemon treats as off).

**Backward compatibility (must verify):** a config with no `screen` key loads fine and starts no screen
watcher; `loadConfig()` does not throw and does not add a `screen` block.

---

## 2. Platform capture primitive (`src/screen/capture.ts` — new, isolated + mockable)

Isolate the one OS-specific call behind a tiny pure-ish function so the watcher stays testable:

```ts
export interface ForegroundWindow { title: string; app: string } // app = process name, e.g. "chrome"

/** Return the current foreground window's title + process name, or null if unavailable
 *  (non-Windows, no focused window, or the query failed). Never throws. Synchronous. */
export function foregroundWindow(): ForegroundWindow | null;
```

**Windows implementation:** shell out synchronously (like GitWatcher's `Bun.spawnSync`) to PowerShell,
running a small script that uses `user32.dll` `GetForegroundWindow` + `GetWindowText` (+
`GetWindowThreadProcessId` → `Process.ProcessName`). Suggested script (adapt as needed):

```powershell
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;using System.Diagnostics;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  public static string Get(){
    IntPtr h=GetForegroundWindow(); var sb=new StringBuilder(1024); GetWindowText(h,sb,1024);
    int pid; GetWindowThreadProcessId(h,out pid);
    string p=""; try{ p=Process.GetProcessById(pid).ProcessName; }catch{}
    return sb.ToString()+"\t"+p;
  }
}
"@
[W]::Get()
```

Parse the single `title<TAB>app` line. Empty title → `null`. **Robustness:** guard `spawnSync` for a
non-zero exit / missing PowerShell / non-Windows (`process.platform !== "win32"`) → return `null` (do not
throw). Keep a module-level `warnedUnavailable` so the caller can warn once (or let the watcher own the
warn-once — your choice, but warn at most once).

> Performance: launching PowerShell per poll at 3 s cadence is acceptable for this phase (git is polled
> similarly). Do NOT add a long-running helper process — out of scope.

Keep `capture.ts` free of any screenshot/OCR/LLM code. It exports exactly `foregroundWindow` +
`ForegroundWindow` in this phase.

---

## 3. The watcher (`src/watchers/screen.ts` — new, mirrors GitWatcher)

```ts
export interface ScreenWatcherConfig {
  pollMs: number;
  /** injectable for tests: defaults to capture.foregroundWindow */
  read?: () => import("../screen/capture.js").ForegroundWindow | null;
}
export function createScreenWatcher(cfg: ScreenWatcherConfig): Watcher;
```

Behavior (closure state, like GitWatcher — never module-global):
- `name: "screen"`.
- `start(bus)`: record the current window as the baseline **without emitting** (same as GitWatcher records
  baseline HEAD without emitting), then `setInterval(poll, pollMs)`.
- `poll()`:
  - `const w = read();` (guard the whole body in try/catch → stderr + keep polling).
  - `if (w === null)` → warn once ("ScreenWatcher: foreground window unavailable — will keep polling"),
    return.
  - If `(w.title, w.app)` differs from the last observed → `bus.publish({ source: "screen", type:
    "screen.window", data: { title: w.title, app: w.app } })`, and update the last observed.
- `stop()`: idempotent `clearInterval`, clear bus ref (same pattern as GitWatcher).

Use the injectable `read` in tests to feed a scripted sequence of windows (no real PowerShell in tests).

---

## 4. Wiring into the daemon (`src/index.ts` and/or `src/watchers/build.ts`)

The screen watcher is a new watcher in the same list the daemon starts. Add it wherever watchers are
assembled (if Phase 26's `buildWatchers` exists, add it there; otherwise add to the `watch` and `ui`
`case` blocks alongside git/fs):

```
if (config.screen?.window?.enabled === true):
    push createScreenWatcher({ pollMs: config.screen.window.pollMs ?? 3000 })
    activeNames.push("screen")
```

- Respect the same rules as git/fs (built once, added to `WatcherManager`).
- Update the startup banner's active-watcher list to include `"screen"` when on.
- The `ui --no-watch` flag still means "no watchers" (screen included).

No change to the EventBus, StoreSink, rebuild timer, or SIGINT handling.

---

## 5. State + UI surface (small, additive — the visible payoff)

- **State (`src/state/types.ts` + `src/state/builder.ts`):** add
  `currentWindow: { title: string; app: string } | null` to `State`, derived from the **newest**
  `screen.window` event (null if none). Purely additive; existing fields unchanged. Do NOT add it to the
  Planner's inputs or change any rule — it is context/display only.
- **Digest (`src/report/digest.ts`):** in the **Now** section, when `currentWindow` is present, add one
  line, e.g. `Looking at: Sprint Board | Trello  (chrome)`. When absent, print nothing new (single setups
  without the watcher stay byte-identical).
- **UI (`src/ui/page.ts`):** show `currentWindow` in the Now card when present. It rides along in the
  existing `/api/state` payload if that serializes `state` — no new endpoint.

The `screen.window` events also land in the event log and therefore in `Context.recentEvents`, so the
Advisor and infer automatically gain screen context with **no change to their code** (that is the point of
Layer 1).

---

## 6. Files to create / edit

### Create
```
src/screen/capture.ts        # foregroundWindow() — Windows PowerShell, null-safe, no screenshot/OCR/LLM
src/watchers/screen.ts       # createScreenWatcher (poll + dedup + warn-once)
src/watchers/screen.test.ts  # offline: scripted `read` → correct emit/dedup behavior
```

### Edit
- `src/config.ts` — `screen.window` type + defensive merge (no default `screen` block).
- `src/index.ts` (and `src/watchers/build.ts` if it exists) — start the screen watcher when enabled;
  banner lists it.
- `src/state/types.ts` + `src/state/builder.ts` — additive `currentWindow`.
- `src/report/digest.ts` — Now-section "Looking at" line when present.
- `src/ui/page.ts` — Now card shows current window when present.
- `src/state/builder.test.ts` — `currentWindow` derivation test.

Do NOT edit the Planner, Worker, Executor, Synth, Autopilot, Advisor, or infer.

---

## 7. Tests (`bun test`, OFFLINE) — required

`src/watchers/screen.test.ts` (inject `read`, no real PowerShell):
1. **Baseline no-emit:** first observed window at `start` does not emit; a bus spy sees nothing until a
   change.
2. **Emit on change:** feed window A then window B → exactly one `screen.window{title,app}` for B.
3. **Dedup:** feed A, A, A → no emit after baseline.
4. **Unavailable:** `read` returns `null` → no emit, no throw (and warns at most once across polls).
5. **Stop is idempotent:** calling `stop()` twice does not throw; no emit after stop.

`src/state/builder.test.ts`:
6. **`currentWindow` derivation:** an event log with two `screen.window` events → `state.currentWindow`
   equals the newest one; a log with none → `null`.

Config test (in `src/config.test.ts` if present, else in `screen.test.ts`):
7. A config with no `screen` key loads and `screen` is `undefined` (or its `window.enabled` is falsy); a
   config with `screen.window` fills `pollMs` default.

All existing tests must still pass. **No test may spawn PowerShell, take a screenshot, or hit the
network.** The capture primitive is exercised only via the injected `read` mock.

---

## 8. Acceptance criteria (Claude will verify ALL of these by running them)

- [ ] `bun run typecheck` passes (strict); `bun test` passes offline.
- [ ] **Off by default:** a config with no `screen` block → `watch`/`ui` starts no screen watcher, banner
      unchanged, no `screen.window` events. Verified live.
- [ ] **On:** with `screen.window.enabled: true`, running `watch` on Windows and switching the foreground
      window (e.g. focus a browser tab titled X, then a different app) emits `screen.window` events whose
      `title`/`app` match, deduped (no spam while the window is unchanged). Verified live on Windows.
- [ ] **`currentWindow` surfaces:** after such events, `build-state`/`report` shows the "Looking at:" line
      and `state.json.currentWindow` is the newest window.
- [ ] **No screenshot / OCR / LLM / network:** grep confirms `src/screen/capture.ts` and
      `src/watchers/screen.ts` contain no screenshot/OCR/image/LLM/fetch calls. (Phase 29 territory.)
- [ ] **Cross-platform safe:** on a non-Windows runner (or when the capture command fails), the watcher
      logs once and keeps polling; the daemon does not crash; SIGINT exits cleanly.
- [ ] Planner / Worker / Executor / Synth / Autopilot / Advisor / infer **unchanged** (git diff empty).
- [ ] `.executive/` stays gitignored; only §6 files created/edited.

---

## 9. Deliverable

A commit containing §6's files + this doc. Do NOT commit `.executive/` runtime data. Hand back for
review — Claude runs every item in §8 (including a live Windows check) and will NOT trust the self-report.

---

## 10. Design notes (rationale — not extra work)

- **Why title-only first:** it is the highest-ROI, lowest-risk slice of screen sensing. A window title is
  not the screen's contents — it leaks almost nothing about third parties — yet it already answers "what
  app / what page is the owner on", which is exactly the context the Advisor was missing. It ships in a day
  and unblocks the "sense it, don't ask for it" goal without a single screenshot.
- **Why a plain watcher (no LLM):** Layer 1 is pure observation. Keeping it deterministic means it costs
  nothing, never blocks a tick, and its events feed the existing LLM stages (Advisor/infer) for free —
  the interpretation lives where it already belongs.
- **Why off by default + independent toggle:** screen sensing is sensitive; the owner turns on exactly the
  layer they want. Layer 1 being separately switchable means the owner can have cheap title-context on
  without ever enabling screenshots.
- **Why the capture call is isolated in `capture.ts`:** Phase 29 (OCR + vision) will add screenshot +
  pixel-reading primitives next to it; keeping the OS-specific surface in one module keeps both phases
  clean and mockable, and keeps the watcher itself trivially testable with an injected reader.
