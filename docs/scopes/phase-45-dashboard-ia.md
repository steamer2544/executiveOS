# Phase 45 — Dashboard information architecture

**Status:** IMPLEMENTED 2026-07-27 — see the Phase 45 entry in `docs/phase-log.md` for what the
sabotage checks changed, and two reported deviations (§7 criterion 10 was wrong as written; the diff
also touches `package.json` and `test/e2e/README.md`).
**Type:** presentation only. Deterministic, NO LLM, no new event/config/CLI/endpoint.
**Predecessor:** the dashboard has never had a design pass; it grew one card per phase (Phase 18 → 44).

---

## 1. The measurement this rests on

Everything below was measured on the **owner's live dashboard** (`127.0.0.1:4317`, real data, real
`.executive/` home) with Playwright at `1536×864`, on 2026-07-27. Not estimated from source lines.

**The page is 4,766px tall — 5.5 screens.** Card order, height, and share of the page:

| order | card | top | height | share |
|------:|------|----:|-------:|------:|
| 1 | `chatCard` | 119 | 465 | 10% |
| 2 | `listenCard` | 600 | 222 | 5% |
| 3 | `settingsCard` | 838 | 84 | 2% |
| 4 | `autonomyCard` | 937 | 307 | 6% |
| 5 | `fileOutputCard` | 1260 | 322 | 7% |
| 6 | **`proposalsCard`** | 1597 | **2039** | **43%** |
| 7 | Now | 3652 | 400 | 8% |
| 8 | Recommended action | 4068 | 88 | 2% |
| 9 | Needs you | 4172 | 96 | 2% |
| 10 | Suggestions | 4284 | 131 | 3% |
| 11 | Tell it something | 4431 | 209 | 4% |
| 12 | Last Autopilot run | 4656 | 88 | 2% |

**The finding is not the one `HANDOFF.md` predicted.** That section blamed configuration coming first
and called the settings card "~80 lines tall". Measured, `settingsCard` is **84px (2%)** — its body is
already collapsed by default. The three configuration cards together are 713px (15%).

The real finding is **one unbounded card**: `proposalsCard` was **2,039px — 43% of the entire page**,
rendering **8 pending proposals**, each with title + detail + evidence + an editable action field + a
note field + two buttons. There is no cap, no collapse, and no pagination. The queue is a `maxOpen`
list in `advisor.json`; the page renders all of it.

**And the cards that answer the product's actual question were empty.** At the moment of measurement:

- `needsYou` — **0 items** ("Nothing needs you right now. ✓"), 96px
- `recommended` — **null** ("No plan yet."), 88px

So **184px (3.9%) of a 4,766px page** was spent on the two sections that exist to answer *"what needs
me?"* — and both were spending it to say *nothing*. Meanwhile the owner must scroll **4.2 screens** to
reach `Now`, which holds the state the whole runtime derives (project, branch, current file, tests,
and the Phase 44 working-pattern line).

Two more measured facts:

- **At 420px wide the page overflows horizontally** (document 457px vs 420px viewport). There are no
  width breakpoints in the stylesheet — only two `flex-wrap` spots.
- **The header already answers the 5-second question in one line**: *"On branch main, editing
  worker\worker.test.ts; task: none; tests passing; not blocked; active."* It is rendered at 13px in
  `--muted`, above a 4,766px page that repeats the same facts 3,600px lower in a 10-row table.

### Reproduce

The numbers come from a Playwright script that loads the **running** dashboard and reads
`getBoundingClientRect()` for each `main > section.card`. The implementer must commit that logic as
`test/e2e/dashboard-ia.e2e.mjs` (§3) so the acceptance criteria below — which are expressed in the
same numbers — can be re-run rather than re-derived. Run it with **`node`, not `bun`**: Playwright's
Chromium pipe transport hangs under Bun (Phase 25.4).

---

## 2. What this phase is for

The product goal is **cutting decision fatigue**. A page where the answer occupies 3.9% and the queue
of things-that-can-wait occupies 43% inverts that. Phase 35 (the chat agent) was built because the
dashboard was pull-only and went unused; this phase is the other half of that diagnosis — the page the
owner *does* open should pay off in the first screen.

**The question to answer is not "which colours".** It is: *what should this page show when the owner
opens it for five seconds?* This scope's answer, in priority order:

1. **Where am I?** — project/branch/task/file/tests/working pattern (`Now`)
2. **What needs me?** — `Needs you` + `Recommended action` + unconfirmed `Suggestions`
3. **What can wait?** — the proposal queue, "Tell it something", the last autopilot run
4. **Configuration** — Autonomy, File output, Transcription settings

---

## 3. Files in scope

