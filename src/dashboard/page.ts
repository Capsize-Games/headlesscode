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
 * carries pause/resume buttons (POST /api/session/:id/pause|resume) and a
 * checkpoints panel (GET /api/checkpoints list + GET /api/checkpoints/diff,
 * POST /api/checkpoints/restore).
 *
 * Checkpoints panel: lists the session's shadow-git checkpoints; clicking one
 * shows its unified-diff-style text block vs the working tree; Restore
 * reverts REAL workspace files and therefore requires a two-step confirm
 * (the button arms first — a second click fires the POST). After a restore
 * the list + diff refresh so the view never shows stale data.
 *
 * NOTE (Phase 3 scope change): this page is no longer purely read-only — the
 * pause/resume buttons issue state-changing POSTs, and restore is fully
 * destructive. Local-only + no-auth by default; the restore POST goes
 * through the same optional bearer-token gate as the other control POSTs
 * when HEADLESSCODE_DASHBOARD_TOKEN is set (see src/dashboard/server.ts).
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

  /* Inline decision-answer box (browser control plane): rendered in the feed
     right after a decision_blocked event with no matching decision_answered
     yet, so the human answers right where they see the question. */
  .answer-box {
    border: 1px solid color-mix(in srgb, #b8860b 50%, transparent);
    border-radius: 8px; padding: 8px 12px; margin: 6px 0;
    background: color-mix(in srgb, #b8860b 8%, transparent);
  }
  .answer-box .answer-suggestions { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
  .answer-box .answer-suggestions button {
    font-size: 0.75rem; padding: 2px 10px; border-radius: 12px; cursor: pointer;
    border: 1px solid color-mix(in srgb, #b8860b 60%, transparent);
    background: color-mix(in srgb, #b8860b 12%, transparent); color: inherit;
  }
  .answer-box .answer-input-row { display: flex; gap: 6px; align-items: center; }
  .answer-box input[type="text"] { flex: 1; font-size: 0.8rem; padding: 3px 8px; }
  .answer-box button { font-size: 0.75rem; padding: 3px 12px; border-radius: 6px; cursor: pointer; }
  .answer-box .answer-status { font-size: 0.75rem; color: GrayText; margin-left: 6px; }

  /* Checkpoints panel (browser checkpoint list/diff/restore): sits between
     the detail head and the event feed. Plain rows + a unified-diff <pre> —
     no framework, matching this page's ethos. */
  #checkpointsPanel {
    border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    padding: 8px 16px;
  }
  .checkpoints-head { display: flex; align-items: baseline; gap: 8px; font-weight: 600; font-size: 0.85rem; }
  .checkpoints-head .ckpt-status { font-weight: 400; color: GrayText; font-size: 0.75rem; }
  .ckpt-list { margin-top: 4px; }
  .ckpt-row {
    display: flex; gap: 10px; align-items: baseline; padding: 3px 0;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 6%, transparent);
    font-size: 0.8rem; cursor: pointer;
  }
  .ckpt-row:hover { background: color-mix(in srgb, CanvasText 5%, transparent); }
  .ckpt-row.selected { background: color-mix(in srgb, #8250df 12%, transparent); }
  .ckpt-row .ckpt-msg { flex: 1; word-break: break-word; }
  .ckpt-row .ckpt-date { color: GrayText; flex-shrink: 0; }
  .ckpt-row .ckpt-hash { color: GrayText; flex-shrink: 0; }
  .ckpt-diff { margin-top: 8px; }
  .ckpt-diff-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .ckpt-diff-head button {
    font-size: 0.75rem; padding: 3px 12px; border-radius: 6px; cursor: pointer;
    border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); background: color-mix(in srgb, CanvasText 8%, transparent);
  }
  .ckpt-diff-head button:disabled { opacity: 0.45; cursor: not-allowed; }
  .ckpt-diff-head button.restore-armed {
    background: #c0392b; color: #fff; border-color: #c0392b; font-weight: 600;
  }
  .ckpt-diff-head .ckpt-restore-msg { font-size: 0.75rem; }
  #ckptDiffBody {
    max-height: 300px; overflow-y: auto; margin-top: 6px; padding: 8px 12px;
    background: color-mix(in srgb, CanvasText 4%, transparent);
    border: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem; white-space: pre-wrap; word-break: break-word;
  }
</style>
</head>
<body>
  <h1>headlesscode dashboard</h1>
  <div class="sub">Local monitor + control. Summary auto-refreshes every 4s. <span id="generatedAt"></span></div>

  <div id="launch">
    <h2>Start a session</h2>
    <div class="sub">Launch a top-level session as a detached background process (same CLI
      <code>scripts/run-worker.sh</code> uses). The event feed below opens immediately so you can
      watch it start thinking. Requires <code>OPENROUTER_API_KEY</code> to be exported in the
      dashboard process's environment (<code>set -a; source .env; set +a</code> before starting the
      dashboard) — launched sessions inherit it, they don't re-source <code>.env</code>.</div>
    <textarea id="launchTask" rows="3" placeholder="Describe the work, e.g. 'Split plans/realtime-monitoring.md into issues and orchestrate a round against them…'" style="width:100%"></textarea>
    <div style="display:flex; gap:8px; margin-top:8px; align-items:center; flex-wrap:wrap;">
      <label for="launchMode" class="mono" style="color:GrayText">mode</label>
      <input type="text" id="launchMode" list="modeList" value="multi-agent-orchestrator-headless" style="min-width:260px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:0.8rem">
      <datalist id="modeList"></datalist>
      <button id="btnStart">▶ Start</button>
      <span id="launchMsg"></span>
    </div>
  </div>

  <div class="stats" id="totals"></div>

  <h2>Mode → model settings</h2>
  <div class="sub">Per-mode model assignment (<code>.headlesscode/mode-models.json</code>).
    Each role resolves its own model; <code>_default</code> is the fallback when a mode isn't listed.
    An explicit <code>--model</code> flag always overrides this table.</div>
  <div id="modeModels"></div>

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
    <div id="checkpointsPanel">
      <div class="checkpoints-head">📸 Checkpoints <span class="ckpt-status" id="ckptStatus"></span></div>
      <div class="ckpt-list" id="ckptList"></div>
      <div class="ckpt-diff" id="ckptDiff" style="display:none">
        <div class="ckpt-diff-head">
          <span class="mono" id="ckptDiffTitle"></span>
          <button id="btnRestore" title="reverts real workspace files to this checkpoint">Restore</button>
          <span class="ckpt-restore-msg" id="ckptRestoreMsg"></span>
        </div>
        <pre id="ckptDiffBody"></pre>
      </div>
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

function openDetail(sessionId, source, status, workspace) {
  closeDetail();
  detail = { sessionId, source, nextOffset: 0, lastEventCount: 0, userScrolledUp: false, status, workspace };
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
  // The checkpoints panel loads alongside the event feed.
  loadCheckpoints();
}

function closeDetail() {
  if (detail) {
    detail = null;
  }
  // Reset checkpoint state so the panel shows nothing stale next open.
  ckptEntries = [];
  ckptSelectedHash = null;
  ckptRestoreArmed = false;
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
  div.dataset.ts = e.ts || "";
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
        // Browser control plane: if this is a decision_blocked and no
        // matching decision_answered has arrived yet, render the inline
        // answer box right here in the feed.
        if (e.type === "decision_blocked" && !answeredAlready(feed, e)) {
          renderAnswerBox(feed, e);
        }
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
    // Prune answer boxes for decision_blocked events that now HAVE a matching
    // decision_answered (the answer arrived — the box is moot).
    pruneAnsweredBoxes();
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

// ── Checkpoints (browser checkpoint list/diff/restore) ──────────────────────
// The panel in the session detail view lists the session's shadow-git
// checkpoints (message, date, hash) via GET /api/checkpoints. Clicking a row
// loads its diff (GET /api/checkpoints/diff) and renders it as a plain
// unified-diff-style text block. Restore reverts REAL files, so it needs a
// two-step confirm: the button first arms ("really restore?"), and only a
// second click on the armed button fires the POST. After a successful restore
// the list + diff refresh so the view never shows stale data.
let ckptEntries = []; // { hash, message, date } for the current detail session
let ckptSelectedHash = null;
let ckptRestoreArmed = false;

async function loadCheckpoints() {
  const listEl = document.getElementById("ckptList");
  const statusEl = document.getElementById("ckptStatus");
  const diffEl = document.getElementById("ckptDiff");
  if (!detail) return;
  // The detail view is keyed by session id; the checkpoints routes are keyed
  // by the same session id (HeadlessSession uses sessionId as the checkpoint
  // taskId). The workspace the shadow repo tracks is the session's recorded
  // workspaceRoot (a worker session may live in a worktree, not --repo).
  const params = new URLSearchParams({ session: detail.sessionId });
  if (detail.workspace) params.set("repo", detail.workspace);
  try {
    const res = await fetch("/api/checkpoints?" + params.toString());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    ckptEntries = data.entries || [];
    ckptSelectedHash = null;
    ckptRestoreArmed = false;
    diffEl.style.display = "none";
    document.getElementById("ckptDiffBody").textContent = "";
    document.getElementById("ckptRestoreMsg").textContent = "";
    if (ckptEntries.length === 0) {
      statusEl.textContent = "none for this session";
      listEl.innerHTML = '<div class="feed-empty">no checkpoints</div>';
      return;
    }
    statusEl.textContent = ckptEntries.length + " checkpoint" + (ckptEntries.length > 1 ? "s" : "");
    listEl.innerHTML = "";
    for (const entry of ckptEntries) {
      const row = document.createElement("div");
      row.className = "ckpt-row";
      row.dataset.hash = entry.hash;
      row.innerHTML =
        '<span class="ckpt-msg">' + esc(entry.message) + "</span>" +
        '<span class="ckpt-date">' + esc(entry.date) + "</span>" +
        '<span class="ckpt-hash mono">' + esc(entry.hash.slice(0, 12)) + "</span>";
      row.addEventListener("click", () => selectCheckpoint(entry.hash, row));
      listEl.appendChild(row);
    }
  } catch (err) {
    statusEl.textContent = "";
    listEl.innerHTML = '<div class="feed-empty">failed to load checkpoints: ' + esc(String(err)) + "</div>";
  }
}

function selectCheckpoint(hash, row) {
  ckptSelectedHash = hash;
  ckptRestoreArmed = false;
  const restoreBtn = document.getElementById("btnRestore");
  restoreBtn.classList.remove("restore-armed");
  restoreBtn.textContent = "Restore";
  restoreBtn.disabled = false;
  document.getElementById("ckptRestoreMsg").textContent = "";
  document.getElementById("ckptRestoreMsg").className = "ckpt-restore-msg";
  document.querySelectorAll(".ckpt-row").forEach((r) => r.classList.toggle("selected", r === row));
  loadDiff(hash);
}

async function loadDiff(hash) {
  const diffEl = document.getElementById("ckptDiff");
  const titleEl = document.getElementById("ckptDiffTitle");
  const bodyEl = document.getElementById("ckptDiffBody");
  const entry = ckptEntries.find((e) => e.hash === hash);
  titleEl.textContent = (entry ? entry.message : hash.slice(0, 12)) + " vs working tree";
  bodyEl.textContent = "loading diff…";
  diffEl.style.display = "block";
  const params = new URLSearchParams({ session: detail.sessionId, from: hash });
  if (detail.workspace) params.set("repo", detail.workspace);
  try {
    const res = await fetch("/api/checkpoints/diff?" + params.toString());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    bodyEl.textContent = data.diff || "(no changes)";
  } catch (err) {
    bodyEl.textContent = "failed to load diff: " + err;
  }
}

// Restore is DESTRUCTIVE (reverts real workspace files) — never a single
// accidental click. First click arms the button (turns red + changes label);
// second click actually POSTs.
async function restoreSelected() {
  const restoreBtn = document.getElementById("btnRestore");
  const msgEl = document.getElementById("ckptRestoreMsg");
  if (!ckptSelectedHash) return;
  if (!ckptRestoreArmed) {
    ckptRestoreArmed = true;
    restoreBtn.classList.add("restore-armed");
    restoreBtn.textContent = "⚠ Really restore?";
    msgEl.textContent = "this reverts real files in the workspace to the selected checkpoint — uncommitted changes since then are lost";
    msgEl.className = "ckpt-restore-msg";
    return;
  }
  restoreBtn.disabled = true;
  msgEl.textContent = "restoring…";
  msgEl.className = "ckpt-restore-msg";
  try {
    const params = new URLSearchParams({ session: detail.sessionId });
    if (detail.workspace) params.set("repo", detail.workspace);
    const res = await fetch("/api/checkpoints/restore?" + params.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash: ckptSelectedHash }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      msgEl.textContent = "restore failed: " + (data.error || ("HTTP " + res.status));
      msgEl.className = "ckpt-restore-msg status-error";
      restoreBtn.disabled = false;
      return;
    }
    msgEl.textContent = "restored ✓ to " + ckptSelectedHash.slice(0, 12) + " — files reverted";
    msgEl.className = "ckpt-restore-msg status-success";
    // Reflect the new state: re-list (restore rewrites the workspace; the
    // checkpoint set itself is unchanged but the working tree is now at the
    // restored commit) and refresh the selected diff (now vs the restored
    // tree, so "no changes" is expected).
    await loadCheckpoints();
    if (ckptEntries.some((e) => e.hash === ckptSelectedHash)) {
      loadDiff(ckptSelectedHash);
    }
  } catch (err) {
    msgEl.textContent = "restore failed: " + err;
    msgEl.className = "ckpt-restore-msg status-error";
    restoreBtn.disabled = false;
  }
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
    <tr class="session-row" data-session-id="\${esc(s.sessionId)}" data-source="\${esc(s.source)}" data-status="\${esc(s.status)}" data-workspace="\${esc(s.workspaceRoot)}" style="cursor:pointer">
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
      openDetail(row.dataset.sessionId, row.dataset.source, row.dataset.status, row.dataset.workspace);
    });
  });
}

