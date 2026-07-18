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
  button { background:var(--accent); color:#04121f; border:0; border-radius:8px; padding:8px 14px; font:inherit; font-weight:650; cursor:pointer; }
  button.ghost { background:transparent; color:var(--fg); border:1px solid var(--line); }
  button.danger { background:var(--danger); color:#fff; }
  button:active { transform:translateY(1px); }
  .muted { color:var(--muted); } .mono { font-family:ui-monospace, Menlo, Consolas, monospace; }
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
  </div>
  <div style="margin-left:auto"><button class="ghost" onclick="refresh()">↻ Refresh</button></div>
</header>

<main>
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

function rows(pairs) {
  return pairs.map(([k,v]) => \`<div class="row"><span class="k">\${k}</span><span class="v">\${v}</span></div>\`).join("");
}

async function refresh() {
  try {
    const r = await fetch("/api/state"); const d = await r.json();
    const dg = d.digest; $("summary").textContent = d.summary || "";
    const n = dg.now;
    $("now").innerHTML = n.available ? rows([
      ["Project", dash(n.project)], ["Task", dash(n.task)],
      ["Tests", n.tests ? \`<span class="pill \${n.tests==='failing'?'ask':'act'}">\${esc(n.tests)}</span>\` : dash(null)],
      ["Blocked", n.blocked ? \`<span class="pill ask">yes</span> \${esc(n.blockedReason||"")}\` : "no"],
      ["Branch", dash(n.branch)], ["Deadline", dash(n.deadline)],
      ["Current file", dash(n.currentFile)], ["Idle", n.idle===true?"yes":n.idle===false?"no":dash(null)],
    ]) : "<span class='muted'>No state yet.</span>";

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
function confirmSuggestion(i) { const s = (window.__suggest || [])[i]; if (!s) return; emit(s.emit.type, s.emit.data); }
function emitBlock() { const reason = $("blockReason").value.trim(); if (!reason) return toast("enter a reason"); emit("system.blocked", { reason }); $("blockReason").value=""; }
function emitUnblock() { emit("system.unblocked", {}); }
function emitDeadline() { const d = $("deadline").value; if (!d) return toast("pick a date"); emit("system.task", { deadline: d }); }
function emitTask() { const t = $("task").value.trim(); if (!t) return toast("enter a task"); emit("system.task", { task: t }); $("task").value=""; }

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