- `src/ui/page.ts` — the only file that must change (988 lines, one template literal)
- `src/ui/ui.test.ts` — assertions on the emitted markup
- `test/e2e/dashboard-ia.e2e.mjs` — **new**, opt-in, the only thing that can verify a layout claim

**Read `GOTCHA.md` §8 before editing `page.ts`.** Every regex backslash inside that template literal is
eaten at emit time, `bun test` stays green, and the whole inline script dies with
`Invalid regular expression`. Write no backslash in that file. Run `bun run test:e2e:chat` after any
edit — it is what catches this class of breakage.

## 4. What is NOT in scope

- **No new endpoint, no new config key, no new event type, no LLM call.** Presentation only.
- **No change to what any card means.** `Needs you` keeps its Phase 42.1 `label` projection; the
  dedup keys (`source|summary`) are untouched.
- **No restyling for its own sake** — no new palette, no font change, no icon set, no animation. The
  9 CSS custom properties and the single `prefers-color-scheme` override stay.
- **No framework, no build step, no external resource.** The page stays self-contained and offline.
- Not a rewrite of the inline JS. Move markup and add CSS; leave the fetch/render functions alone
  except where a card's container id changes.

---

## 5. Guardrails that must survive (non-negotiable)

1. **`🔴 Listening…` and `🔴 reading screen` stay visible whenever active.** Phase 23/29 ethics. They
   may not move into a collapsed section, a tooltip, or a hover state. If the Listening card is
   collapsed by default, the indicator must render **outside** it (header) when listening is on.
2. **`autopilot.apply` stays off the page.** Phase 34 — arming it is a deliberate `config.json` edit,
   and this page is unauthenticated on 127.0.0.1. The Autonomy card may keep *reporting* its state.
3. **No external fonts/CSS/JS/images.** The page must keep working with no network.
4. **Every write still confirms.** Collapsing a card must not turn a two-step action into one step;
   the proposal Approve/Dismiss buttons and the chat confirm chips keep their current behaviour.
5. **Nothing is removed from the page.** Every card that exists today is still reachable. This is a
   re-ordering and disclosure change, not a feature deletion.

---

## 6. The change

### 6.1 Order

New DOM order inside `<main>`:

```
1  statusCard        (Now — renamed heading "Where you are")
2  answerCard        (Needs you + Recommended action + Suggestions, merged — see 6.3)
3  chatCard          (unchanged, still hidden when the agent is off)
4  proposalsCard     (bounded — see 6.2)
5  tellCard          ("Tell it something")
6  autopilotCard     ("Last Autopilot run")
7  listenCard        (collapsed by default — see 6.4)
8  autonomyCard      (collapsed by default)
9  fileOutputCard    (collapsed by default)
10 settingsCard      (collapsed by default, as today)
```

Rationale for `chatCard` at 3 rather than 1: it is the one card that is *taller when it is working*
(a long transcript), so it cannot sit above the answer without pushing it off-screen again — which is
exactly today's failure in a different costume. It stays above the fold at common viewport heights
because 1+2 are small (see 7.1).

### 6.2 The proposal queue must be bounded

- Render at most **`VISIBLE_PROPOSALS = 3`** cards. Below them, when more exist:
  `+ N more proposals` as a `button.ghost` that expands the rest in place (no fetch — the data is
  already loaded).
- **The bound is on count, not on detail.** The visible 3 keep their full card — title, detail,
  evidence, action field, note field, both buttons. The `because:` evidence line is the Phase 33
  feature that makes a proposal checkable rather than trusted; truncating it to fit would undo the
  thing that made the Advisor useful.
- The expand state is **per page load**, not persisted. No new config.

### 6.3 One card answers the question, and it disappears when there is nothing to say

Merge `Recommended action`, `Needs you` and `Suggestions` into a single `answerCard`:

- If **all three are empty** → render the card as **one line**: `Nothing needs you right now. ✓`
  (≤ 56px, not 3 cards × ~90px saying it separately).
- If any is non-empty → render only the non-empty parts, in order: Needs you → Recommended →
  Suggestions, each with its existing markup and its existing sub-heading.
- The `Suggestions` Confirm buttons and the `needs` list styling are reused verbatim.

### 6.4 Collapsible sections

Reuse the existing `settingsCard` disclosure pattern (an `h2` with a Toggle button that flips
`display`). Apply it to `listenCard`, `autonomyCard`, `fileOutputCard`.

- Default collapsed. **Exception:** `listenCard` renders expanded whenever listening is active, and
  the `🔴 Listening…` indicator renders in the header regardless (guardrail 1).
- The collapsed header must still show state at a glance, so the owner is not required to expand to
  learn it: `Autonomy — chat, advisor, infer on`, `File output — 2 folders`, `Listening — off`.
- No `localStorage`, no config: collapsed is the default on every load. (Persisting it is a config
  write, which this scope excludes.)