// ── Mode → model settings (mode-model-assignment) ───────────────────────────
// A small editable table (mode slug + model id, add/remove rows) with a save
// button that POSTs the current table state to /api/settings/mode-models and
// shows success/error inline. Plain vanilla JS — no framework, matching this
// page's style.
const modeModelsEl = document.getElementById("modeModels");

// Rows carry their slug in a data attribute so the table state can be
// serialized back to the { mode: model, _default: model } file shape.
function settingsTableRow(slug, model, isDefault) {
  const tr = document.createElement("tr");
  tr.dataset.slug = slug;
  tr.innerHTML =
    '<td class="mono">' + esc(slug) + "</td>" +
    '<td><input type="text" value="' + esc(model) + '" placeholder="provider/model" class="model-input" style="width:100%"></td>' +
    '<td><button class="row-remove" title="remove row">✕</button></td>';
  if (isDefault) {
    const label = document.createElement("span");
    label.className = "sub";
    label.textContent = "  (fallback)";
    tr.querySelector("td").appendChild(label);
  }
  tr.querySelector(".row-remove").addEventListener("click", () => {
    tr.remove();
  });
  return tr;
}

// Populate the "start a session" mode selector from the real merged modes
// (.roomodes + global ~/.roo/custom_modes.yaml). Falls back to just the
// default when the endpoint is unavailable (e.g. no --repo) — the input stays
// a plain text field, so typing any slug always works.
async function loadModes() {
  const list = document.getElementById("modeList");
  if (!list) return;
  try {
    const res = await fetch("/api/modes");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    list.innerHTML = "";
    const seen = new Set();
    for (const m of (data.modes || [])) {
      if (seen.has(m.slug)) continue;
      seen.add(m.slug);
      const opt = document.createElement("option");
      opt.value = m.slug;
      if (m.name && m.name !== m.slug) opt.label = m.name;
      list.appendChild(opt);
    }
  } catch (err) {
    // Non-fatal: the text input with the default value still works.
    list.innerHTML = "";
  }
}

