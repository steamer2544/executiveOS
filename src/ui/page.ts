// The ExecutiveOS dashboard page (Phase 18) — a single self-contained HTML page.
// No external resources: inline CSS + JS only. Talks to the local server's
// /api/state (read) and /api/emit (write) endpoints. Pure — returns a string.

export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ExecutiveOS</title>
<style>
  :root {
    --bg: #0f1115; --card: #181b22; --line: #262b36; --fg: #e7ebf0; --muted: #8a93a2;
    --act: #3fb950; --ask: #d29922; --accent: #58a6ff; --danger: #f85149;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f5f6f8; --card:#fff; --line:#e2e5ea; --fg:#1b1f26; --muted:#5b636f; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { display:flex; align-items:center; gap:12px; padding:16px 22px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); }
  header h1 { font-size:17px; margin:0; font-weight:650; }
  header .sub { color:var(--muted); font-size:13px; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--act); box-shadow:0 0 0 3px color-mix(in srgb, var(--act) 25%, transparent); }
  main { max-width:920px; margin:0 auto; padding:22px; display:grid; gap:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
  .card h2 { margin:0 0 12px; font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  .row { display:flex; justify-content:space-between; gap:12px; padding:5px 0; border-bottom:1px dashed var(--line); }
  .row:last-child { border-bottom:0; }
  .row .k { color:var(--muted); } .row .v { text-align:right; font-weight:550; }
  .pill { display:inline-block; padding:2px 9px; border-radius:999px; font-size:12px; font-weight:650; }
  .pill.act { background:color-mix(in srgb, var(--act) 20%, transparent); color:var(--act); }
  .pill.ask { background:color-mix(in srgb, var(--ask) 20%, transparent); color:var(--ask); }
  .needs { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
  .needs li { background:color-mix(in srgb, var(--ask) 10%, transparent); border:1px solid color-mix(in srgb, var(--ask) 30%, transparent); border-radius:9px; padding:9px 12px; }
  .needs li .src { font-size:11px; text-transform:uppercase; color:var(--muted); letter-spacing:.05em; }
  .needs .empty { color:var(--muted); background:none; border:0; padding:4px 0; }
  .controls { display:grid; gap:10px; }
  .field { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  input[type=text], input[type=date] { flex:1; min-width:160px; background:var(--bg); border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:8px 10px; font:inherit; }
  select { background:var(--bg); border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:6px 10px; font:inherit; }
  button { background:var(--accent); color:#04121f; border:0; border-radius:8px; padding:8px 14px; font:inherit; font-weight:650; cursor:pointer; }
  button.ghost { background:transparent; color:var(--fg); border:1px solid var(--line); }
  button.danger { background:var(--danger); color:#fff; }
  button:active { transform:translateY(1px); }
  .muted { color:var(--muted); } .mono { font-family:ui-monospace, Menlo, Consolas, monospace; }
  .prop { border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:10px; }
  .prop .cat { font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--accent); font-weight:700; }
  .prop .badge { font-size:10.5px; padding:2px 8px; border-radius:999px; margin-left:8px; }
  .prop .badge.exec { background:var(--accent); color:#fff; }
  .prop .badge.record { background:transparent; border:1px solid var(--line); color:var(--muted); }
  .prop .title { font-weight:650; margin:2px 0 4px; }
  .prop .detail { color:var(--muted); margin-bottom:8px; }
  /* The observation a proposal rests on — lets the owner check it, not just trust it. */
  .prop .evidence { color:var(--muted); font-size:12px; font-style:italic; margin-bottom:8px; opacity:.85; }
  .auto-row { display:flex; gap:10px; align-items:flex-start; padding:7px 0; font-size:13px; cursor:pointer; }
  .auto-row input { margin-top:2px; flex:none; }
  .prop input { margin-bottom:8px; }
  .prop .acts { display:flex; gap:8px; }
  .prop .empty { color:var(--muted); }
  #toast { position:fixed; bottom:18px; left:50%; transform:translateX(-50%); background:var(--card); border:1px solid var(--line); padding:9px 16px; border-radius:9px; opacity:0; transition:opacity .2s; pointer-events:none; }
  #toast.show { opacity:1; }
</style>
</head>
<body>
<header>
  <span class="dot"></span>
  <div>
    <h1>ExecutiveOS</h1>
    <div class="sub" id="summary">loading…</div>
    <div class="mono" id="screenIndicator" style="font-size:11.5px;margin-top:2px"></div>
  </div>
  <div style="margin-left:auto"><button class="ghost" onclick="refresh()">↻ Refresh</button></div>
</header>

<main>
  <section class="card" id="chatCard" style="display:none">
    <h2 style="display:flex;justify-content:space-between;align-items:center">
      <span>คุยกับผม</span>
      <span style="display:flex;gap:8px;align-items:center">
        <label class="muted" style="font-size:12.5px;display:flex;gap:5px;align-items:center">
          <input type="checkbox" id="chatSpeak" onchange="saveSpeak()" /> 🔊 พูดตอบ
        </label>
        <button class="ghost" style="font-size:11px;padding:2px 8px" onclick="clearChat()">ล้าง</button>
      </span>
    </h2>
    <div id="chatLog" style="max-height:340px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:10px"></div>
    <div id="chatPending"></div>
    <div style="display:flex;gap:8px">
      <input id="chatInput" type="text" placeholder="ถามหรือสั่งอะไรก็ได้ — หรือกดค้าง Space แล้วพูด" style="flex:1"
             onkeydown="if(event.key==='Enter')sendChat()" />
      <button class="btn" id="chatSend" onclick="sendChat()">ส่ง</button>
    </div>
    <div id="chatBusy" class="muted" style="font-size:12.5px;margin-top:6px"></div>
  </section>

  <section class="card" id="listenCard">
    <h2 style="display:flex;justify-content:space-between;align-items:center">
      <span>Listening</span>
      <button class="btn" id="micBtn" onclick="toggleListen()">Start listening</button>
    </h2>
    <div id="listenStatus" class="muted">Off. This listens to <b>you</b> (your dictated notes) — nothing is recorded without this being visibly on.</div>
    <div id="listenInterim" class="mono" style="margin-top:8px;min-height:1.2em;color:var(--accent)"></div>
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
      <span class="muted" style="font-size:12.5px">Language</span>
      <select id="lang" onchange="onLangChange()">
        <option value="">Auto (best for Thai↔English)</option>
        <option value="th">ไทย</option>
        <option value="en">English</option>
      </select>
      <span class="muted" style="font-size:11.5px">applies to all modes</span>
    </div>
    <div id="listenSchedule" class="muted" style="margin-top:6px;font-size:12.5px"></div>
    <div class="muted" style="margin-top:4px;font-size:12.5px">Tip: hold <b>Space</b> to talk (walkie-talkie), release to stop.</div>
  </section>

  <section class="card" id="settingsCard">
    <h2 style="display:flex;justify-content:space-between;align-items:center">
      <span>Transcription settings</span>
      <button class="ghost" onclick="$('settingsBody').style.display = $('settingsBody').style.display==='none'?'block':'none'">Toggle</button>
    </h2>
    <div id="settingsBody" style="display:none">
      <div class="controls">
        <div class="field">
          <span class="muted" style="font-size:12.5px;min-width:70px">Mode</span>
          <select id="modeSel" onchange="onModeChange()">
            <option value="webspeech">Web Speech (browser, no key)</option>
            <option value="whisper-api">Whisper API (Groq / local server)</option>
            <option value="browser-wasm">Browser-WASM (offline, in-browser)</option>
          </select>
        </div>

        <div id="apiFields" style="display:none">
          <div class="field">
            <span class="muted" style="font-size:12.5px;min-width:70px">Preset</span>
            <button class="ghost" onclick="applyPreset('groq')">Groq (free tier)</button>
            <button class="ghost" onclick="applyPreset('local')">Local faster-whisper</button>
          </div>
          <div class="field"><input id="setBaseUrl" type="text" placeholder="Base URL — click a preset above, or paste your endpoint" /></div>
          <div class="field"><input id="setModel" type="text" placeholder="Model (e.g. whisper-large-v3-turbo)" /></div>
          <div class="field"><input id="setKeyEnv" type="text" placeholder="Key env-var name (default EXECUTIVE_TRANSCRIBE_KEY)" /></div>
          <div class="muted" style="font-size:12px">The key itself is <b>never</b> stored here — put it in your <span class="mono">.env</span> under that env-var name.</div>
        </div>

        <div id="wasmFields" style="display:none">
          <div class="field"><input id="setWasmModel" type="text" placeholder="WASM model id (default Xenova/whisper-base)" /></div>
          <div class="field">
            <button class="ghost" id="dlBtn" onclick="downloadModel()">Download model for offline use</button>
            <span id="dlStatus" class="muted" style="font-size:12.5px"></span>
          </div>
          <div class="muted" style="font-size:12px">Downloads the model + runtime to <span class="mono">.executive/</span> once, then runs 100% offline — your audio never leaves the machine.</div>
        </div>

        <div style="border-top:1px solid var(--line);margin-top:14px;padding-top:14px">
          <div class="muted" style="font-size:12.5px;margin-bottom:8px">
            Screen sensing (OFF by default). Reads your active window / screen contents to suggest block/deadline/task — never auto-acts, you confirm everything below.
          </div>
          <div class="field">
            <label class="muted" style="font-size:12.5px;min-width:70px;display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="scrWindowEnabled" /> Window title (Layer 1)
            </label>
            <label class="muted" style="font-size:12.5px;min-width:70px;display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="scrOcrEnabled" /> Local OCR (Layer 2 — image stays on this machine)
            </label>
            <label class="muted" style="font-size:12.5px;min-width:70px;display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="scrVisionEnabled" onchange="toggleScreenVisionFields()" /> Vision LLM (Layer 3 — sends the screenshot to the gateway)
            </label>
          </div>
          <div class="field" style="margin-top:8px">
            <label class="muted" style="font-size:12.5px">OCR engine</label>
            <select id="scrOcrEngine" onchange="toggleOcrEngineFields()">
              <option value="winrt">Windows built-in — English only (no Thai pack exists)</option>
              <option value="tesseract">Tesseract — Thai + English (needs tesseract.exe)</option>
            </select>
          </div>
          <div id="scrOcrTessFields" style="display:none">
            <div class="field"><input id="scrOcrLanguages" type="text" placeholder="Languages (default tha+eng)" /></div>
            <div class="field"><input id="scrOcrTessPath" type="text" placeholder="tesseract.exe path (blank = auto-detect)" /></div>
          </div>
          <div id="scrVisionFields" style="display:none;margin-top:8px">
            <div class="field"><input id="scrVisionModel" type="text" placeholder="Vision model (default qwen-vl-max)" /></div>
            <div class="field"><input id="scrVisionBaseUrl" type="text" placeholder="Vision base URL (default = worker's baseUrl)" /></div>
            <div class="field"><input id="scrVisionKeyEnv" type="text" placeholder="Key env-var name (default = worker's apiKeyEnv)" /></div>
          </div>
          <div class="field" style="margin-top:8px">
            <button onclick="saveScreenSettings()">Save screen settings</button>
            <span id="screenStatus" class="muted" style="font-size:12.5px"></span>
          </div>
        </div>

        <div class="field">
          <button onclick="saveSettings()">Save</button>
          <span class="muted" style="font-size:12px">Language is set in the Listening card above (applies to every mode).</span>
        </div>
      </div>
    </div>
  </section>

  <section class="card" id="autonomyCard">
    <h2>Autonomy</h2>
    <div class="muted" style="font-size:12px;margin-bottom:10px">
      What runs on its own while this dashboard is open. All off by default; each takes effect
      on the next tick, no restart.
    </div>
    <label class="auto-row">
      <input type="checkbox" id="autoAgent" onchange="saveAutonomy()" />
      <span><b>Chat</b> — talk to it by text or voice; it reads your real state and can act
      (every write asks you first).</span>
    </label>
    <label class="auto-row">
      <input type="checkbox" id="autoAdvisor" onchange="saveAutonomy()" />
      <span><b>Advisor</b> — proposes work + life actions for you to approve. Costs an LLM call.</span>
    </label>
    <label class="auto-row">
      <input type="checkbox" id="autoInfer" onchange="saveAutonomy()" />
      <span><b>Infer</b> — guesses blockers and deadlines. Suggestions only, you confirm. Costs an LLM call.</span>
    </label>
    <label class="auto-row">
      <input type="checkbox" id="autoAutopilot" onchange="saveAutonomy()" />
      <span><b>Autopilot</b> — runs plan→work→synth→execute when the Planner says <i>act</i>.</span>
    </label>
    <label class="auto-row">
      <input type="checkbox" id="autoDeadlineDecay" onchange="saveAutonomy()" />
      <span><b>Auto-retire deadlines</b> — a deadline overdue by more than 7 days retires itself.
      Off = it keeps nagging until you close it out or clear it. No LLM, no repo change.</span>
    </label>
    <div id="applyState" class="muted" style="font-size:12px;margin-top:8px"></div>
  </section>

  <section class="card" id="proposalsCard">
    <h2 style="display:flex;justify-content:space-between;align-items:center">
      <span>Decisions for you</span>
      <button class="btn ghost" id="askBtn" onclick="askProposals()">Ask for proposals</button>
    </h2>
    <div id="proposals"></div>
  </section>

  <section class="card">
    <h2>Now</h2>
    <div id="now"></div>
  </section>

  <section class="card">
    <h2>Recommended action</h2>
    <div id="recommended"></div>
  </section>

  <section class="card">
    <h2>Needs you</h2>
    <ul class="needs" id="needs"></ul>
  </section>

  <section class="card" id="suggestCard" style="display:none">
    <h2>Suggestions · unconfirmed (from the LLM)</h2>
    <ul class="needs" id="suggestions"></ul>
  </section>

  <section class="card">
    <h2>Tell it something</h2>
    <div class="controls">
      <div class="field">
        <input id="blockReason" type="text" placeholder="What are you blocked on? (e.g. waiting on vendor API key)" />
        <button class="danger" onclick="emitBlock()">Mark blocked</button>
        <button class="ghost" onclick="emitUnblock()">Unblock</button>
      </div>
      <div class="field">
        <input id="deadline" type="date" />
        <button onclick="emitDeadline()">Set deadline</button>
      </div>
      <div class="field">
        <input id="task" type="text" placeholder="Current task (overrides the branch-inferred one)" />
        <button onclick="emitTask()">Set task</button>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Last Autopilot run</h2>
    <div id="autopilot"></div>
  </section>
</main>

<div id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const dash = (v) => (v === null || v === undefined || v === "") ? "<span class='muted'>—</span>" : esc(v);

function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"), 1600); }

function repoList(repos, activeRepo) {
  if (!repos || repos.length <= 1) return "";
  return repos.map(function(r) { return (r.name === activeRepo ? r.name + "*" : r.name) + " (" + (r.branch || "no branch") + ")"; }).join(", ");
}

function rows(pairs) {
  return pairs.map(([k,v]) => \`<div class="row"><span class="k">\${k}</span><span class="v">\${v}</span></div>\`).join("");
}

async function refresh() {
  try {
    const r = await fetch("/api/state"); const d = await r.json();
    const dg = d.digest; $("summary").textContent = d.summary || "";
    const sa = d.screenActivity || { active: false, layer: null };
    const scrOn = !!((cfgScreen.ocr && cfgScreen.ocr.enabled) || (cfgScreen.vision && cfgScreen.vision.enabled));
    $("screenIndicator").innerHTML = sa.active
      ? '<span style="color:var(--danger);font-weight:700">🔴 reading screen (' + esc(sa.layer || "") + ')</span>'
      : '<span class="muted">screen sensing: ' + (scrOn ? "on" : "off") + '</span>';
    const n = dg.now;
    $("now").innerHTML = n.available ? rows([
      ["Project", dash(n.project)],
      ["Task", dash(n.task) + (n.task ? \` <button class="ghost" style="font-size:11px;padding:2px 8px" onclick="clearTask()">Clear task</button>\` : "")],
      ["Tests", n.tests ? \`<span class="pill \${n.tests==='failing'?'ask':'act'}">\${esc(n.tests)}</span>\` : dash(null)],
      ["Blocked", n.blocked ? \`<span class="pill ask">yes</span> \${esc(n.blockedReason||"")}\` : "no"],
      ["Branch", dash(n.branch)],
      ["Deadline", dash(n.deadline) + (n.deadline ? \` <button class="ghost" style="font-size:11px;padding:2px 8px" onclick="clearDeadline()">Clear deadline</button>\` : "")],
      ["Current file", dash(n.currentFile)], ["Idle", n.idle===true?"yes":n.idle===false?"no":dash(null)],
    ]) + (n.currentWindow ? \`<div class="row"><span class="k">Looking at</span><span class="v">\${esc(n.currentWindow.title)} <span class="muted">(\${esc(n.currentWindow.app)})</span></span></div>\` : "") + (n.repos && n.repos.length > 1 ? \`<div class="row"><span class="k">Repos</span><span class="v">\${repoList(n.repos, n.activeRepo)}</span></div>\` : "")
      : "<span class='muted'>No state yet.</span>";

    const rec = dg.recommended;
    $("recommended").innerHTML = rec.available && rec.topActionKind
      ? \`<div><span class="pill \${rec.disposition==='act'?'act':'ask'}">\${esc((rec.disposition||'').toUpperCase())}</span> <b>\${esc(rec.topActionKind)}</b></div>
         <div class="muted" style="margin-top:6px">\${esc(rec.reason||"")}</div>
         <div class="muted mono" style="margin-top:4px">confidence \${rec.confidence!=null?Math.round(rec.confidence*100)+"%":"—"} · \${rec.actionCount} action(s)</div>\`
      : "<span class='muted'>No plan yet.</span>";

    const needs = dg.needsYou || [];
    $("needs").innerHTML = needs.length
      ? needs.map(i => \`<li><div class="src">\${esc(i.source)}</div><div><b>\${esc(i.summary)}</b></div>\${i.detail?\`<div class="muted">\${esc(i.detail)}</div>\`:""}</li>\`).join("")
      : "<li class='empty'>Nothing needs you right now. ✓</li>";

    const sug = dg.suggestions || [];
    $("suggestCard").style.display = sug.length ? "block" : "none";
    window.__suggest = sug;
    $("suggestions").innerHTML = sug.map((s, i) =>
      \`<li style="display:flex;gap:10px;align-items:center;justify-content:space-between">
         <span>\${esc(s.text)}</span>
         <button class="btn" onclick="confirmSuggestion(\${i})">Confirm</button>
       </li>\`).join("");

    const a = dg.lastAutopilot;
    $("autopilot").innerHTML = a.available ? rows([
      ["Stage", dash(a.stage)], ["OK", a.ok===null?dash(null):(a.ok?"yes":"no")],
      ["Applied", a.applied?("yes — "+esc(a.branch||"")):"no"],
      ["Tests passed", a.testPassed===null?dash(null):(a.testPassed?"yes":"no")],
    ]) : "<span class='muted'>Autopilot has not run.</span>";
  } catch (e) { toast("refresh failed"); }
}

async function emit(type, data) {
  try {
    const r = await fetch("/api/emit", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ type, data }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "failed");
    toast("saved ✓"); await refresh();
  } catch (e) { toast("error: " + e.message); }
}
async function loadProposals() {
  try {
    const r = await fetch("/api/proposals"); const d = await r.json();
    const items = d.proposals || [];
    $("proposals").innerHTML = items.length ? items.map(p => \`
      <div class="prop" id="prop-\${p.id}">
        <div class="cat">\${esc(p.category)}\${p.executable ? '<span class="badge exec">⚙ will create a branch</span>' : '<span class="badge record">records your decision</span>'}</div>
        <div class="title">\${esc(p.title)}</div>
        <div class="detail">\${esc(p.detail)}</div>
        \${p.evidence ? \`<div class="evidence">because: \${esc(p.evidence)}</div>\` : ""}
        <input type="text" id="act-\${p.id}" value="\${esc(p.action)}" />
        <input type="text" id="note-\${p.id}" placeholder="Add a note (optional)…" />
        <div class="acts">
          <button class="btn" onclick="decideProp('\${p.id}','approve')">Approve</button>
          <button class="btn ghost" onclick="decideProp('\${p.id}','reject')">Dismiss</button>
        </div>
      </div>\`).join("") : "<div class='prop empty'>No open proposals. Hit “Ask for proposals” and I’ll suggest a few.</div>";
  } catch (e) { /* leave as-is */ }
}
async function decideProp(id, decision) {
  try {
    const action = ($("act-"+id)||{}).value; const note = ($("note-"+id)||{}).value;
    const r = await fetch("/api/proposal/decide", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ id, decision, action, note }) });
    const j = await r.json(); if (!j.ok) throw new Error(j.error||"failed");
    const ex = j.proposal && j.proposal.execution;
    if (decision === "approve" && ex) {
      toast("approved ✓ — " + (ex.branch ? ("branched: " + ex.branch) : ex.message));
    } else {
      toast(decision === "approve" ? "approved ✓" : "dismissed");
    }
    await loadProposals();
  } catch (e) { toast("error: " + e.message); }
}
async function askProposals() {
  const b = $("askBtn"); b.disabled = true; b.textContent = "Thinking…";
  try {
    const r = await fetch("/api/propose", { method:"POST" }); const j = await r.json();
    if (!j.ok) throw new Error(j.error||"failed");
    toast(j.added ? ("added " + j.added + " proposal(s)") : "nothing new right now");
    await loadProposals();
  } catch (e) { toast("error: " + e.message); }
  finally { b.disabled = false; b.textContent = "Ask for proposals"; }
}
function confirmSuggestion(i) { const s = (window.__suggest || [])[i]; if (!s) return; emit(s.emit.type, s.emit.data); }
function emitBlock() { const reason = $("blockReason").value.trim(); if (!reason) return toast("enter a reason"); emit("system.blocked", { reason }); $("blockReason").value=""; }
function emitUnblock() { emit("system.unblocked", {}); }
function emitDeadline() { const d = $("deadline").value; if (!d) return toast("pick a date"); emit("system.task", { deadline: d }); }
function emitTask() { const t = $("task").value.trim(); if (!t) return toast("enter a task"); emit("system.task", { task: t }); $("task").value=""; }
function clearTask() { emit("system.task", { task: "" }); }
function clearDeadline() { emit("system.task", { deadline: "" }); }

// ── Listening: routes by transcribe.mode (webspeech | whisper-api | browser-wasm) ──
// Listens to YOU (your own dictation); status is always shown visibly.
let capture = { enabled: false, from: "09:00", to: "18:00" };
let cfgT = { mode: "webspeech", baseUrl: "", model: "", apiKeyEnv: "", language: null, wasmModel: "Xenova/whisper-base" };
let presets = {};
let cfgScreen = { window: {}, ocr: {}, vision: {} };
let recog = null, listening = false, userStopped = false;
let mediaRec = null, chunks = [];
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const useMediaRec = () => cfgT.mode === "whisper-api" || cfgT.mode === "browser-wasm";
const canListen = () => useMediaRec() ? !!(navigator.mediaDevices && window.MediaRecorder) : !!SR;
// ONE language control (cfgT.language: ""=auto | "th" | "en"), mapped per backend:
function wasmLang() { return cfgT.language === "th" ? "thai" : cfgT.language === "en" ? "english" : null; } // browser-wasm
function webspeechLang() { return cfgT.language === "en" ? "en-US" : "th-TH"; } // Web Speech has no true auto → default th

async function startMediaRec() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRec = new MediaRecorder(stream); chunks = [];
    mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRec.onstop = async () => {
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      const blob = new Blob(chunks, { type: "audio/webm" });
      $("listenInterim").textContent = "";
      if (blob.size < 1200) return; // too short to bother
      if (cfgT.mode === "browser-wasm") return handleWasmBlob(blob);
      try { // whisper-api: proxy through the local server (key stays server-side)
        const q = cfgT.language ? ("?language=" + encodeURIComponent(cfgT.language)) : "";
        const r = await fetch("/api/transcribe" + q, { method: "POST", headers: { "content-type": "audio/webm" }, body: blob });
        const j = await r.json();
        if (j.ok && j.text) heardVoice(j.text);
        else toast("transcribe: " + (j.error || "failed"));
      } catch { toast("transcribe error"); }
    };
    mediaRec.start(); listening = true; $("listenInterim").textContent = "● recording…"; setListenUI();
  } catch { toast("mic permission needed"); }
}
function stopMediaRec() { listening = false; try { if (mediaRec && mediaRec.state !== "inactive") mediaRec.stop(); } catch {} setListenUI(); }

// browser-wasm: transformers.js + model are served from our own /vendor + /models (localhost only),
// so the audio never leaves the machine. env.allowRemoteModels=false pins it to those local paths.
let wasmPipe = null;
async function ensureWasmPipe() {
  if (wasmPipe) return wasmPipe;
  const T = await import("/vendor/transformers.min.js"); // the self-contained web bundle (ort inlined)
  T.env.allowLocalModels = true;   // the web build defaults this off; we serve the model from /models
  T.env.allowRemoteModels = false; // never hit the network at transcription time
  T.env.localModelPath = "/models/";
  try { T.env.backends.onnx.wasm.wasmPaths = "/vendor/"; } catch {}
  // dtype "q8" must match WASM_DTYPE in models.ts — we only downloaded the "_quantized" onnx variant.
  wasmPipe = await T.pipeline("automatic-speech-recognition", cfgT.wasmModel || "Xenova/whisper-base", { dtype: "q8" });
  return wasmPipe;
}
async function handleWasmBlob(blob) {
  try {
    $("listenInterim").textContent = "transcribing…";
    const pipe = await ensureWasmPipe();
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const out = await pipe(decoded.getChannelData(0), { task: "transcribe", language: wasmLang() });
    $("listenInterim").textContent = "";
    const text = ((out && out.text) || "").trim();
    if (text) heardVoice(text);
  } catch (e) { $("listenInterim").textContent = ""; toast("wasm transcribe failed — download the model in settings first"); }
}

async function onLangChange() {
  cfgT.language = $("lang").value; // "" | "th" | "en"
  toast("language: " + (cfgT.language === "th" ? "ไทย" : cfgT.language === "en" ? "English" : "Auto"));
  // persist to config so it survives reload and applies to every backend
  try { await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcribe: { language: cfgT.language } }) }); } catch {}
  if (listening && recog) { try { recog.lang = webspeechLang(); recog.stop(); } catch {} } // onend restarts with new lang
}

// ── Settings (transcription backend) ─────────────────────────────────────────
function populateSettings() {
  $("modeSel").value = cfgT.mode || "webspeech";
  $("setBaseUrl").value = cfgT.baseUrl || "";
  $("setModel").value = cfgT.model || "";
  $("setKeyEnv").value = cfgT.apiKeyEnv || "";
  $("setWasmModel").value = cfgT.wasmModel || "";
  onModeChange();
}
function onModeChange() {
  const m = $("modeSel").value;
  $("apiFields").style.display = m === "whisper-api" ? "block" : "none";
  $("wasmFields").style.display = m === "browser-wasm" ? "block" : "none";
  if (m === "browser-wasm") refreshDlStatus();
}
function applyPreset(name) {
  const p = presets[name]; if (!p) return;
  $("modeSel").value = "whisper-api"; onModeChange();
  $("setBaseUrl").value = p.baseUrl; $("setModel").value = p.model;
  toast("preset: " + name + " — add your key to .env, then Save");
}
async function saveSettings() {
  const patch = {
    mode: $("modeSel").value,
    baseUrl: $("setBaseUrl").value.trim(),
    model: $("setModel").value.trim(),
    apiKeyEnv: $("setKeyEnv").value.trim() || "EXECUTIVE_TRANSCRIBE_KEY",
    wasmModel: $("setWasmModel").value.trim() || "Xenova/whisper-base",
    language: cfgT.language, // the single Language selector in the Listening card owns this
  };
  try {
    const r = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcribe: patch }) });
    const j = await r.json(); if (!j.ok) throw new Error(j.error || "failed");
    cfgT = j.transcribe; wasmPipe = null; // mode/model may have changed
    toast("settings saved ✓"); setListenUI();
  } catch (e) { toast("error: " + e.message); }
}
function populateScreenSettings() {
  $("scrWindowEnabled").checked = !!(cfgScreen.window && cfgScreen.window.enabled);
  $("scrOcrEnabled").checked = !!(cfgScreen.ocr && cfgScreen.ocr.enabled);
  $("scrVisionEnabled").checked = !!(cfgScreen.vision && cfgScreen.vision.enabled);
  $("scrVisionModel").value = (cfgScreen.vision && cfgScreen.vision.model) || "";
  $("scrVisionBaseUrl").value = (cfgScreen.vision && cfgScreen.vision.baseUrl) || "";
  $("scrVisionKeyEnv").value = (cfgScreen.vision && cfgScreen.vision.apiKeyEnv) || "";
  $("scrOcrEngine").value = (cfgScreen.ocr && cfgScreen.ocr.engine) || "winrt";
  $("scrOcrLanguages").value = (cfgScreen.ocr && cfgScreen.ocr.languages) || "";
  $("scrOcrTessPath").value = (cfgScreen.ocr && cfgScreen.ocr.tesseractPath) || "";
  toggleScreenVisionFields();
  toggleOcrEngineFields();
}
function toggleScreenVisionFields() {
  $("scrVisionFields").style.display = $("scrVisionEnabled").checked ? "block" : "none";
}
function toggleOcrEngineFields() {
  $("scrOcrTessFields").style.display = $("scrOcrEngine").value === "tesseract" ? "block" : "none";
}
async function saveScreenSettings() {
  const patch = {
    window: { enabled: $("scrWindowEnabled").checked },
    ocr: {
      enabled: $("scrOcrEnabled").checked,
      engine: $("scrOcrEngine").value,
      languages: $("scrOcrLanguages").value.trim() || undefined,
      // blank means "auto-detect" — send null, not "", so the server stores the sentinel.
      tesseractPath: $("scrOcrTessPath").value.trim() || null,
    },
    vision: {
      enabled: $("scrVisionEnabled").checked,
      model: $("scrVisionModel").value.trim() || undefined,
      baseUrl: $("scrVisionBaseUrl").value.trim() || undefined,
      apiKeyEnv: $("scrVisionKeyEnv").value.trim() || undefined,
    },
  };
  try {
    const r = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ screen: patch }) });
    const j = await r.json(); if (!j.ok) throw new Error(j.error || "failed");
    cfgScreen = j.screen || cfgScreen;
    toast("screen settings saved ✓");
  } catch (e) { toast("error: " + e.message); }
}
async function refreshDlStatus() {
  try {
    const s = await (await fetch("/api/transcribe/status")).json();
    $("dlStatus").textContent = (s.libReady && s.modelReady) ? "ready ✓ (offline)" : (s.libReady || s.modelReady) ? "partly downloaded" : "not downloaded yet";
  } catch {}
}
async function downloadModel() {
  const b = $("dlBtn"); b.disabled = true; b.textContent = "Downloading… (can take a few min)";
  $("dlStatus").textContent = "";
  try {
    const model = $("setWasmModel").value.trim() || undefined;
    const r = await fetch("/api/transcribe/download", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) });
    const j = await r.json();
    if (!j.started && !j.running) { toast("download failed: " + (j.error || "failed")); return; }
    for (let i = 0; i < 300; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      const s = await (await fetch("/api/transcribe/status")).json();
      if (!s.download.running) {
        if (s.download.error) { toast("download failed: " + s.download.error); }
        else if (s.download.result?.ok) { toast("downloaded " + s.download.result.files + " file(s), " + Math.round(s.download.result.bytes / 1e6) + " MB"); }
        else { toast("download failed: " + (s.download.result?.error || "unknown")); }
        return;
      }
    }
    toast("download still running — check back later");
  } catch (e) { toast("download failed: " + e.message); }
  finally { b.disabled = false; b.textContent = "Download model for offline use"; refreshDlStatus(); }
}

function hhmmNow() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function toMin(s) { const m = /^(\\d{1,2}):(\\d{2})/.exec(s || ""); return m ? (+m[1]) * 60 + (+m[2]) : null; }
function withinHours() { const a = toMin(capture.from), b = toMin(capture.to), n = hhmmNow(); return a != null && b != null && n >= a && n < b; }

function setListenUI() {
  const on = listening;
  $("micBtn").textContent = on ? "Stop listening" : "Start listening";
  $("listenStatus").innerHTML = on
    ? '<span style="color:var(--danger);font-weight:700">🔴 Listening…</span> speak a quick note and I\\'ll capture it.'
    : 'Off. This listens to <b>you</b> (your dictated notes) — nothing is recorded without this being visibly on.';
  const sched = capture.enabled ? ("Auto-on during work hours " + capture.from + "–" + capture.to + (withinHours() ? " (now)" : "")) : "Auto-schedule off (manual only).";
  $("listenSchedule").textContent = canListen() ? sched : "Voice capture needs Chrome or Edge; you can still type notes below.";
}

function startListen() {
  if (listening) return;
  userStopped = false;
  if (useMediaRec()) { startMediaRec(); return; }
  if (!SR) return;
  try {
    recog = new SR();
    recog.continuous = true; recog.interimResults = true; recog.lang = webspeechLang();
    recog.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) heardVoice(text);
        } else interim += r[0].transcript;
      }
      $("listenInterim").textContent = interim;
    };
    recog.onend = () => { $("listenInterim").textContent = ""; if (listening && !userStopped) { try { recog.start(); } catch {} } };
    recog.onerror = (e) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { listening = false; setListenUI(); toast("mic permission needed"); } };
    recog.start();
    listening = true; setListenUI();
  } catch (e) { toast("could not start listening"); }
}
function stopListen(manual) { if (manual) userStopped = true; if (useMediaRec()) { stopMediaRec(); return; } listening = false; try { recog && recog.stop(); } catch {} setListenUI(); }
function toggleListen() { listening ? stopListen(true) : startListen(); }

async function loadCaptureConfig() {
  try {
    const r = await fetch("/api/config"); const j = await r.json();
    if (j.capture) capture = j.capture;
    if (j.transcribe) cfgT = j.transcribe;
    if (j.presets) presets = j.presets;
    if (j.screen) cfgScreen = j.screen;
    if (j.agent) {
      agentOn = !!j.agent.enabled;
      $("chatCard").style.display = agentOn ? "" : "none";
      $("chatSpeak").checked = !!j.agent.speak;
      if (agentOn) loadChat();
    }
    if (j.autonomy) populateAutonomy(j.autonomy);
  } catch {}
  const sel = $("lang"); if (sel) sel.value = cfgT.language || "";
  populateSettings();
  populateScreenSettings();
  setListenUI();
}

// ── Autonomy toggles ────────────────────────────────────────────────────────
// autopilotApply is REPORTED but never sent back: arming repo-writing autonomy
// stays a deliberate config.json edit (see updateAutonomyConfig in src/config.ts).
function populateAutonomy(a) {
  $("autoAgent").checked = !!a.agentEnabled;
  agentOn = !!a.agentEnabled;
  $("chatCard").style.display = agentOn ? "" : "none";
  $("autoAdvisor").checked = !!a.advisorEnabled;
  $("autoInfer").checked = !!a.inferEnabled;
  $("autoAutopilot").checked = !!a.autopilotEnabled;
  $("autoDeadlineDecay").checked = !!a.deadlineDecayEnabled;
  const note = $("applyState");
  if (a.autopilotApply) {
    note.innerHTML = a.autopilotEnabled
      ? "⚠️ <b>autopilot.apply is ON</b> — approved changes will be committed to an isolated <code>executive/change-*</code> branch (never merged). Edit <code>config.json</code> to disarm."
      : "<code>autopilot.apply</code> is ON in config.json — turning Autopilot on above will let it commit to an isolated branch.";
  } else {
    note.textContent = "autopilot.apply is off — Autopilot will dry-run only and write nothing to your repo.";
  }
}

async function saveAutonomy() {
  const patch = {
    agentEnabled: $("autoAgent").checked,
    advisorEnabled: $("autoAdvisor").checked,
    inferEnabled: $("autoInfer").checked,
    autopilotEnabled: $("autoAutopilot").checked,
    deadlineDecayEnabled: $("autoDeadlineDecay").checked,
  };
  try {
    const r = await fetch("/api/autonomy", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
    const j = await r.json();
    if (j.autonomy) populateAutonomy(j.autonomy);
  } catch {}
}
// Schedule tick: auto-start within work hours (once enabled + mic granted), auto-stop outside.
setInterval(() => {
  if (!canListen() || !capture.enabled) return;
  if (withinHours() && !listening && !userStopped) startListen();
  else if (!withinHours() && listening) { listening = false; try { recog && recog.stop(); } catch {} setListenUI(); }
}, 20000);

// Hold-to-talk: press & hold Space to dictate (walkie-talkie), release to stop.
// Ignored while typing in a field so it never hijacks the inputs.
function isTyping(el) { const t = ((el && el.tagName) || "").toLowerCase(); return t === "input" || t === "textarea" || t === "select"; }
let spaceHeld = false;
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !spaceHeld && !isTyping(e.target)) {
    e.preventDefault(); spaceHeld = true; if (canListen() && !listening) startListen();
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && spaceHeld) { e.preventDefault(); spaceHeld = false; if (listening) stopListen(true); }
});

// ── Chat with the agent (Phase 35) ──────────────────────────────────────────
// Dictation goes here when the agent is on: talking to it IS the point. With the
// agent off it falls back to the old behaviour (a plain note for the Advisor).
let agentOn = false;
let chatBusy = false;

function heardVoice(text) {
  if (agentOn) sendChat(text, "voice");
  else emit("system.note", { msg: text, via: "voice" });
}

// Inline markdown on ALREADY-ESCAPED text: **bold**, *italic*, \`code\`, [label](url).
// Escaping happens first, so this can never inject markup the model didn't intend.
// NOTE: this whole file is one template literal, so every regex backslash is DOUBLED
// in source (\\s, \\n, \\*, …) to survive emission — see GOTCHA.md. Backticks are \`.
function mdInline(s) {
  return s
    .replace(/\`([^\`]+)\`/g, '<code style="background:var(--line);padding:1px 5px;border-radius:4px;font-size:12px">$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>')
    .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// Minimal block markdown → HTML for assistant replies: headings, \`\`\`fences\`\`\`,
// - / 1. lists, and paragraphs. Deliberately small; not a full CommonMark parser.
function renderMd(src) {
  const lines = String(src ?? "").split("\\n");
  let html = "", i = 0, list = null;
  const closeList = () => { if (list) { html += "</" + list + ">"; list = null; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\`\`\`/.test(line)) {                       // code fence
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^\`\`\`\\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      html += '<pre style="background:var(--line);border-radius:8px;padding:8px 10px;overflow-x:auto;margin:6px 0;font-size:12px;white-space:pre">' + esc(buf.join("\\n")) + '</pre>';
      continue;
    }
    const h = line.match(/^(#{1,3})\\s+(.*)$/);        // heading
    if (h) {
      closeList();
      const sz = h[1].length === 1 ? "15px" : h[1].length === 2 ? "14px" : "13px";
      html += '<div style="font-weight:700;margin:7px 0 2px;font-size:' + sz + '">' + mdInline(esc(h[2])) + '</div>';
      i++; continue;
    }
    const li = line.match(/^\\s*([-*]|\\d+\\.)\\s+(.*)$/); // list item
    if (li) {
      const tag = /\\d/.test(li[1]) ? "ol" : "ul";
      if (list !== tag) { closeList(); html += '<' + tag + ' style="margin:4px 0;padding-left:20px">'; list = tag; }
      html += '<li>' + mdInline(esc(li[2])) + '</li>';
      i++; continue;
    }
    if (line.trim() === "") { closeList(); i++; continue; } // blank
    closeList();                                            // paragraph line
    html += '<div>' + mdInline(esc(line)) + '</div>';
    i++;
  }
  closeList();
  return html;
}

function bubble(role, text, extra) {
  const mine = role === "user";
  const bg = mine ? "var(--accent)" : "var(--card)";
  const fg = mine ? "#fff" : "inherit";
  // The owner asked for rendered markdown; user messages stay literal (pre-wrap).
  const body = mine
    ? '<span style="white-space:pre-wrap">' + esc(text) + '</span>'
    : renderMd(text);
  return '<div style="align-self:' + (mine ? "flex-end" : "flex-start") + ';max-width:86%;background:' + bg +
    ';color:' + fg + ';border:1px solid var(--line);border-radius:10px;padding:7px 11px;line-height:1.5">' +
    body + (extra || "") + '</div>';
}

function toolTrace(calls) {
  if (!calls || !calls.length) return "";
  const line = calls.map(c => "🔧 " + c.name + (c.ok ? "" : " ✗")).join("  ");
  return '<div class="muted mono" style="font-size:11px;margin-top:5px">' + esc(line) + '</div>';
}

function renderChat(messages, pending) {
  const log = $("chatLog");
  // Only auto-scroll if the owner is already at the bottom — otherwise the 5s
  // refresh yanks them down while they're reading older messages.
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  let html = "";
  let calls = [];
  for (const m of messages) {
    if (m.role === "tool") { calls.push({ name: m.toolName, ok: m.toolOk !== false }); continue; }
    if (m.role === "assistant") { html += bubble("assistant", m.text, toolTrace(calls)); calls = []; }
    else html += bubble("user", m.text + (m.via === "voice" ? " 🎤" : ""));
  }
  log.innerHTML = html || '<span class="muted">ยังไม่ได้คุยกันเลย</span>';
  if (atBottom) log.scrollTop = log.scrollHeight;

  // The confirm chip. One tap runs it; "ไว้ใจ" means never being asked about this
  // tool again (it removes the prompt, not the guardrails behind it).
  const box = $("chatPending");
  if (pending) {
    // run_command / edit_files are never blanket-trustable (Phase 38) — hide "ไว้ใจตลอด" for them.
    const trustBtn = (pending.trustable === false) ? '' :
      '<button class="ghost" onclick="confirmChat(\\'' + pending.id + '\\',\\'trust\\')">ไว้ใจ ' + esc(pending.toolName) + ' ตลอด</button>';
    box.innerHTML = '<div class="prop" style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:10px">' +
      '<div><b>ขออนุญาตทำ:</b> ' + esc(pending.preview) + '</div>' +
      '<div class="acts" style="margin-top:8px">' +
      '<button class="btn" onclick="confirmChat(\\'' + pending.id + '\\',\\'run\\')">ทำเลย</button>' +
      trustBtn +
      '<button class="ghost" onclick="confirmChat(\\'' + pending.id + '\\',\\'no\\')">ไม่</button>' +
      '</div></div>';
  } else box.innerHTML = "";
}

function speak(text) {
  if (!$("chatSpeak") || !$("chatSpeak").checked || !window.speechSynthesis) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = (cfgT.language === "en") ? "en-US" : "th-TH";
    window.speechSynthesis.speak(u);
  } catch {}
}

async function loadChat() {
  if (!agentOn) return;
  try {
    const r = await fetch("/api/chat/history?n=60");
    if (!r.ok) return;
    const j = await r.json();
    renderChat(j.messages || [], j.pending);
  } catch {}
}

async function sendChat(preset, via) {
  const input = $("chatInput");
  const message = (preset !== undefined ? preset : input.value).trim();
  if (!message || chatBusy) return;
  if (preset === undefined) input.value = "";
  chatBusy = true;
  $("chatBusy").textContent = "กำลังคิด… (อาจนานถึง 2 นาที)";
  $("chatSend").disabled = true;
  try {
    const r = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, via: via || "text" }),
    });
    const j = await r.json();
    if (!j.ok) toast(j.error || "คุยไม่สำเร็จ");
    else if (j.reply) speak(j.reply);
  } catch (e) { toast("คุยไม่สำเร็จ"); }
  chatBusy = false;
  $("chatBusy").textContent = "";
  $("chatSend").disabled = false;
  await loadChat();
}

async function confirmChat(pendingId, decision) {
  if (chatBusy) return;
  chatBusy = true;
  $("chatBusy").textContent = decision === "no" ? "กำลังยกเลิก…" : "กำลังทำ…";
  try {
    const r = await fetch("/api/chat/confirm", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pendingId, decision }),
    });
    const j = await r.json();
    if (!j.ok) toast(j.error || "ทำไม่สำเร็จ");
    else if (j.reply) speak(j.reply);
    if (decision === "trust") loadCaptureConfig();
  } catch { toast("ทำไม่สำเร็จ"); }
  chatBusy = false;
  $("chatBusy").textContent = "";
  await loadChat();
}

async function clearChat() {
  try { await fetch("/api/chat/clear", { method: "POST" }); } catch {}
  await loadChat();
}

async function saveSpeak() {
  try {
    await fetch("/api/autonomy", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentSpeak: $("chatSpeak").checked }),
    });
  } catch {}
}

loadCaptureConfig();
refresh();
loadProposals();
setInterval(loadChat, 5000);
setInterval(refresh, 5000);
setInterval(loadProposals, 5000);
</script>
</body>
</html>`;
}
