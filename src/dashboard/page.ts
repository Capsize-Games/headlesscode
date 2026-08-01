/**
 * Cost/token dashboard — the single static HTML page served at `GET /`.
 *
 * A plain template string (no build step, no framework) with a small
 * vanilla-JS poll loop hitting `/api/summary` every few seconds. Read-only:
 * no answer-from-dashboard affordance for blocked groups (explicitly out of
 * scope for this pass — see the plan doc).
 */

export function renderPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>headlesscode dashboard</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    margin: 0; padding: 24px; max-width: 1100px; margin-inline: auto;
    background: Canvas; color: CanvasText;
  }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  .sub { color: GrayText; font-size: 0.85rem; margin-bottom: 24px; }
  h2 { font-size: 1.05rem; margin-top: 32px; margin-bottom: 8px; }
  .stats { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
  .stat {
    border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
    border-radius: 8px; padding: 10px 16px; min-width: 120px;
  }
  .stat .label { font-size: 0.75rem; color: GrayText; text-transform: uppercase; letter-spacing: 0.04em; }
  .stat .value { font-size: 1.3rem; font-weight: 600; margin-top: 2px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
  th { color: GrayText; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; }
  tr:hover td { background: color-mix(in srgb, CanvasText 5%, transparent); }
  .status-success { color: #1a7f37; }
  .status-error { color: #c0392b; }
  .status-budget { color: #b8860b; }
  .status-blocked { color: #b8860b; }
  /* A running (live) session gets a pill badge so it stands out from completed ones. */
  .status-running {
    color: #b8860b;
    display: inline-block;
    padding: 1px 8px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, #b8860b 50%, transparent);
    background: color-mix(in srgb, #b8860b 10%, transparent);
  }
  .status-done { color: #1a7f37; }
  .status-failed { color: #c0392b; }
  .empty { color: GrayText; font-style: italic; padding: 12px 0; }
  .blocked-card {
    border: 1px solid color-mix(in srgb, #b8860b 50%, transparent);
    border-radius: 8px; padding: 12px 16px; margin-bottom: 10px;
    background: color-mix(in srgb, #b8860b 8%, transparent);
  }
  .blocked-card .name { font-weight: 600; }
  .blocked-card .question { margin-top: 4px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }
  #error { color: #c0392b; margin-top: 12px; display: none; }
</style>
</head>
<body>
  <h1>headlesscode dashboard</h1>
  <div class="sub">Local, read-only cost/token monitor. Auto-refreshes every 4s. <span id="generatedAt"></span></div>

  <div class="stats" id="totals"></div>

  <h2>Blocked (awaiting a decision)</h2>
  <div id="blocked"><div class="empty">none</div></div>

  <h2>Round (orchestrator groups)</h2>
  <div id="round"><div class="empty">no .orchestrator-state.json found for --repo</div></div>

  <h2>Sessions</h2>
  <div id="sessions"><div class="empty">no sessions found</div></div>

  <div id="error"></div>

<script>
function fmtCost(n) { return "$" + (n ?? 0).toFixed(6); }
function fmtInt(n) { return (n ?? 0).toLocaleString(); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderTotals(totals) {
  const el = document.getElementById("totals");
  el.innerHTML = [
    ["Sessions", fmtInt(totals.sessionCount)],
    ["Total cost", fmtCost(totals.costUsd)],
    ["Input tokens", fmtInt(totals.inputTokens)],
    ["Output tokens", fmtInt(totals.outputTokens)],
    ["Iterations", fmtInt(totals.iterations)],
  ].map(([label, value]) => \`<div class="stat"><div class="label">\${esc(label)}</div><div class="value">\${esc(value)}</div></div>\`).join("");
}

function renderBlocked(blocked) {
  const el = document.getElementById("blocked");
  if (!blocked || blocked.length === 0) {
    el.innerHTML = '<div class="empty">none</div>';
    return;
  }
  el.innerHTML = blocked.map((b) => \`
    <div class="blocked-card">
      <div class="name">\${esc(b.name)}</div>
      <div class="question">\${esc(b.question)}</div>
      \${b.suggestions && b.suggestions.length ? '<div class="mono">suggestions: ' + esc(b.suggestions.join(" | ")) + '</div>' : ""}
      \${b.askedAt ? '<div class="mono">asked: ' + esc(b.askedAt) + '</div>' : ""}
    </div>
  \`).join("");
}

function renderRound(round) {
  const el = document.getElementById("round");
  if (!round) {
    el.innerHTML = '<div class="empty">no .orchestrator-state.json found for --repo</div>';
    return;
  }
  const rows = (round.groups || []).map((g) => \`
    <tr>
      <td>\${esc(g.name)}</td>
      <td class="status-\${esc(g.status)}">\${esc(g.status)}</td>
      <td>\${g.usage ? fmtCost(g.usage.costUsd) : "—"}</td>
      <td>\${g.usage ? fmtInt(g.usage.inputTokens) : "—"}</td>
      <td>\${g.usage ? fmtInt(g.usage.outputTokens) : "—"}</td>
      <td>\${g.usage ? fmtInt(g.usage.iterations) : "—"}</td>
    </tr>
  \`).join("");
  el.innerHTML = \`
    <div class="sub">batch: \${esc(round.batch ?? "—")} · updated: \${esc(round.updated ?? "—")}
      · round total: \${round.totalUsage ? fmtCost(round.totalUsage.costUsd) : "$0.000000"}</div>
    <table>
      <thead><tr><th>group</th><th>status</th><th>cost</th><th>in tok</th><th>out tok</th><th>iter</th></tr></thead>
      <tbody>\${rows || '<tr><td colspan="6" class="empty">no groups</td></tr>'}</tbody>
    </table>
  \`;
}

function renderSessions(sessions) {
  const el = document.getElementById("sessions");
  if (!sessions || sessions.length === 0) {
    el.innerHTML = '<div class="empty">no sessions found</div>';
    return;
  }
  const rows = sessions.map((s) => \`
    <tr>
      <td class="mono">\${esc(s.sessionId.slice(0, 8))}</td>
      <td>\${esc(s.mode)}</td>
      <td>\${esc(s.model)}</td>
      <td class="status-\${esc(s.status)}">\${esc(s.status)}</td>
      <td>\${fmtCost(s.costUsd)}</td>
      <td>\${fmtInt(s.inputTokens)}</td>
      <td>\${fmtInt(s.outputTokens)}</td>
      <td>\${fmtInt(s.iterations)}</td>
      <td class="mono">\${esc(s.startedAt)}</td>
      <td class="mono">\${esc(s.endedAt) || "—"}</td>
      <td class="mono">\${esc(s.source)}</td>
    </tr>
  \`).join("");
  el.innerHTML = \`
    <table>
      <thead><tr><th>id</th><th>mode</th><th>model</th><th>status</th><th>cost</th><th>in tok</th><th>out tok</th><th>iter</th><th>started</th><th>ended</th><th>source</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  \`;
}

async function poll() {
  try {
    const res = await fetch("/api/summary");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const summary = await res.json();
    document.getElementById("error").style.display = "none";
    document.getElementById("generatedAt").textContent = "· last updated " + new Date(summary.generatedAt).toLocaleTimeString();
    renderTotals(summary.totals);
    renderBlocked(summary.round ? summary.round.blocked : []);
    renderRound(summary.round);
    renderSessions(summary.sessions);
  } catch (err) {
    const el = document.getElementById("error");
    el.style.display = "block";
    el.textContent = "Failed to fetch /api/summary: " + err;
  }
}

poll();
setInterval(poll, 4000);
</script>
</body>
</html>
`
}