async function loadModeModels() {
  try {
    const res = await fetch("/api/settings/mode-models");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderModeModels(data || {});
  } catch (err) {
    modeModelsEl.innerHTML = '<div class="empty">failed to load mode-models settings: ' + esc(err) + "</div>";
  }
}

function renderModeModels(file) {
  const entries = Object.entries(file || {});
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>mode</th><th>model id</th><th></th></tr>";
  const tbody = document.createElement("tbody");
  let hasDefault = false;
  for (const [slug, model] of entries) {
    const isDefault = slug === "_default";
    if (isDefault) hasDefault = true;
    tbody.appendChild(settingsTableRow(slug, model, isDefault));
  }
  if (!hasDefault) {
    // Seed an empty _default row so the fallback is always editable.
    tbody.appendChild(settingsTableRow("_default", "", true));
  }
  table.appendChild(thead);
  table.appendChild(tbody);

  const slugInput = document.createElement("input");
  slugInput.type = "text";
  slugInput.placeholder = "mode slug (e.g. code, deepseek-reviewer, qa-agent)";
  slugInput.style.width = "100%";

  const modelInput = document.createElement("input");
  modelInput.type = "text";
  modelInput.placeholder = "provider/model";
  modelInput.style.width = "100%";

  const addBtn = document.createElement("button");
  addBtn.textContent = "+ Add row";
  addBtn.addEventListener("click", () => {
    const slug = slugInput.value.trim();
    if (!slug || slug === "_default") {
      addMsg("mode slug must be a non-empty string (use the _default row for the fallback)", true);
      return;
    }
    if (table.querySelector('tbody tr[data-slug="' + slug + '"]')) {
      addMsg("row for mode '" + slug + "' already exists", true);
      return;
    }
    const tr = settingsTableRow(slug, modelInput.value.trim(), false);
    tbody.appendChild(tr);
    slugInput.value = "";
    modelInput.value = "";
    clearMsg();
  });

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "💾 Save";
  saveBtn.addEventListener("click", () => saveModeModels(table));

  const addRow = document.createElement("div");
  addRow.className = "settings-add";
  addRow.style.cssText = "display:flex; gap:8px; margin-top:8px; align-items:center; flex-wrap:wrap;";
  addRow.appendChild(slugInput);
  addRow.appendChild(modelInput);
  addRow.appendChild(addBtn);

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex; gap:8px; margin-top:8px; align-items:center; flex-wrap:wrap;";
  actions.appendChild(saveBtn);
  const msg = document.createElement("span");
  msg.id = "settingsMsg";
  actions.appendChild(msg);

  modeModelsEl.innerHTML = "";
  modeModelsEl.appendChild(table);
  modeModelsEl.appendChild(addRow);
  modeModelsEl.appendChild(actions);
}

