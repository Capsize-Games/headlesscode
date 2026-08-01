/**
 * Cost/token dashboard — the single static HTML page served at `GET /`.
 *
 * A plain template string (no build step, no framework) with a small
 * vanilla-JS poll loop hitting `/api/summary` every few seconds, plus a
 * live per-session event feed (Phase 1) and pause/resume control (Phase 3).
 *
 * Session detail: clicking a session row opens a detail panel that polls
 * `/api/session/:id/events?since=<offset>` every ~1.5s (faster than the
 * summary poll — this is meant to feel live), appending new events to the
 * DOM rather than re-rendering the whole feed, and auto-scrolling to the
 * latest event unless the user has manually scrolled up. The panel also
 * carries pause/resume buttons (POST /api/session/:id/pause|resume).
 *
 * NOTE (Phase 3 scope change): this page is no longer purely read-only — the
 * pause/resume buttons issue state-changing POSTs. Local-only + no-auth,
 * matching the server; see src/dashboard/server.ts's header note.
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
  .status-paused {
    color: #1a7f37;
    display: inline-block;
    padding: 1px 8px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, #1a7f37 50%, transparent);
    background: color-mix(in srgb, #1a7f37 10%, transparent);
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

  /* Session detail panel (Phase 1 live event feed). */
  #detail { display: none; margin-top: 20px; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 8px; }
  #detail .detail-head {
    display: flex; align-items: center; gap: 12px; padding: 10px 16px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
  }
  #detail .detail-head .session-id { font-weight: 600; }
  #detail .detail-head .close { margin-left: auto; cursor: pointer; border: none; background: none; font-size: 1.1rem; color: GrayText; }
  #detail .detail-head .state-pill { font-size: 0.75rem; padding: 1px 8px; border-radius: 10px; border: 1px solid currentColor; }
  #detail .detail-head .state-pill.running { color: #b8860b; }
  #detail .detail-head .state-pill.paused { color: #1a7f37; }
  #detail .detail-head .state-pill.done { color: GrayText; }
  #detail .detail-controls { display: flex; gap: 8px; }
  #detail .detail-controls button {
    font-size: 0.8rem; padding: 3px 12px; border-radius: 6px; cursor: pointer;
    border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); background: color-mix(in srgb, CanvasText 8%, transparent);
  }
  #detail .detail-controls button:disabled { opacity: 0.45; cursor: not-allowed; }
  #detail .detail-controls button.pause { color: #b8860b; }
  #detail .detail-controls button.resume { color: #1a7f37; }
  #feed {
    max-height: 420px; overflow-y: auto; padding: 8px 16px; font-size: 0.8rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .ev { display: flex; gap: 10px; padding: 3px 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 6%, transparent); }
  .ev .ev-ts { color: GrayText; flex-shrink: 0; }
  .ev .ev-body { word-break: break-word; }
  .ev .ev-label { font-weight: 600; }
  .ev.tool_call .ev-label { color: #8250df; }
  .ev.tool_result .ev-label { color: #1a7f37; }
  .ev.tool_result.is-error .ev-label { color: #c0392b; }
  .ev.checkpoint_saved .ev-label { color: #b8860b; }
  .ev.decision_blocked .ev-label { color: #c0392b; }
  .ev.decision_answered .ev-label { color: #1a7f37; }
  .ev.paused .ev-label { color: #b8860b; }
  .ev.resumed .ev-label { color: #1a7f37; }
  .ev.session_start .ev-label { color: #1a7f37; }
  .ev.session_end .ev-label { color: GrayText; }
  .ev-iter { color: GrayText; }
  .ev .trunc-note { color: GrayText; font-style: italic; }
  .feed-empty { color: GrayText; font-style: italic; padding: 12px 0; }
</style>
</head>
<body>
  <h1>headlesscode dashboard</h1>
  <div class="sub">Local monitor + control. Summary auto-refreshes every 4s. <span id="generatedAt"></span></div>

  <div class="stats" id="totals"></div>

  <h2>Blocked (awaiting a decision)</h2>
  <div id="blocked"><div class="empty">none</div></div>

  <h2>Round (orchestrator groups)</h2>
  <div id="round"><div class="empty">no .orchestrator-state.json found for --repo</div></div>

  <h2>Sessions</h2>
  <div id="sessions"><div class="empty">no sessions found</div></div>

  <div id="detail">
    <div class="detail-head">
      <span class="session-id mono" id="detailSessionId"></span>
      <span class="state-pill" id="detailState"></span>
      <span class="mono" id="detailSource"></span>
      <span class="detail-controls">
        <button class="pause" id="btnPause">⏸ Pause</button>
        <button class="resume" id="btnResume">▶ Resume</button>
      </span>
      <button class="close" id="detailClose" title="close">✕</button>
    </div>
    <div id="feed"><div class="feed-empty">select a session to watch its live event feed</div></div>
  </div>

  <div id="error"></div>

<script>
function fmtCost(n) { return "$" + (n ?? 0).toFixed(6); }
function fmtInt(n) { return (n ?? 0).toLocaleString(); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtPct(n) { return (n ?? 0).toFixed(1) + "%"; }

// ── Live event feed (Phase 1) ────────────────────────────────────────────────
// One small map from event type to a short label + icon, so the feed reads
// at a glance (tool call -> "🔧 tool: args", checkpoint -> "📸 checkpoint").
const EVENT_LABELS = {
  session_start: "🚀 session start",
  iteration_start: "🔄 iteration",
  llm_response: "🤖 llm response",
  llm_error: "💥 llm error",
  tool_call: "🔧 tool call",
  tool_result: "✅ tool result",
  checkpoint_saved: "📸 checkpoint",
  decision_blocked: "⛔ blocked (question)",
  decision_answered: "💬 question answered",
  paused: "⏸ paused",
  resumed: "▶ resumed",
  session_end: "🏁 session end",
};

// Current detail view state: null when closed.
let detail = null; // { sessionId, source, nextOffset, lastEventCount, userScrolledUp }

function openDetail(sessionId, source, status) {
  closeDetail();
  detail = { sessionId, source, nextOffset: 0, lastEventCount: 0, userScrolledUp: false, status };
  document.getElementById("detail").style.display = "block";
  document.getElementById("detailSessionId").textContent = sessionId;
  document.getElementById("detailSource").textContent = "· " + (source || "");
  updateDetailControls();
  const feed = document.getElementById("feed");
  feed.innerHTML = '<div class="feed-empty">loading events…</div>';
  // Reset scroll-tracking state for the new session.
  detail.userScrolledUp = false;
  feed.scrollTop = 0;
  pollEvents();
}

function closeDetail() {
  if (detail) {
    detail = null;
  }
  document.getElementById("detail").style.display = "none";
}

function updateDetailControls() {
  const paused = detail && (detail.status === "paused" || detail.paused);
  const running = detail && (detail.status === "running" || detail.running);
  const done = detail && (detail.status === "done" || detail.status === "success" || detail.status === "error" || detail.status === "failed" || detail.status === "budget");
  const btnPause = document.getElementById("btnPause");
  const btnResume = document.getElementById("btnResume");
  btnPause.disabled = !running || !!paused;
  btnResume.disabled = !paused;
  const pill = document.getElementById("detailState");
  if (paused) {
    pill.textContent = "paused";
    pill.className = "state-pill paused";
  } else if (running) {
    pill.textContent = "running";
    pill.className = "state-pill running";
  } else if (done) {
    pill.textContent = "done";
    pill.className = "state-pill done";
  } else {
    pill.textContent = detail ? detail.status || "unknown" : "";
    pill.className = "state-pill done";
  }
}

function renderEvent(e) {
  const label = EVENT_LABELS[e.type] || e.type;
  const iter = typeof e.iteration === "number" ? '<span class="ev-iter">[' + esc(e.iteration) + "]</span> " : "";
  let body = "";
  switch (e.type) {
    case "tool_call":
      body = esc(e.tool) + (e.args ? ": " + esc(e.args) : "") + (e.argsTruncated ? ' <span class="trunc-note">(truncated)</span>' : "");
      break;
    case "tool_result":
      body = esc(e.tool) + (e.isError ? " (error)" : "") + ": " + esc(String(e.result || "").slice(0, 400)) + (e.resultTruncated ? ' <span class="trunc-note">(truncated)</span>' : "");
      break;
    case "llm_response":
      body = (e.hadToolCalls ? "tool_calls " : "text ") +
        (e.textPreview ? "· " + esc(String(e.textPreview).slice(0, 300)) + (e.textTruncated ? ' <span class="trunc-note">(truncated)</span>' : "") : "") +
        (typeof e.inputTokens === "number" ? " · in=" + esc(e.inputTokens) + " out=" + esc(e.outputTokens ?? 0) + " cached=" + esc(e.cachedTokens ?? 0) : "");
      break;
    case "checkpoint_saved":
      body = e.iteration === 0 ? "baseline" : "after iteration " + esc(e.iteration);
      break;
    case "decision_blocked":
      body = esc(e.question || "") + (e.suggestions && e.suggestions.length ? " · suggestions: " + esc(e.suggestions.join(" | ")) : "");
      break;
    case "decision_answered":
      body = e.timedOut ? "timed out — worker moved on autonomously" : "answer: " + esc(e.answer || "");
      break;
    case "paused":
    case "resumed":
      body = e.reason ? esc(e.reason) : "";
      break;
    case "session_start":
      body = esc(e.mode || "") + " · " + esc(e.model || "") + (e.workspaceRoot ? " · " + esc(e.workspaceRoot) : "");
      break;
    case "session_end":
      body = "status=" + esc(e.status) + " · iterations=" + esc(e.iterations) + " · cost=" + fmtCost(e.costUsd) +
        " · in=" + esc(e.inputTokens) + " out=" + esc(e.outputTokens);
      break;
    default:
      body = esc(JSON.stringify(e).slice(0, 400));
  }
  const div = document.createElement("div");
  div.className = "ev " + esc(e.type) + (e.isError ? " is-error" : "");
  div.innerHTML = '<span class="ev-ts">' + esc(e.ts) + "</span><span class=\"ev-body\">" + iter + '<span class="ev-label">' + esc(label) + "</span> " + body + "</span>";
  return div;
}

function feedAutoScrolls() {
  const feed = document.getElementById("feed");
  // Auto-scroll only when the user is already at the bottom (within ~40px) —
  // never yank the view back down while they're reading history above.
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
}

async function pollEvents() {
  if (!detail) return;
  try {
    const params = new URLSearchParams();
    if (detail.nextOffset > 0) params.set("since", String(detail.nextOffset));
    const res = await fetch("/api/session/" + encodeURIComponent(detail.sessionId) + "/events?" + params.toString());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const feed = document.getElementById("feed");
    if (detail.lastEventCount === 0 && (!data.events || data.events.length === 0)) {
      feed.innerHTML = '<div class="feed-empty">no events yet — waiting for the worker…</div>';
    } else {
      const shouldScroll = feedAutoScrolls();
      if (feed.querySelector(".feed-empty")) feed.innerHTML = "";
      for (const e of data.events || []) {
        feed.appendChild(renderEvent(e));
      }
      detail.lastEventCount = (detail.lastEventCount || 0) + (data.events || []).length;
      if (shouldScroll) feed.scrollTop = feed.scrollHeight;
    }
    detail.nextOffset = data.nextOffset;
    // Derive running/paused state from the feed (the summary row may lag).
    const types = (data.events || []).map((e) => e.type);
    if (types.includes("paused")) detail.paused = true;
    if (types.includes("resumed")) detail.paused = false;
    if (types.includes("session_end")) { detail.status = "done"; detail.paused = false; }
    updateDetailControls();
  } catch (err) {
    const feed = document.getElementById("feed");
    if (feed) {
      const empty = feed.querySelector(".feed-empty");
      if (empty) empty.textContent = "failed to load events: " + err;
    }
  }
}

async function controlSession(action) {
  if (!detail) return;
  const res = await fetch("/api/session/" + encodeURIComponent(detail.sessionId) + "/" + action, { method: "POST" });
  if (!res.ok) {
    alert("Failed to " + action + ": HTTP " + res.status);
    return;
  }
  // Optimistic UI: pause immediately reflects the intent; the next event poll
  // confirms via the paused/resumed events.
  if (action === "pause") detail.paused = true;
  if (action === "resume") detail.paused = false;
  updateDetailControls();
}

function renderTotals(totals) {
  const el = document.getElementById("totals");
  const cacheHitRate = totals.inputTokens > 0 ? (100 * (totals.cachedTokens ?? 0)) / totals.inputTokens : 0;
  el.innerHTML = [
    ["Sessions", fmtInt(totals.sessionCount)],
    ["Total cost", fmtCost(totals.costUsd)],
    ["Input tokens", fmtInt(totals.inputTokens)],
    ["Cached tokens", fmtInt(totals.cachedTokens)],
    ["Cache hit rate", fmtPct(cacheHitRate)],
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
      <td>\${g.usage ? fmtInt(g.usage.cachedTokens) : "—"}</td>
      <td>\${g.usage ? fmtInt(g.usage.outputTokens) : "—"}</td>
      <td>\${g.usage ? fmtInt(g.usage.iterations) : "—"}</td>
    </tr>
  \`).join("");
  el.innerHTML = \`
    <div class="sub">batch: \${esc(round.batch ?? "—")} · updated: \${esc(round.updated ?? "—")}
      · round total: \${round.totalUsage ? fmtCost(round.totalUsage.costUsd) : "$0.000000"}</div>
    <table>
      <thead><tr><th>group</th><th>status</th><th>cost</th><th>in tok</th><th>cached tok</th><th>out tok</th><th>iter</th></tr></thead>
      <tbody>\${rows || '<tr><td colspan="7" class="empty">no groups</td></tr>'}</tbody>
    </table>
  \`;
}

function renderSessions(sessions) {
  const el = document.getElementById("sessions");
  if (!sessions || sessions.length === 0) {
    el.innerHTML = '<div class="empty">no sessions found</div>';
    return;
  }
  // Every row is clickable: opens the live event detail panel for that
  // session (the detail panel polls /api/session/:id/events while open).
  const rows = sessions.map((s) => \`
    <tr class="session-row" data-session-id="\${esc(s.sessionId)}" data-source="\${esc(s.source)}" data-status="\${esc(s.status)}" style="cursor:pointer">
      <td class="mono">\${esc(s.sessionId.slice(0, 8))}</td>
      <td>\${esc(s.mode)}</td>
      <td>\${esc(s.model)}</td>
      <td class="status-\${esc(s.status)}">\${esc(s.status)}</td>
      <td>\${fmtCost(s.costUsd)}</td>
      <td>\${fmtInt(s.inputTokens)}</td>
      <td>\${fmtInt(s.cachedTokens)}</td>
      <td>\${fmtInt(s.outputTokens)}</td>
      <td>\${fmtInt(s.iterations)}</td>
      <td class="mono">\${esc(s.startedAt)}</td>
      <td class="mono">\${esc(s.endedAt) || "—"}</td>
      <td class="mono">\${esc(s.source)}</td>
    </tr>
  \`).join("");
  el.innerHTML = \`
    <table>
      <thead><tr><th>id</th><th>mode</th><th>model</th><th>status</th><th>cost</th><th>in tok</th><th>cached tok</th><th>out tok</th><th>iter</th><th>started</th><th>ended</th><th>source</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  \`;
  // Click delegation: re-render replaces rows each poll, so bind once on the
  // container and read the clicked row's data attributes.
  el.querySelectorAll(".session-row").forEach((row) => {
    row.addEventListener("click", () => {
      openDetail(row.dataset.sessionId, row.dataset.source, row.dataset.status);
    });
  });
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

document.getElementById("detailClose").addEventListener("click", closeDetail);
document.getElementById("btnPause").addEventListener("click", () => controlSession("pause"));
document.getElementById("btnResume").addEventListener("click", () => controlSession("resume"));
// Stop yanking the view down while the user reads history above.
document.getElementById("feed").addEventListener("scroll", () => {
  if (detail) detail.userScrolledUp = !feedAutoScrolls();
});

poll();
setInterval(poll, 4000);
// Live event feed poll: faster than the summary poll (1.5s) so the detail
// view feels live, and only runs while a detail view is open.
setInterval(pollEvents, 1500);
</script>
</body>
</html>
`
}