### 6.5 Width

- `main { max-width: 920px }` stays for the single-column case.
- Add **one** breakpoint at `min-width: 1180px`: `main` becomes a two-column grid
  (`grid-template-columns: minmax(0,1.35fr) minmax(0,1fr)`, `max-width: 1240px`) with the answer
  column (1,2,3) on the left and the queue/config column (4…10) on the right.
- Add **one** breakpoint at `max-width: 480px`: `main { padding: 12px }`, and every `.field` gets
  `flex-wrap: wrap` with `input { min-width: 0 }` so the 420px horizontal overflow is gone.
- `min-width:0` on grid children is required or long unbroken strings (a file path, a URL in a
  proposal) reintroduce the overflow.

---

## 7. Acceptance criteria

Each is measured on the **running dashboard**, not read from source. `test/e2e/dashboard-ia.e2e.mjs`
must implement 1–8 and auto-skip (exit 0) when Playwright is unavailable, matching
`test/e2e/README.md`.

**Layout (measured at 1536×864 with the owner's real data — 8 proposals, empty needsYou):**

1. `Now`/`statusCard` starts at `top < 300px` (today: 3,652).
2. `answerCard` is **fully above the fold** — `top + height < 864` (today `Needs you` starts at 4,172).
3. Total page height is **< 2,400px** (today: 4,766) with all sections collapsed by default.
4. `proposalsCard` height is **< 900px** with 8 pending proposals (today: 2,039), and shows a
   `+ 5 more` control; clicking it renders all 8.
5. With `needsYou`, `recommended` and `suggestions` all empty, `answerCard` height is **≤ 56px**.
6. With a non-empty `needsYou`, every item's text still appears (no truncation of the queue).

**Responsive:**

7. At 420×900 `document.documentElement.scrollWidth <= 420` (today: 457 — overflow).
8. At 1280×900 the layout is two columns: `statusCard` and `proposalsCard` have **different**
   `getBoundingClientRect().left`.

**Guardrails (unit tests in `ui.test.ts` unless noted):**

9. `renderPage()` contains the `🔴` listening indicator markup, and it is **not** inside
   `listenCard`'s collapsible body.
10. `renderPage()` contains no `autopilotApply` control (string absent), matching Phase 34.
11. `renderPage()` contains no `http://` or `https://` resource reference (no external asset).
12. `new Function(scriptSource)` on the emitted inline script does not throw (the GOTCHA §8 guard
    already in `ui.test.ts`; keep it and re-run it).
13. `bun run test:e2e:chat` still passes — the chat card's markdown rendering and no-yank scroll
    survive the move.
14. Every card id present today is present after the change (`chatCard listenCard settingsCard
    autonomyCard fileOutputCard proposalsCard suggestCard` + the four unnamed ones gain ids).

**Non-regression:**

15. `bun test` green, `bun run typecheck` green.
16. `git diff --stat` touches only `src/ui/page.ts`, `src/ui/ui.test.ts`, and the new e2e file.

---

## 8. Sabotage checks (run these, do not take a report on trust)

Per `GOTCHA.md` §4, a green suite proves nothing until a deliberate break turns it red. Run each,
confirm the named criterion fails, then restore:

1. Move `proposalsCard` back above `statusCard` → criteria 1 and 2 fail.
2. Remove the `VISIBLE_PROPOSALS` bound (render all) → criterion 4 fails.
3. Make the empty `answerCard` render three separate cards again → criterion 5 fails.
4. Delete the `max-width: 480px` breakpoint → criterion 7 fails.
5. Move the `🔴` indicator inside the collapsible listen body → criterion 9 fails.
6. Remove `min-width: 0` from the grid children → criterion 7 fails at 420px with a long path.

If a sabotage does **not** turn its criterion red, the criterion is vacuous — fix the test, not the
sabotage. (This is how Phase 43's decisive check was found to be passing against a broken
implementation.)

---

## 9. Open questions for the owner — **ANSWERED 2026-07-27, both as the scope proposed**

These changed the work materially and were the owner's call, not the implementer's. Both are now
settled; **nothing in §6 changes as a result** — the scope's defaults were the answers.

1. **Does the chat card belong on this page at all?** The owner's day-to-day interface is Discord.
   Removing it would free 465px and simplify the fold — but it is also the only place the browser mic
   works. *This scope keeps it* (guardrail 5: nothing is removed).
   → **OWNER: keep it.** `chatCard` stays, at position 3 per §6.1.
2. **Is `VISIBLE_PROPOSALS = 3` right?** Three is chosen so the queue cannot outweigh the answer; the
   real number depends on how often the owner acts on more than the top few.
   → **OWNER: 3 is right.** Implement §6.2 as written.