function currentSettingsTable(table) {
  const out = {};
  for (const tr of table.querySelectorAll("tbody tr")) {
    const slug = tr.dataset.slug;
    const model = tr.querySelector("input").value.trim();
    if (!slug) continue;
    if (model) out[slug] = model;
  }
  return out;
}

function settingsMsg() {
  return document.getElementById("settingsMsg");
}

function addMsg(text, isError) {
  const el = settingsMsg();
  if (!el) return;
  el.textContent = text;
  el.className = isError ? "status-error" : "status-success";
}

function clearMsg() {
  const el = settingsMsg();
  if (el) el.textContent = "";
}

async function saveModeModels(table) {
  const payload = currentSettingsTable(table);
  clearMsg();
  try {
    const res = await fetch("/api/settings/mode-models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      addMsg("save failed: " + (data.error || ("HTTP " + res.status)), true);
      return;
    }
    addMsg("saved ✓ — " + Object.keys(payload).length + " entry(ies)", false);
  } catch (err) {
    addMsg("save failed: " + err, true);
  }
}

// ── Start a session (browser control plane) ─────────────────────────────────
// POSTs the typed prompt to /api/session/start, then navigates straight to
// that session's live event view — the whole point is the user watches it
// start thinking within a second or two of hitting submit, not that they
// hunt for it in a list.
async function startSession() {
  const task = document.getElementById("launchTask").value.trim();
  const mode = document.getElementById("launchMode").value.trim() || "multi-agent-orchestrator-headless";
  const msg = document.getElementById("launchMsg");
  const btn = document.getElementById("btnStart");
  if (!task) {
    msg.textContent = "type a prompt first";
    msg.className = "status-error";
    return;
  }
  msg.textContent = "launching…";
  msg.className = "";
  btn.disabled = true;
  try {
    const res = await fetch("/api/session/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task, mode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      msg.textContent = "start failed: " + (data.error || ("HTTP " + res.status));
      msg.className = "status-error";
      return;
    }
    // Navigate immediately to the new session's live event view.
    openDetail(data.sessionId, ".", "running", data.workspace);
    msg.textContent = "launched ✓ session " + data.sessionId.slice(0, 8) + " — watching its event feed";
    msg.className = "status-success";
  } catch (err) {
    msg.textContent = "start failed: " + err;
    msg.className = "status-error";
  } finally {
    btn.disabled = false;
  }
}

// ── Answer a blocked session (browser control plane) ────────────────────────
// Rendered inline in the event feed at the decision_blocked event when no
// matching decision_answered has arrived yet. Suggestion buttons are
// quick-replies; the free-text input is the general case.

// An event feed has exactly one blocked question at a time (a session blocks
// on one ask_followup_question, gets answered, then possibly blocks again).
// Track per-session state so we only render one answer box per outstanding
// question, and prune it once the answer arrives.
let pendingDecisionTs = null;

// Returns true when this decision_blocked should NOT get an answer box —
// i.e. a decision_answered for it already exists in the feed. Scans the DOM
// (a session can block multiple times; only match an answer that came after
// this particular question).
function answeredAlready(feed, blockedEvent) {
  // If the detail view was reopened, pendingDecisionTs may still point at
  // this exact blocked event from a previous render — treat that as "box
  // still owed" unless a box already exists in the freshly re-rendered feed.
  if (pendingDecisionTs === blockedEvent.ts && feed.querySelector(".answer-box")) {
    return true;
  }
  // Otherwise, check whether the feed already shows a decision_answered that
  // came after this blocked event in DOM order.
  const evs = feed.querySelectorAll(".ev.decision_answered");
  for (const el of evs) {
    if (el.dataset.ts >= blockedEvent.ts) return true;
  }
  return false;
}

function pruneAnsweredBoxes() {
  const feed = document.getElementById("feed");
  const evs = feed.querySelectorAll(".ev.decision_answered");
  if (evs.length === 0) {
    // No answer events at all — keep boxes as-is.
    return;
  }
  const lastAnswered = evs[evs.length - 1].dataset.ts;
  feed.querySelectorAll(".answer-box").forEach((box) => {
    const ts = box.dataset.blockedTs;
    if (ts && ts <= lastAnswered) {
      box.remove();
    }
  });
  // If the newest answer postdates our pending question, it's resolved.
  if (pendingDecisionTs !== null && pendingDecisionTs <= lastAnswered) {
    pendingDecisionTs = null;
  }
}

function renderAnswerBox(feed, e) {
  pendingDecisionTs = e.ts;
  const box = document.createElement("div");
  box.className = "answer-box";
  box.dataset.blockedTs = e.ts;
  const suggestions = Array.isArray(e.suggestions) ? e.suggestions : [];
  const sRow = document.createElement("div");
  sRow.className = "answer-suggestions";
  for (const s of suggestions) {
    const b = document.createElement("button");
    b.textContent = s;
    b.addEventListener("click", () => submitAnswer(e, s, box));
    sRow.appendChild(b);
  }
  box.appendChild(sRow);

  const row = document.createElement("div");
  row.className = "answer-input-row";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "type an answer…";
  row.appendChild(input);
  const btn = document.createElement("button");
  btn.textContent = "Answer";
  btn.addEventListener("click", () => {
    const text = input.value.trim();
    if (!text) return;
    submitAnswer(e, text, box);
  });
  row.appendChild(btn);
  const status = document.createElement("span");
  status.className = "answer-status";
  status.id = "answerStatus" + (e.ts || "");
  row.appendChild(status);
  box.appendChild(row);
  feed.appendChild(box);
}

async function submitAnswer(e, text, box) {
  const status = box.querySelector(".answer-status");
  if (!status) return;
  status.textContent = "answering…";
  try {
    const res = await fetch("/api/session/" + encodeURIComponent(detail.sessionId) + "/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      status.textContent = "failed: " + (data.error || ("HTTP " + res.status));
      return;
    }
    status.textContent = "answered ✓ — worker resumes on its next poll";
    status.className = "status-success";
    // Keep the box but disable it; the decision_answered event will confirm.
    box.querySelectorAll("button, input").forEach((el) => { el.disabled = true; });
  } catch (err) {
    status.textContent = "failed: " + err;
  }
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
document.getElementById("btnStart").addEventListener("click", startSession);
document.getElementById("btnRestore").addEventListener("click", restoreSelected);
// Enter in the task box submits too (shift+enter for a newline).
document.getElementById("launchTask").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    startSession();
  }
});
// Stop yanking the view down while the user reads history above.
document.getElementById("feed").addEventListener("scroll", () => {
  if (detail) detail.userScrolledUp = !feedAutoScrolls();
});

poll();
loadModeModels();
loadModes();
setInterval(poll, 4000);
// Live event feed poll: faster than the summary poll (1.5s) so the detail
// view feels live, and only runs while a detail view is open.
setInterval(pollEvents, 1500);
</script>
</body>
</html>
`
}
