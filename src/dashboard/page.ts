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

export function renderPage(repo?: string): string {
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

  /* Detail view tabs: flat event log (original) vs. chat thread (this view).
     Both render from the SAME /api/session/:id/events feed — the toggle only
     switches how the already-arriving events are displayed. */
  #detail .detail-tabs { display: flex; gap: 4px; padding: 0 16px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
  #detail .detail-tabs button {
    font-size: 0.8rem; padding: 6px 14px; cursor: pointer;
    border: none; background: none; color: GrayText; border-bottom: 2px solid transparent;
  }
  #detail .detail-tabs button.active { color: CanvasText; border-bottom-color: #8250df; font-weight: 600; }

  /* Chat-thread view (phase: dashboard-chat-ui). Rendered client-side from the
     same event feed — the model's text + its tool calls/results per turn, as
     chat bubbles instead of flat rows. */
  #chat {
    display: none; max-height: 420px; overflow-y: auto; padding: 16px 16px 8px;
    font-size: 0.85rem; line-height: 1.45;
  }
  #detail.view-chat #feed { display: none; }
  #detail.view-chat #chat { display: block; }
  #chat .chat-task {
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    border-radius: 10px; padding: 8px 12px; margin-bottom: 14px;
    background: color-mix(in srgb, CanvasText 5%, transparent);
    white-space: pre-wrap; word-break: break-word;
  }
  #chat .chat-task .chat-task-label { font-size: 0.72rem; color: GrayText; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
  #chat .turn { margin-bottom: 16px; }
  #chat .turn-head {
    display: flex; align-items: center; gap: 8px; margin: 0 0 6px;
    font-size: 0.72rem; color: GrayText; text-transform: uppercase; letter-spacing: 0.04em;
  }
  #chat .turn-head .turn-iter { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  #chat .bubble {
    border: 1px solid color-mix(in srgb, #8250df 35%, transparent);
    border-radius: 10px; padding: 10px 14px; margin-bottom: 8px;
    background: color-mix(in srgb, #8250df 6%, transparent);
    word-break: break-word; white-space: pre-wrap;
  }
  #chat .bubble .bubble-kicker { font-size: 0.72rem; color: #8250df; font-weight: 600; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
  #chat .bubble .bubble-kicker.error { color: #c0392b; }
  #chat .bubble .bubble-kicker.ok { color: #1a7f37; }
  #chat .bubble.stream-chunk { border-style: dashed; border-color: color-mix(in srgb, #8250df 25%, transparent); background: color-mix(in srgb, #8250df 3%, transparent); }
  #chat .tool-call {
    display: flex; align-items: baseline; gap: 8px; margin: 8px 0 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem;
  }
  #chat .tool-call .tool-name { color: #8250df; font-weight: 600; }
  #chat .tool-call .tool-arg { color: GrayText; word-break: break-all; }
  #chat .tool-result {
    margin: 2px 0 6px 22px; padding: 6px 10px; border-left: 3px solid #1a7f37;
    background: color-mix(in srgb, #1a7f37 6%, transparent);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem;
    white-space: pre-wrap; word-break: break-word; color: color-mix(in srgb, CanvasText 85%, transparent);
  }
  #chat .tool-result.error { border-left-color: #c0392b; background: color-mix(in srgb, #c0392b 7%, transparent); }
  #chat .tool-result .result-label { font-weight: 600; margin-bottom: 2px; }
  #chat .tool-result.error .result-label { color: #c0392b; }
  #chat .tool-result.ok .result-label { color: #1a7f37; }
  #chat .trunc-note { color: GrayText; font-style: italic; font-size: 0.72rem; }
  #chat .sys-marker {
    display: flex; align-items: center; gap: 6px; margin: 10px 0;
    font-size: 0.72rem; color: GrayText;
  }
  #chat .sys-marker .marker-label { font-weight: 600; }
  #chat .sys-marker.checkpoint_saved .marker-label { color: #b8860b; }
  #chat .sys-marker.paused .marker-label { color: #b8860b; }
  #chat .sys-marker.resumed .marker-label { color: #1a7f37; }
  #chat .sys-marker.decision_answered .marker-label { color: #1a7f37; }
  #chat .sys-marker.decision_blocked .marker-label { color: #c0392b; }
  #chat .sys-marker.llm_error .marker-label { color: #c0392b; }
  #chat .sys-marker.session_end .marker-label { color: GrayText; }
  #chat .chat-empty { color: GrayText; font-style: italic; padding: 12px 0; }
  #chat .chat-err { color: #c0392b; padding: 12px 0; }

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
  /* File browser (dashboard-file-browser-and-permissions-ui). */
  #fileBrowser { margin-top: 8px; }
  #fileBrowser .fb-toolbar { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; flex-wrap: wrap; }
  #fileBrowser .fb-toolbar input[type="text"] { flex: 1; min-width: 200px; padding: 4px 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }
  #fileBrowser .fb-tree {
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    border-radius: 8px; max-height: 380px; overflow: auto; padding: 6px 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem;
  }
  #fileBrowser .fb-entry { display: flex; align-items: center; gap: 6px; padding: 2px 10px; cursor: pointer; white-space: nowrap; }
  #fileBrowser .fb-entry:hover { background: color-mix(in srgb, CanvasText 6%, transparent); }
  #fileBrowser .fb-entry .fb-name { overflow: hidden; text-overflow: ellipsis; }
  #fileBrowser .fb-entry .fb-size { margin-left: auto; color: GrayText; font-size: 0.7rem; padding-left: 12px; }
  #fileBrowser .fb-entry.dir > .fb-name { font-weight: 600; }
  #fileBrowser .fb-children { padding-left: 16px; }
  #fileBrowser .fb-children.collapsed { display: none; }
  #fileBrowser .fb-viewer {
    margin-top: 8px; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    border-radius: 8px; overflow: hidden;
  }
  #fileBrowser .fb-viewer-head {
    display: flex; align-items: center; gap: 8px; padding: 6px 12px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    font-size: 0.75rem; color: GrayText;
  }
  #fileBrowser .fb-viewer-head .fb-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; color: CanvasText; overflow: hidden; text-overflow: ellipsis; }
  #fileBrowser .fb-viewer-head .fb-close { margin-left: auto; cursor: pointer; border: none; background: none; font-size: 1rem; color: GrayText; }
  #fileBrowser pre.fb-content {
    margin: 0; padding: 12px; max-height: 420px; overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; line-height: 1.45;
    white-space: pre-wrap; word-break: break-word;
  }
  #fileBrowser .fb-note { color: GrayText; font-style: italic; padding: 8px 12px; }

  /* Permissions settings (dashboard-file-browser-and-permissions-ui). */
  #permissionsSettings .perm-list { display: flex; flex-direction: column; gap: 8px; }
  #permissionsSettings .perm-field label { font-size: 0.75rem; color: GrayText; text-transform: uppercase; letter-spacing: 0.03em; }
  #permissionsSettings .perm-field textarea {
    width: 100%; min-height: 56px; padding: 6px 8px; margin-top: 3px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem;
    resize: vertical;
  }
  #permissionsSettings .perm-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  #permissionsSettings .perm-row button { font-size: 0.8rem; padding: 3px 12px; border-radius: 6px; cursor: pointer; }
  #permissionsSettings .perm-actions { display: flex; gap: 8px; margin-top: 10px; align-items: center; flex-wrap: wrap; }
  #permissionsSettings .perm-status { font-size: 0.8rem; }

  /* Timeline view (work-progress-visualization). Third detail-view mode next to
     the flat event log and the chat thread. Pure HTML/CSS positioning — no
     charting library: iteration cells and marker dots are absolutely placed on
     a % time axis, matching this page's no-dependency ethos. */
  #timeline { display: none; padding: 12px 16px; font-size: 0.8rem; }
  #detail.view-timeline #feed { display: none; }
  #detail.view-timeline #chat { display: none; }
  #detail.view-timeline #timeline { display: block; }
  .tl-empty { color: GrayText; font-style: italic; padding: 12px 0; }
  .tl-summary { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
  .tl-chip {
    border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
    border-radius: 8px; padding: 4px 10px; display: flex; gap: 6px; align-items: baseline;
    background: color-mix(in srgb, CanvasText 4%, transparent);
  }
  .tl-chip .tl-chip-label { color: GrayText; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.03em; }
  .tl-chip .tl-chip-value { font-weight: 600; }
  .tl-chip.tl-cat-read .tl-chip-value { color: #4f9cf9; }
  .tl-chip.tl-cat-search .tl-chip-value { color: #38bdf8; }
  .tl-chip.tl-cat-write .tl-chip-value { color: #f59e0b; }
  .tl-chip.tl-cat-exec .tl-chip-value { color: #10b981; }
  .tl-legend { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; color: GrayText; font-size: 0.72rem; }
  .tl-legend-item { display: inline-flex; align-items: center; gap: 4px; }
  .tl-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
  .tl-cat-read { background: #4f9cf9; }
  .tl-cat-search { background: #38bdf8; }
  .tl-cat-write { background: #f59e0b; }
  .tl-cat-exec { background: #10b981; }
  .tl-cat-other { background: #9ca3af; }
  .tl-cat-none { background: transparent; border: 1px dashed color-mix(in srgb, CanvasText 30%, transparent); }
  .tl-strip {
    position: relative; height: 30px; margin: 4px 0 2px;
    border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 4px;
    background: color-mix(in srgb, CanvasText 3%, transparent);
  }
  .tl-grid { position: relative; height: 100%; }
  .tl-cell { position: absolute; top: 2px; bottom: 2px; border-radius: 2px; cursor: pointer; }
  .tl-cell:hover { outline: 1px solid CanvasText; }
  .tl-marker-row { position: relative; height: 16px; margin: 2px 0 6px; }
  .tl-marker { position: absolute; top: 0; transform: translateX(-50%); font-size: 0.8rem; cursor: default; }
  .tl-mk-checkpoint { color: #b8860b; }
  .tl-mk-condensed { color: #8250df; }
  .tl-mk-paused { color: #b8860b; }
  .tl-mk-resumed { color: #1a7f37; }
  .tl-mk-decision { color: #c0392b; }
  .tl-mk-start { color: #1a7f37; }
  .tl-mk-end { color: GrayText; }
  .tl-mk-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; background: currentColor; }
  .tl-marker-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .tl-marker-chip {
    font-size: 0.72rem; padding: 1px 8px; border-radius: 10px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    color: GrayText;
  }
  .tl-marker-chip.tl-mk-condensed { border-color: color-mix(in srgb, #8250df 50%, transparent); color: #8250df; }
  .tl-marker-chip.tl-mk-decision { border-color: color-mix(in srgb, #c0392b 50%, transparent); color: #c0392b; }
  .tl-marker-chip.tl-mk-paused { border-color: color-mix(in srgb, #b8860b 50%, transparent); color: #b8860b; }
  .tl-marker-chip.tl-mk-resumed { border-color: color-mix(in srgb, #1a7f37 50%, transparent); color: #1a7f37; }
  .tl-iter-list { margin-top: 4px; }
  .tl-iter-row { border-bottom: 1px solid color-mix(in srgb, CanvasText 6%, transparent); }
  .tl-iter-head { display: flex; align-items: baseline; gap: 10px; padding: 4px 2px; cursor: pointer; flex-wrap: wrap; }
  .tl-iter-head:hover { background: color-mix(in srgb, CanvasText 4%, transparent); }
  .tl-iter-num { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
  .tl-cat-badge { font-size: 0.7rem; padding: 0 6px; border-radius: 8px; color: #fff; }
  .tl-cat-badge.tl-cat-read { background: #4f9cf9; }
  .tl-cat-badge.tl-cat-search { background: #38bdf8; }
  .tl-cat-badge.tl-cat-write { background: #f59e0b; }
  .tl-cat-badge.tl-cat-exec { background: #10b981; }
  .tl-cat-badge.tl-cat-other { background: #9ca3af; }
  .tl-cat-badge.tl-cat-none { background: transparent; color: GrayText; border: 1px dashed color-mix(in srgb, CanvasText 40%, transparent); }
  .tl-iter-tools { color: GrayText; word-break: break-all; }
  .tl-iter-err { color: #c0392b; font-weight: 600; }
  .tl-iter-tokens { color: GrayText; margin-left: auto; }
  .tl-iter-body { padding: 2px 2px 6px 14px; color: GrayText; }

  /* Cost history (issue #29): historical per-round cost/token/duration charts,
     rendered as inline SVG (no charting library). Same rules also style the
     self-improvement progress section (issue #145) — shared look, separate
     data source. */
  #costHistory .ch-chips, #selfImprovement .ch-chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  #costHistory .ch-chip, #selfImprovement .ch-chip {
    border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
    border-radius: 8px; padding: 4px 10px; display: flex; gap: 6px; align-items: baseline;
    background: color-mix(in srgb, CanvasText 4%, transparent);
  }
  #costHistory .ch-chip .ch-chip-label, #selfImprovement .ch-chip .ch-chip-label { color: GrayText; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.03em; }
  #costHistory .ch-chip .ch-chip-value, #selfImprovement .ch-chip .ch-chip-value { font-weight: 600; }
  #costHistory .ch-chip.ch-wasted .ch-chip-value, #selfImprovement .ch-chip.ch-wasted .ch-chip-value { color: #c0392b; }
  #costHistory .ch-block, #selfImprovement .ch-block { margin-bottom: 16px; }
  #costHistory .ch-block-title, #selfImprovement .ch-block-title { font-size: 0.82rem; font-weight: 600; margin-bottom: 4px; }
  #costHistory .ch-block-sub, #selfImprovement .ch-block-sub { font-size: 0.72rem; color: GrayText; margin-bottom: 6px; }
  #costHistory .ch-table-wrap { overflow-x: auto; }
</style>
</head>
<body>
  <h1>headlesscode dashboard</h1>
  <div class="sub">Local monitor + control. Summary auto-refreshes every 4s. <span id="generatedAt"></span></div>

  <div id="launch">
    <h2>Start a session</h2>
    <div class="sub">Launch a top-level session as a detached background process (same CLI
      <code>scripts/run-worker.sh</code> uses). The event feed below opens immediately so you can
      watch it start thinking. Requires <code>HEADLESSCODE_OPENROUTER_API_KEY</code> to be exported in the
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

  <h2>Workspace files</h2>
  <div class="sub">Read-only file browser. Click a directory to expand/collapse; click a file to
    preview its text content (files over 30k chars or binary files are not previewable).
    No file editing from the browser — deliberately read-only.</div>
  <div id="fileBrowser">
    <div class="fb-toolbar">
      <input type="text" id="fbRepo" placeholder="workspace path (repo)" value="${repo ? String(repo).replace(/"/g, "&quot;") : ""}" />
      <button id="fbLoad">Load</button>
      <span id="fbMsg"></span>
    </div>
    <div class="empty">enter a workspace path and press Load</div>
  </div>

  <h2>Permissions settings</h2>
  <div class="sub">Command allow/deny + protected-file permissions
    (<code>.headlesscode/permissions.json</code>). When no file exists yet the page shows the
    resolved built-in defaults, clearly labeled. Save writes the file; the change takes effect
    on the next session (fresh <code>resolvePermissions</code> call).</div>
  <div id="permissionsSettings"><div class="empty">loading…</div></div>

  <h2>Blocked (awaiting a decision)</h2>
  <div id="blocked"><div class="empty">none</div></div>

  <h2>Round (orchestrator groups)</h2>
  <div id="round"><div class="empty">no .orchestrator-state.json found for --repo</div></div>

  <h2>Sessions</h2>
  <div id="sessions"><div class="empty">no sessions found</div></div>

  <h2>Cost history</h2>
  <div class="sub">Historical per-round cost/token/duration from the central store's
    <code>cost-history.jsonl</code> / <code>session-cost-history.jsonl</code>, served by
    <code>/api/cost-history</code>. Uses the workspace path from the file browser above
    (or <code>--repo</code>); reload with the file browser's Load button.</div>
  <div id="costHistory"><div class="empty">loading…</div></div>

  <h2>Self-improvement progress</h2>
  <div class="sub">Recursive self-improvement loop metrics (issue #145) — computed from this
    repo's own session records, <code>git log</code>, and <code>gh issue list</code>, served by
    <code>/api/self-improvement</code>. Local-machine only; no external dashboard. Hourly buckets,
    oldest → newest.</div>
  <div id="selfImprovement"><div class="empty">loading…</div></div>

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
    <div class="detail-tabs">
      <button id="tabLog" class="active">Event log</button>
      <button id="tabChat">Chat thread</button>
      <button id="tabTimeline">Timeline</button>
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
    <div id="chat"><div class="chat-empty">select a session to watch its live event feed</div></div>
    <div id="timeline"><div class="tl-empty">select a session to watch its live event feed</div></div>
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
  llm_stream_chunk: "⋯ stream chunk",
  llm_error: "💥 llm error",
  tool_call: "🔧 tool call",
  tool_result: "✅ tool result",
  checkpoint_saved: "📸 checkpoint",
  condensed: "🧠 condensed",
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
  detail = { sessionId, source, nextOffset: 0, lastEventCount: 0, userScrolledUp: false, status, workspace, allEvents: [], view: "chat" };

  document.getElementById("detail").style.display = "block";
  document.getElementById("detailSessionId").textContent = sessionId;
  document.getElementById("detailSource").textContent = "· " + (source || "");
  updateDetailControls();
  const feed = document.getElementById("feed");
  feed.innerHTML = '<div class="feed-empty">loading events…</div>';
  document.getElementById("chat").innerHTML = '<div class="chat-empty">loading events…</div>';
  document.getElementById("timeline").innerHTML = '<div class="tl-empty">loading events…</div>';
  // Reset scroll-tracking state for the new session.
  detail.userScrolledUp = false;
  feed.scrollTop = 0;
  setView(detail.view);
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
    case "llm_stream_chunk":
      body = (e.kind || "") + (e.chunk ? " · " + esc(String(e.chunk).slice(0, 200)) + (e.chunkTruncated ? ' <span class="trunc-note">(truncated)</span>' : "") : "");
      break;
    case "checkpoint_saved":
      body = e.iteration === 0 ? "baseline" : "after iteration " + esc(e.iteration);
      break;
    case "condensed":
      body = "messages " + esc(e.messagesBefore) + "→" + esc(e.messagesAfter) +
        (typeof e.inputTokens === "number" ? " · in=" + esc(e.inputTokens) + " out=" + esc(e.outputTokens ?? 0) + " cached=" + esc(e.cachedTokens ?? 0) : "");
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
  // NOTE: the ev-body class is built with a variable to avoid a backslash-quote
  // escape INSIDE this page's outer template literal — \" in a template literal
  // is unescaped at runtime to a bare quote, which would break the served JS
  // (pre-existing bug fixed here; the flat log must keep working).
  const evBodyClass = "ev-body";
  div.innerHTML = '<span class="ev-ts">' + esc(e.ts) + "</span><span class=" + evBodyClass + ">" + iter + '<span class="ev-label">' + esc(label) + "</span> " + body + "</span>";
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
    const newEvents = data.events || [];
    // Accumulate the full feed: the chat view groups events into turns, so it
    // needs everything seen so far, not just the incremental slice. The flat
    // event-log view still appends incrementally as before.
    detail.allEvents = (detail.allEvents || []).concat(newEvents);
    if (detail.lastEventCount === 0 && newEvents.length === 0) {
      feed.innerHTML = '<div class="feed-empty">no events yet — waiting for the worker…</div>';
      renderChat();
    } else {
      const shouldScroll = feedAutoScrolls();
      if (feed.querySelector(".feed-empty")) feed.innerHTML = "";
      for (const e of newEvents) {
        feed.appendChild(renderEvent(e));
        // Browser control plane: if this is a decision_blocked and no
        // matching decision_answered has arrived yet, render the inline
        // answer box right here in the feed.
        if (e.type === "decision_blocked" && !answeredAlready(feed, e)) {
          renderAnswerBox(feed, e);
        }
      }
      detail.lastEventCount = (detail.lastEventCount || 0) + newEvents.length;
      if (shouldScroll) feed.scrollTop = feed.scrollHeight;
      renderChat();
    }
    detail.nextOffset = data.nextOffset;
    // Derive running/paused state from the feed (the summary row may lag).
    const types = newEvents.map((e) => e.type);
    if (types.includes("paused")) detail.paused = true;
    if (types.includes("resumed")) detail.paused = false;
    if (types.includes("session_end")) { detail.status = "done"; detail.paused = false; }
    // Prune answer boxes for decision_blocked events that now HAVE a matching
    // decision_answered (the answer arrived — the box is moot).
    pruneAnsweredBoxes();
    // The timeline re-renders from allEvents on every poll, like the chat view.
    renderTimeline();
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

// ── Chat-thread view (dashboard-chat-ui) ────────────────────────────────────
// Groups the SAME event feed data into conversation turns (see the grouping
// rules in src/dashboard/chat-thread.ts) and renders them as chat bubbles:
// the user's task, then per turn the assistant's text + its tool calls and
// their results inline, with system-level events as small markers. The flat
// event-log view (renderEvent above) remains available via the tab toggle.
// This is client-side-only rendering of data that's already arriving via the
// existing poll — no new backend source.

// Short arg summary for a tool call, matching the server-side summarizeToolArg
// style (the feed already carries this as "args"; cap here for safety).
function chatSummaryArg(e) {
  if (!e || e.type !== "tool_call") return "";
  const raw = String(e.args || "");
  const trimmed = raw.trim();
  if (trimmed.length <= 80) return trimmed;
  return trimmed.slice(0, 80) + "…";
}

function setView(view) {
  if (!detail) return;
  detail.view = view;
  const detailEl = document.getElementById("detail");
  detailEl.classList.toggle("view-chat", view === "chat");
  detailEl.classList.toggle("view-timeline", view === "timeline");
  document.getElementById("tabLog").classList.toggle("active", view === "log");
  document.getElementById("tabChat").classList.toggle("active", view === "chat");
  document.getElementById("tabTimeline").classList.toggle("active", view === "timeline");
}

// Render one chat "turn" block: the model's text bubble (plus a reasoning
// bubble if streaming-and-reasoning has landed and the feed carries one),
// then its tool calls and results inline.
function renderChatTurn(turn) {
  const wrap = document.createElement("div");
  wrap.className = "turn";

  const head = document.createElement("div");
  head.className = "turn-head";
  const ts = turn.turnStart.ts || "";
  const headText = (turn.turnStart.type === "decision_blocked")
    ? "⛔ question"
    : "iteration " + (typeof turn.iteration === "number" ? turn.iteration : "?");
  head.innerHTML = '<span class="turn-iter">' + esc(headText) + "</span><span>" + esc(ts) + "</span>";
  wrap.appendChild(head);

  for (const e of turn.events) {
    if (e.type === "llm_response") {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      const reasoning = typeof e.reasoning === "string" && e.reasoning ? e.reasoning : "";
      const text = typeof e.textPreview === "string" ? e.textPreview : "";
      const toks = typeof e.inputTokens === "number"
        ? '<div class="trunc-note">in=' + esc(e.inputTokens) + " · out=" + esc(e.outputTokens ?? 0) + " · cached=" + esc(e.cachedTokens ?? 0) + "</div>"
        : "";
      if (reasoning) {
        bubble.innerHTML =
          '<div class="bubble-kicker">thinking</div><div>' + esc(reasoning) + "</div>" +
          (text ? '<div style="margin-top:8px">' + esc(text) + "</div>" : "") + toks;
      } else if (text) {
        bubble.innerHTML = '<div>' + esc(text) + "</div>" + toks;
      } else {
        bubble.innerHTML = '<div class="trunc-note">(tool-call turn — no text)</div>' + toks;
      }
      if (e.textTruncated) {
        bubble.appendChild(elTruncNote());
      }
      wrap.appendChild(bubble);
    } else if (e.type === "llm_stream_chunk") {
      // Streaming chunk: render as a live-typing bubble. The turn's final
      // llm_response carries the assembled text, so these are purely the
      // "live" effect between iteration_start and llm_response.
      const stream = document.createElement("div");
      stream.className = "bubble stream-chunk";
      const label = e.kind === "reasoning" ? "thinking…" : e.kind === "tool" ? "tool…" : "typing…";
      stream.innerHTML =
        '<div class="bubble-kicker">' + esc(label) + "</div>" +
        "<div>" + esc(String(e.chunk || "")) + "</div>" +
        (e.chunkTruncated ? '<div class="trunc-note">(truncated)</div>' : "");
      wrap.appendChild(stream);
    } else if (e.type === "decision_answered") {
      // The answer to a blocked question: inline in the turn that asked it.
      const marker = document.createElement("div");
      marker.className = "sys-marker decision_answered";
      marker.innerHTML = '<span class="marker-label">💬 answer</span><span>' + esc(e.timedOut ? "timed out — worker moved on autonomously" : (e.answer || "")) + "</span>";
      wrap.appendChild(marker);
    } else if (e.type === "tool_call") {
      const call = document.createElement("div");
      call.className = "tool-call";
      const arg = chatSummaryArg(e);
      call.innerHTML = '<span class="tool-name">' + esc(e.tool) + "</span>" + (arg ? '<span class="tool-arg">' + esc(arg) + "</span>" : "") + (e.argsTruncated ? ' <span class="trunc-note">(truncated)</span>' : "");
      wrap.appendChild(call);
    } else if (e.type === "tool_result") {
      const res = document.createElement("div");
      res.className = "tool-result" + (e.isError ? " error" : " ok");
      const label = (e.isError ? "⚠ error" : "✓ result") + (e.tool ? " · " + esc(e.tool) : "");
      const content = String(e.result || "");
      res.innerHTML = '<div class="result-label">' + label + "</div>" + (content ? "<div>" + esc(content) + "</div>" : "") + (e.resultTruncated ? '<div class="trunc-note">(truncated)</div>' : "");
      wrap.appendChild(res);
    } else {
      // Unknown event inside a turn: fall back to a system marker.
      wrap.appendChild(renderChatSystem(e));
    }
  }
  return wrap;
}

function elTruncNote() {
  const d = document.createElement("div");
  d.className = "trunc-note";
  d.textContent = "(truncated)";
  return d;
}

// Render a system-level event as a small inline marker, not a chat bubble.
function renderChatSystem(e) {
  const marker = document.createElement("div");
  marker.className = "sys-marker " + esc(e.type);
  const labels = {
    session_start: "🚀 session start",
    checkpoint_saved: "📸 checkpoint",
    condensed: "🧠 condensed",
    paused: "⏸ paused",
    resumed: "▶ resumed",
    llm_error: "💥 llm error",
    decision_blocked: "⛔ blocked (question)",
    session_end: "🏁 session end",
  };
  const label = labels[e.type] || e.type;
  let body = "";
  switch (e.type) {
    case "checkpoint_saved":
      body = e.iteration === 0 ? "baseline" : "after iteration " + esc(e.iteration);
      break;
    case "condensed":
      body = "messages " + esc(e.messagesBefore) + "→" + esc(e.messagesAfter) +
        (typeof e.inputTokens === "number" ? " · in=" + esc(e.inputTokens) + " out=" + esc(e.outputTokens ?? 0) + " cached=" + esc(e.cachedTokens ?? 0) : "");
      break;
    case "paused":
    case "resumed":
      body = e.reason ? esc(e.reason) : "";
      break;
    case "llm_error":
      body = esc(String(e.message || e.error || ""));
      break;
    case "session_start":
      body = esc(e.mode || "") + " · " + esc(e.model || "");
      break;
    case "session_end":
      body = "status=" + esc(e.status) + " · iterations=" + esc(e.iterations) + " · cost=" + fmtCost(e.costUsd);
      break;
    case "decision_blocked":
      body = esc(e.question || "") + (e.suggestions && e.suggestions.length ? " · suggestions: " + esc(e.suggestions.join(" | ")) : "");
      break;
    default:
      body = esc(JSON.stringify(e).slice(0, 200));
  }
  marker.innerHTML = '<span class="marker-label">' + esc(label) + "</span>" + (body ? "<span>" + body + "</span>" : "");
  return marker;
}

// Re-render the whole chat thread from the accumulated event feed. Called on
// every poll (the feed arrives incrementally, but grouping is order-dependent
// — a turn only becomes complete once its final tool_result lands, so
// re-grouping from scratch is the simplest correct approach).
function renderChat() {
  if (!detail) return;
  const chat = document.getElementById("chat");
  const events = detail.allEvents || [];
  if (events.length === 0) {
    chat.innerHTML = '<div class="chat-empty">no events yet — waiting for the worker…</div>';
    return;
  }
  const shouldScroll = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
  chat.innerHTML = "";

  // Task bubble (the user's message) when the feed has a session_start.
  const start = events.find((e) => e.type === "session_start");
  if (start && typeof start.task === "string" && start.task) {
    const task = document.createElement("div");
    task.className = "chat-task";
    task.innerHTML = '<div class="chat-task-label">task</div><div>' + esc(start.task) + "</div>" + (start.taskTruncated ? '<div class="trunc-note">(truncated)</div>' : "");
    chat.appendChild(task);
  }

  // Group + render. Mirrors src/dashboard/chat-thread.ts's grouping rules
  // (kept as pure TS there + unit-tested; this inline copy is the page's
  // no-build-step vanilla-JS rendition of the same rules).
  const blocks = groupEvents(events);
  for (const block of blocks) {
    if (block.kind === "turn") {
      chat.appendChild(renderChatTurn(block));
    } else {
      chat.appendChild(renderChatSystem(block.event));
    }
  }
  if (shouldScroll) chat.scrollTop = chat.scrollHeight;
}

// Group a flat event array into chat blocks — inline JS twin of the tested
// pure function in src/dashboard/chat-thread.ts (this page has no build step,
// so the grouping is duplicated rather than imported).
function groupEvents(events) {
  const blocks = [];
  let task = "";
  let current = null;
  const closeTurn = () => {
    if (current) {
      blocks.push({ kind: "turn", iteration: current.iteration, turnStart: current.turnStart, events: current.events });
      current = null;
    }
  };
  for (const e of events) {
    switch (e.type) {
      case "session_start":
        task = typeof e.task === "string" ? e.task : "";
        blocks.push({ kind: "system", event: e });
        break;
      case "iteration_start":
        closeTurn();
        current = { iteration: e.iteration, turnStart: e, events: [] };
        break;
      case "decision_blocked":
        closeTurn();
        current = { iteration: e.iteration, turnStart: e, events: [] };
        break;
      case "tool_result": {
        if (current && current.events.length > 0) {
          const last = current.events[current.events.length - 1];
          if (last.type === "tool_call") {
            current.events.push(e);
            break;
          }
        }
        blocks.push({ kind: "system", event: e });
        break;
      }
      case "session_end":
      case "llm_error":
      case "checkpoint_saved":
      case "paused":
      case "resumed":
        closeTurn();
        blocks.push({ kind: "system", event: e });
        break;
      case "llm_response":
      case "tool_call":
      case "decision_answered":
      case "llm_stream_chunk":
        if (current) {
          current.events.push(e);
        } else {
          blocks.push({ kind: "system", event: e });
        }
        break;
      default:
        closeTurn();
        blocks.push({ kind: "system", event: e });
        break;
    }
  }
  closeTurn();
  return blocks;
}

// ── Timeline view (work-progress-visualization) ─────────────────────────────
// Reduces the SAME event feed into a per-iteration "shape" model: one cell per
// iteration colored by its dominant tool type, a running read/write/exec/
// search tool-mix summary, and structural markers (checkpoints, condensation,
// pause/resume, decisions) positioned on a real time axis. Inline vanilla-JS
// twin of src/dashboard/timeline.ts (no build step — duplicated, not imported;
// keep the two in sync). Pure HTML/CSS positioning — no charting library.
const TL_READ = new Set(["read_file", "list_files", "outline", "go_to_definition", "find_references", "import_graph"]);
const TL_WRITE = new Set(["write_to_file", "apply_diff", "search_replace", "edit_file", "set_indentation"]);
const TL_EXEC = new Set(["execute_command"]);
const TL_SEARCH = new Set(["codebase_search"]);

function tlCategory(tool) {
  if (TL_READ.has(tool)) return "read";
  if (TL_WRITE.has(tool)) return "write";
  if (TL_EXEC.has(tool)) return "exec";
  if (TL_SEARCH.has(tool)) return "search";
  return "other";
}

// Tie-break priority for equal call counts: the write that appears once
// alongside a read that appears once is still the iteration's point.
const TL_TIE = ["write", "exec", "search", "read", "other"];

function tlToTs(t) {
  if (typeof t === "number") return t;
  const ms = Date.parse(String(t));
  return Number.isFinite(ms) ? ms : 0;
}

// Inline twin of timeline.ts's buildTimeline: { iterations, markers, totals }.
function buildTimeline(events) {
  const m = {
    iterations: [],
    markers: [],
    totals: { read: 0, write: 0, exec: 0, search: 0, other: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    task: "", model: "", mode: "",
  };
  const categoryCounts = new Map();
  const toolCounts = new Map();
  const iterMeta = new Map();
  const ensure = (iteration) => {
    if (!iterMeta.has(iteration)) {
      iterMeta.set(iteration, { firstTs: Infinity, lastTs: -Infinity, inputTokens: 0, outputTokens: 0, cachedTokens: 0, hasError: false });
    }
  };
  for (const e of events) {
    const ts = tlToTs(e.ts);
    switch (e.type) {
      case "session_start":
        m.task = typeof e.task === "string" ? e.task : "";
        m.model = typeof e.model === "string" ? e.model : "";
        m.mode = typeof e.mode === "string" ? e.mode : "";
        m.markers.push({ kind: "start", ts: ts });
        break;
      case "session_end":
        m.markers.push({ kind: "end", ts: ts, status: e.status });
        break;
      case "iteration_start":
        if (typeof e.iteration !== "number") break;
        ensure(e.iteration);
        iterMeta.get(e.iteration).firstTs = Math.min(iterMeta.get(e.iteration).firstTs, ts);
        iterMeta.get(e.iteration).lastTs = Math.max(iterMeta.get(e.iteration).lastTs, ts);
        break;
      case "llm_response":
        if (typeof e.iteration !== "number") break;
        ensure(e.iteration);
        {
          const meta = iterMeta.get(e.iteration);
          meta.firstTs = Math.min(meta.firstTs, ts);
          meta.lastTs = Math.max(meta.lastTs, ts);
          const input = typeof e.inputTokens === "number" ? e.inputTokens : 0;
          const output = typeof e.outputTokens === "number" ? e.outputTokens : 0;
          const cached = typeof e.cachedTokens === "number" ? e.cachedTokens : 0;
          meta.inputTokens += input;
          meta.outputTokens += output;
          meta.cachedTokens += cached;
          m.totals.inputTokens += input;
          m.totals.outputTokens += output;
          m.totals.cachedTokens += cached;
        }
        break;
      case "tool_call":
        if (typeof e.iteration !== "number") break;
        ensure(e.iteration);
        {
          const meta = iterMeta.get(e.iteration);
          meta.firstTs = Math.min(meta.firstTs, ts);
          meta.lastTs = Math.max(meta.lastTs, ts);
          const tool = typeof e.tool === "string" ? e.tool : "unknown";
          const cat = tlCategory(tool);
          if (!categoryCounts.has(e.iteration)) categoryCounts.set(e.iteration, {});
          categoryCounts.get(e.iteration)[cat] = (categoryCounts.get(e.iteration)[cat] || 0) + 1;
          if (!toolCounts.has(e.iteration)) toolCounts.set(e.iteration, {});
          toolCounts.get(e.iteration)[tool] = (toolCounts.get(e.iteration)[tool] || 0) + 1;
          m.totals[cat] += 1;
          m.totals.toolCalls += 1;
        }
        break;
      case "tool_result":
        if (typeof e.iteration === "number" && iterMeta.has(e.iteration) && e.isError === true) {
          iterMeta.get(e.iteration).hasError = true;
        }
        break;
      case "checkpoint_saved":
        m.markers.push({ kind: "checkpoint", ts: ts, iteration: e.iteration });
        break;
      case "condensed":
        m.markers.push({ kind: "condensed", ts: ts, iteration: e.iteration, messagesBefore: e.messagesBefore, messagesAfter: e.messagesAfter, inputTokens: e.inputTokens, outputTokens: e.outputTokens, cachedTokens: e.cachedTokens });
        break;
      case "paused":
        m.markers.push({ kind: "paused", ts: ts, iteration: e.iteration, reason: e.reason });
        break;
      case "resumed":
        m.markers.push({ kind: "resumed", ts: ts, iteration: e.iteration, reason: e.reason });
        break;
      case "decision_blocked":
        m.markers.push({ kind: "decision", ts: ts, question: e.question });
        break;
      case "decision_answered":
        m.markers.push({ kind: "decision", ts: ts, answer: e.answer, timedOut: e.timedOut });
        break;
    }
  }
  for (const [iteration, meta] of iterMeta) {
    const cc = categoryCounts.get(iteration) || {};
    const tc = toolCounts.get(iteration) || {};
    let dominant = "none";
    if (Object.keys(cc).length > 0) {
      dominant = Object.keys(cc).sort((a, b) => (cc[b] - cc[a]) || (TL_TIE.indexOf(a) - TL_TIE.indexOf(b)))[0];
    }
    const calls = Object.keys(tc)
      .map((name) => ({ name: name, count: tc[name] }))
      .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
    m.iterations.push({
      iteration: iteration,
      category: dominant,
      toolCalls: calls,
      toolCount: calls.reduce((s, c) => s + c.count, 0),
      firstTs: meta.firstTs === Infinity ? 0 : meta.firstTs,
      lastTs: meta.lastTs === -Infinity ? 0 : meta.lastTs,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      cachedTokens: meta.cachedTokens,
      hasError: meta.hasError,
    });
  }
  return m;
}

const TL_LABEL = { read: "read", write: "write", exec: "exec", search: "search", other: "other", none: "idle" };

function tlBounds(m) {
  let min = Infinity, max = -Infinity;
  for (const it of m.iterations) {
    min = Math.min(min, it.firstTs);
    max = Math.max(max, it.lastTs);
  }
  for (const mk of m.markers) {
    min = Math.min(min, mk.ts);
    max = Math.max(max, mk.ts);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    min = 0;
    max = 1;
  }
  return { min: min, max: max, span: max - min };
}

function tlMarkerGlyph(mk) {
  switch (mk.kind) {
    case "start": return "🚀";
    case "checkpoint": return "📸";
    case "condensed": return "⟲";
    case "paused": return "⏸";
    case "resumed": return "▶";
    case "decision": return "⛔";
    case "end": return "🏁";
    default: return "•";
  }
}

function tlMarkerTitle(mk) {
  switch (mk.kind) {
    case "start": return "session start";
    case "checkpoint":
      return "checkpoint" + (typeof mk.iteration === "number" ? (mk.iteration === 0 ? " (baseline)" : " (iter " + mk.iteration + ")") : "");
    case "condensed":
      return "condensed " + esc(mk.messagesBefore) + "→" + esc(mk.messagesAfter) + " messages" + (mk.inputTokens ? " · in=" + fmtInt(mk.inputTokens) + " out=" + fmtInt(mk.outputTokens) : "");
    case "paused": return "paused" + (mk.reason ? ": " + esc(mk.reason) : "");
    case "resumed": return "resumed" + (mk.reason ? ": " + esc(mk.reason) : "");
    case "decision":
      return mk.question
        ? "blocked: " + esc(String(mk.question).slice(0, 60))
        : (mk.timedOut ? "question timed out" : "answered: " + esc(String(mk.answer || "").slice(0, 60)));
    case "end": return "session end" + (mk.status ? " (" + esc(mk.status) + ")" : "");
    default: return mk.kind;
  }
}

// Tool-mix summary chips: the read/write ratio as real numbers, not eyeballed.
function tlSummary(m) {
  const t = m.totals;
  const wrap = document.createElement("div");
  wrap.className = "tl-summary";
  const chips = [
    ["iterations", String(m.iterations.length), ""],
    ["tool calls", fmtInt(t.toolCalls), ""],
    ["reads", fmtInt(t.read), "read"],
    ["searches", fmtInt(t.search), "search"],
    ["writes", fmtInt(t.write), "write"],
    ["commands", fmtInt(t.exec), "exec"],
    ["tokens in", fmtInt(t.inputTokens), ""],
    ["tokens out", fmtInt(t.outputTokens), ""],
    ["cached", fmtInt(t.cachedTokens), ""],
  ];
  for (const c of chips) {
    const chip = document.createElement("div");
    chip.className = "tl-chip" + (c[2] ? " tl-cat-" + c[2] : "");
    chip.innerHTML = '<span class="tl-chip-label">' + esc(c[0]) + '</span><span class="tl-chip-value">' + esc(c[1]) + "</span>";
    wrap.appendChild(chip);
  }
  return wrap;
}

function tlLegend() {
  const wrap = document.createElement("div");
  wrap.className = "tl-legend";
  for (const [cat, label] of [["read", "read"], ["search", "search"], ["write", "write"], ["exec", "commands"], ["other", "other"], ["none", "idle"]]) {
    const s = document.createElement("span");
    s.className = "tl-legend-item";
    s.innerHTML = '<span class="tl-swatch tl-cat-' + esc(cat) + '"></span>' + esc(label);
    wrap.appendChild(s);
  }
  for (const [kind, label] of [["checkpoint", "📸 checkpoint"], ["condensed", "⟲ condensed"], ["paused", "⏸ pause"], ["resumed", "▶ resume"], ["decision", "⛔ decision"]]) {
    const s = document.createElement("span");
    s.className = "tl-legend-item";
    s.innerHTML = '<span class="tl-swatch tl-mk-swatch tl-mk-' + esc(kind) + '"></span>' + esc(label);
    wrap.appendChild(s);
  }
  return wrap;
}

// The horizontal timeline: one cell per iteration, positioned by REAL time
// (session-relative % of the whole span), colored by dominant tool type.
function tlStrip(m) {
  const b = tlBounds(m);
  const strip = document.createElement("div");
  strip.className = "tl-strip";
  const grid = document.createElement("div");
  grid.className = "tl-grid";
  strip.appendChild(grid);
  for (const it of m.iterations) {
    const left = ((it.firstTs - b.min) / b.span) * 100;
    const width = Math.min(Math.max(1.2, ((it.lastTs - it.firstTs) / b.span) * 100), 100 - left);
    const cell = document.createElement("div");
    cell.className = "tl-cell tl-cat-" + esc(it.category);
    cell.style.left = left.toFixed(3) + "%";
    cell.style.width = width.toFixed(3) + "%";
    cell.title = "iteration " + it.iteration + " — " + TL_LABEL[it.category] +
      (it.toolCount ? " · " + it.toolCount + " tool call" + (it.toolCount === 1 ? "" : "s") + " (" + it.toolCalls.map((c) => c.name + "×" + c.count).join(", ") + ")" : "") +
      (it.inputTokens ? " · in=" + fmtInt(it.inputTokens) + " out=" + fmtInt(it.outputTokens) + " cached=" + fmtInt(it.cachedTokens) : "");
    cell.dataset.iter = String(it.iteration);
    cell.addEventListener("click", () => toggleIterationRow(it.iteration, true));
    grid.appendChild(cell);
  }
  return strip;
}

// Structural markers on the same time axis (dots) + readable chips for the
// interesting ones (checkpoints stay as dots — their density IS the signal).
function tlMarkers(m) {
  const wrap = document.createElement("div");
  const b = tlBounds(m);
  const dots = document.createElement("div");
  dots.className = "tl-marker-row";
  for (const mk of m.markers) {
    const left = ((mk.ts - b.min) / b.span) * 100;
    const dot = document.createElement("div");
    dot.className = "tl-marker tl-mk-" + esc(mk.kind);
    dot.style.left = left.toFixed(3) + "%";
    dot.textContent = tlMarkerGlyph(mk);
    dot.title = tlMarkerTitle(mk);
    dots.appendChild(dot);
  }
  wrap.appendChild(dots);

  const chips = document.createElement("div");
  chips.className = "tl-marker-chips";
  for (const mk of m.markers) {
    if (mk.kind === "checkpoint") continue;
    const chip = document.createElement("span");
    chip.className = "tl-marker-chip tl-mk-" + esc(mk.kind);
    chip.textContent = tlMarkerGlyph(mk) + " " + tlMarkerTitle(mk);
    chips.appendChild(chip);
  }
  wrap.appendChild(chips);
  return wrap;
}

// Per-iteration detail rows below the strip: click a row (or a strip cell) to
// expand the exact tool calls + token usage of that iteration.
function toggleIterationRow(iteration, scrollTo) {
  const list = document.querySelector("#timeline .tl-iter-list");
  if (!list) return;
  const row = list.querySelector('.tl-iter-row[data-iter="' + iteration + '"]');
  if (!row) return;
  const body = row.querySelector(".tl-iter-body");
  const head = row.querySelector(".tl-iter-head");
  if (body) {
    const open = body.style.display === "block";
    body.style.display = open ? "none" : "block";
    if (head) head.classList.toggle("open", !open);
    if (!open && scrollTo) row.scrollIntoView({ block: "nearest" });
  }
}

function tlIterations(m) {
  const list = document.createElement("div");
  list.className = "tl-iter-list";
  for (const it of m.iterations) {
    const row = document.createElement("div");
    row.className = "tl-iter-row";
    row.dataset.iter = String(it.iteration);
    const head = document.createElement("div");
    head.className = "tl-iter-head";
    const toolSummary = it.toolCalls.map((c) => c.name + "×" + c.count).join(", ") || "no tool calls";
    const tokens = it.inputTokens
      ? "in=" + fmtInt(it.inputTokens) + " · out=" + fmtInt(it.outputTokens) + " · cached=" + fmtInt(it.cachedTokens)
      : "";
    head.innerHTML =
      '<span class="tl-iter-num">iter ' + esc(it.iteration) + "</span>" +
      '<span class="tl-cat-badge tl-cat-' + esc(it.category) + '">' + esc(TL_LABEL[it.category]) + "</span>" +
      '<span class="tl-iter-tools">' + esc(toolSummary) + "</span>" +
      (it.hasError ? '<span class="tl-iter-err">⚠ error</span>' : "") +
      (tokens ? '<span class="tl-iter-tokens mono">' + esc(tokens) + "</span>" : "");
    head.addEventListener("click", () => toggleIterationRow(it.iteration, false));
    row.appendChild(head);
    const body = document.createElement("div");
    body.className = "tl-iter-body";
    body.style.display = "none";
    body.innerHTML =
      '<div class="mono">tools: ' + esc(it.toolCalls.map((c) => c.name + " × " + c.count).join(" · ") || "none") + "</div>" +
      (tokens ? '<div class="mono">tokens: ' + esc(tokens) + "</div>" : "");
    row.appendChild(body);
    list.appendChild(row);
  }
  return list;
}

// Re-render the whole timeline from the accumulated feed on every poll (same
// approach as renderChat — incremental append doesn't fit a % time axis).
function renderTimeline() {
  if (!detail) return;
  const el = document.getElementById("timeline");
  const events = detail.allEvents || [];
  if (events.length === 0) {
    el.innerHTML = '<div class="tl-empty">no events yet — waiting for the worker…</div>';
    return;
  }
  const m = buildTimeline(events);
  el.innerHTML = "";
  el.appendChild(tlSummary(m));
  el.appendChild(tlLegend());
  el.appendChild(tlStrip(m));
  el.appendChild(tlMarkers(m));
  el.appendChild(tlIterations(m));
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
  const preflight = round.preflight && round.preflight.line
    ? '<div class="sub mono" title="preflight probe before this round spawned">preflight: ' + esc(round.preflight.line) + '</div>'
    : "";
  el.innerHTML = \`
    <div class="sub">batch: \${esc(round.batch ?? "—")} · updated: \${esc(round.updated ?? "—")}
      · batch total: \${round.batchUsage ? fmtCost(round.batchUsage.costUsd) : "$0.000000"}
      · round total (all history): \${round.totalUsage ? fmtCost(round.totalUsage.costUsd) : "$0.000000"}</div>
    \${preflight}
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

// ── Workspace file browser (dashboard-file-browser-and-permissions-ui) ──────
// A simple collapsible directory tree — plain vanilla JS, no library. Clicking
// a directory toggles its children; clicking a file fetches its (capped,
// binary-safe) content and shows it in a read-only text view. Read-only by
// design: no file editing from the browser in this pass.
const fbEl = document.getElementById("fileBrowser");
const fbMsgEl = document.getElementById("fbMsg");
const fbRepoInput = document.getElementById("fbRepo");

// Paths currently expanded, relative to the workspace root ("." = root).
// The tree re-fetches each level on demand — no full recursive walk, so a
// huge repo stays cheap.
const fbExpanded = new Set();

function fbMsg(text, isError) {
  if (!fbMsgEl) return;
  fbMsgEl.textContent = text;
  fbMsgEl.className = isError ? "status-error" : "status-success";
}

function fbRepo() {
  return (fbRepoInput.value || "").trim();
}

async function fbFetchDir(relDir) {
  const params = new URLSearchParams();
  params.set("repo", fbRepo());
  if (relDir && relDir !== ".") params.set("dir", relDir);
  const res = await fetch("/api/files?" + params.toString());
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || ("HTTP " + res.status));
  }
  return data.entries || [];
}

function fmtSize(n) {
  if (typeof n !== "number") return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

// Render one directory level as a <div class="fb-children"> under parentRel.
// container is the element the level's children get appended to.
async function renderFbLevel(container, parentRel) {
  container.innerHTML = '<div class="empty">loading…</div>';
  let entries;
  try {
    entries = await fbFetchDir(parentRel);
  } catch (err) {
    container.innerHTML = '<div class="empty">failed: ' + esc(err) + "</div>";
    return;
  }
  container.innerHTML = "";
  for (const entry of entries) {
    const rel = parentRel === "." || parentRel === "" ? entry.name : parentRel + "/" + entry.name;
    const row = document.createElement("div");
    row.className = "fb-entry " + (entry.type === "dir" ? "dir" : "file");
    const icon = entry.type === "dir" ? "📁" : "📄";
    row.innerHTML =
      '<span class="fb-icon">' + icon + "</span>" +
      '<span class="fb-name">' + esc(entry.name) + "</span>" +
      (entry.type === "file" ? '<span class="fb-size">' + esc(fmtSize(entry.size)) + "</span>" : "");
    if (entry.type === "dir") {
      const children = document.createElement("div");
      children.className = "fb-children collapsed";
      row.appendChild(children);
      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (fbExpanded.has(rel)) {
          fbExpanded.delete(rel);
          children.classList.add("collapsed");
          children.innerHTML = "";
        } else {
          fbExpanded.add(rel);
          children.classList.remove("collapsed");
          renderFbLevel(children, rel);
        }
      });
    } else {
      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        fbPreviewFile(rel);
      });
    }
    container.appendChild(row);
  }
  if (entries.length === 0) {
    container.innerHTML = '<div class="empty">(empty directory)</div>';
  }
}

async function fbPreviewFile(rel) {
  const params = new URLSearchParams();
  params.set("repo", fbRepo());
  params.set("file", rel);
  try {
    const res = await fetch("/api/files/content?" + params.toString());
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    fbShowViewer(rel, data);
  } catch (err) {
    fbMsg("failed to load file: " + err, true);
  }
}

function fbShowViewer(rel, data) {
  const existing = fbEl.querySelector(".fb-viewer");
  if (existing) existing.remove();
  const viewer = document.createElement("div");
  viewer.className = "fb-viewer";
  const head = document.createElement("div");
  head.className = "fb-viewer-head";
  head.innerHTML = '<span class="fb-path">' + esc(rel) + "</span>" +
    '<button class="fb-close" title="close">✕</button>';
  head.querySelector(".fb-close").addEventListener("click", () => viewer.remove());
  viewer.appendChild(head);
  const body = document.createElement("div");
  if (data.previewable) {
    const pre = document.createElement("pre");
    pre.className = "fb-content";
    pre.textContent = data.content;
    body.appendChild(pre);
  } else {
    const note = document.createElement("div");
    note.className = "fb-note";
    note.textContent = "not previewable — " + (data.reason || "unknown reason");
    body.appendChild(note);
  }
  viewer.appendChild(body);
  fbEl.appendChild(viewer);
  viewer.scrollIntoView({ block: "nearest" });
}

async function fbLoad() {
  if (!fbRepo()) {
    fbMsg("enter a workspace path first", true);
    return;
  }
  fbExpanded.clear();
  fbMsg("");
  const tree = fbEl.querySelector(".fb-tree");
  if (tree) tree.remove();
  const holder = document.createElement("div");
  holder.className = "fb-tree";
  fbEl.appendChild(holder);
  await renderFbLevel(holder, ".");
  // The repo path also drives the cost-history + self-improvement +
  // permissions views — reload them together so a repo switch updates the
  // whole page, not just the tree.
  loadCostHistory();
  loadSelfImprovement();
  loadPermissions();
}

// ── Permissions settings (dashboard-file-browser-and-permissions-ui) ────────
// View + edit allowed/denied command lists, protected-file globs, and the
// allowProtectedWrites escape hatch. Mirrors the mode-models settings page's
// UX: load current state, edit in place, Save POSTs and shows the same inline
// success/error status. When no permissions.json exists yet the page shows
// the resolved built-in defaults, clearly labeled as defaults.
const permEl = document.getElementById("permissionsSettings");

function permStatus() {
  return permEl.querySelector(".perm-status");
}

function permMsg(text, isError) {
  const el = permStatus();
  if (!el) return;
  el.textContent = text;
  el.className = "perm-status " + (isError ? "status-error" : "status-success");
}

// The three list fields are edited as newline-separated text (one entry per
// line — the natural way to edit a list of command prefixes / globs in a
// plain textarea, no framework).
const PERM_LIST_FIELDS = [
  { key: "allowedCommands", label: "allowed commands", hint: "one command prefix per line — empty = default-ALLOW (deny list still applies)" },
  { key: "deniedCommands", label: "denied commands", hint: "one command prefix per line — deny always wins" },
  { key: "protectedFiles", label: "protected files", hint: "one glob per line, e.g. .env, *.pem, secrets/" },
];

function permListToText(list) {
  return (list || []).join("\\n");
}

function permTextToList(text) {
  return text.split("\\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

function renderPermissions(data) {
  const file = data.file || null;
  const resolved = data.resolved || {};

  permEl.innerHTML = "";

  const banner = document.createElement("div");
  banner.className = "sub";
  if (data.isDefault) {
    banner.textContent = "No .headlesscode/permissions.json yet — showing the resolved built-in defaults. " +
      "Saving writes a real config file; until then these defaults apply to every session.";
  } else {
    banner.textContent = "Loaded from .headlesscode/permissions.json — this is the file every session reads.";
  }
  permEl.appendChild(banner);

  const list = document.createElement("div");
  list.className = "perm-list";

  // Seed the textareas from the FILE content when present, else from the
  // resolved defaults (so an empty workspace shows what would actually be
  // enforced — and saving those defaults is a no-op policy-wise).
  const seed = file || {
    allowedCommands: resolved.allowedCommands || [],
    deniedCommands: resolved.deniedCommands || [],
    protectedFiles: resolved.protectedFiles || [],
  };

  for (const field of PERM_LIST_FIELDS) {
    const div = document.createElement("div");
    div.className = "perm-field";
    const label = document.createElement("label");
    label.textContent = field.label;
    div.appendChild(label);
    const ta = document.createElement("textarea");
    ta.dataset.key = field.key;
    ta.value = permListToText(seed[field.key]);
    ta.placeholder = field.hint;
    div.appendChild(ta);
    list.appendChild(div);
  }
  permEl.appendChild(list);

  // allowProtectedWrites — the escape hatch, labeled as such.
  const row = document.createElement("div");
  row.className = "perm-row";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.id = "permAllowWrites";
  cb.checked = !!seed.allowProtectedWrites;
  const cbLabel = document.createElement("label");
  cbLabel.htmlFor = "permAllowWrites";
  cbLabel.innerHTML = '<span class="mono">allowProtectedWrites</span> — escape hatch: allow writes to protected files (.env, keys, PEMs). <b>Off by default; turning this on weakens protection for every future session.</b>';
  row.appendChild(cb);
  row.appendChild(cbLabel);
  permEl.appendChild(row);

  const actions = document.createElement("div");
  actions.className = "perm-actions";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "💾 Save permissions";
  saveBtn.addEventListener("click", () => savePermissions());
  actions.appendChild(saveBtn);
  const msg = document.createElement("span");
  msg.className = "perm-status";
  actions.appendChild(msg);
  permEl.appendChild(actions);
}

function currentPermissionsPayload() {
  const payload = {};
  for (const field of PERM_LIST_FIELDS) {
    const ta = permEl.querySelector('textarea[data-key="' + field.key + '"]');
    const list = ta ? permTextToList(ta.value) : [];
    if (list.length > 0) payload[field.key] = list;
  }
  const cb = document.getElementById("permAllowWrites");
  if (cb) payload.allowProtectedWrites = cb.checked;
  return payload;
}

async function savePermissions() {
  permMsg("saving…", false);
  const payload = currentPermissionsPayload();
  try {
    const res = await fetch("/api/settings/permissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      permMsg("save failed: " + (data.error || ("HTTP " + res.status)), true);
      return;
    }
    permMsg("saved ✓ — permissions.json written. Takes effect on the next session.", false);
    // Refresh the GET so the page reflects the now-customized state.
    loadPermissions();
  } catch (err) {
    permMsg("save failed: " + err, true);
  }
}

async function loadPermissions() {
  const params = new URLSearchParams();
  if (fbRepo()) params.set("repo", fbRepo());
  try {
    const res = await fetch("/api/settings/permissions?" + params.toString());
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    renderPermissions(data);
  } catch (err) {
    permEl.innerHTML = '<div class="empty">failed to load permissions settings: ' + esc(err) + "</div>";
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

// ── Cost history (issue #29) ─────────────────────────────────────────────────
// Historical per-round + per-session cost/token/duration from the central
// store's cost-history.jsonl / session-cost-history.jsonl, served by
// GET /api/cost-history?repo=<path> (see src/dashboard/server.ts). All charts
// are hand-rolled inline SVG — no charting library, matching this page's
// no-dependency ethos. The server returns newest-first; the charts read
// oldest-first.
const costHistoryEl = document.getElementById("costHistory");
const selfImprovementEl = document.getElementById("selfImprovement");

function chRepo() {
  return fbRepo() || "";
}

function chCost(n) {
  return "$" + (n ?? 0).toFixed(4);
}

function chDuration(ms) {
  if (!(typeof ms === "number") || !Number.isFinite(ms) || ms < 0) return "?";
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return days + "d " + hours + "h";
  if (hours > 0) return hours + "h " + minutes + "m";
  return minutes + "m";
}

// Group label: the issues a round covered (#27,#29), falling back to the
// group name for groups with no issue numbers.
function chGroupLabel(g) {
  const nums = (g.issues && g.issues.length) ? g.issues.map(function (x) { return "#" + x; }).join(",") : "";
  return nums || g.groupName || "?";
}

// Generic inline-SVG single-series bar chart. items: [{label, value, color,
// title}]. opts.format(v) renders y-axis labels; opts.height overrides the
// chart height. Returns an SVG string (the caller innerHTMLs it).
function chBars(items, opts) {
  opts = opts || {};
  const width = 640;
  const height = opts.height || 170;
  const padL = 48, padR = 8, padT = 10, padB = 20;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  let max = 0;
  for (const it of items) {
    if (typeof it.value === "number" && it.value > max) max = it.value;
  }
  if (max <= 0) max = 1;
  const n = items.length;
  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.max(2, slot * 0.55);
  const steps = 4;
  let out = '<svg viewBox="0 0 ' + width + " " + height + '" width="100%" style="max-width:640px;height:auto" role="img">';
  for (let i = 0; i <= steps; i++) {
    const v = (max * i) / steps;
    const y = padT + plotH - (plotH * i) / steps;
    out += '<line x1="' + padL + '" y1="' + y + '" x2="' + (width - padR) + '" y2="' + y + '" stroke="currentColor" stroke-opacity="0.12"/>';
    out += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end" font-size="9" fill="currentColor" fill-opacity="0.7">' +
      esc(opts.format ? opts.format(v) : Math.round(v)) + "</text>";
  }
  items.forEach(function (it, i) {
    const x = padL + i * slot + (slot - barW) / 2;
    const h = Math.max(1, (plotH * it.value) / max);
    const y = padT + plotH - h;
    out += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" fill="' + (it.color || "#8250df") + '"><title>' + esc(it.title || it.label) + "</title></rect>";
    if (n <= 24) {
      out += '<text x="' + (x + barW / 2).toFixed(1) + '" y="' + (height - 6) + '" text-anchor="middle" font-size="8.5" fill="currentColor" fill-opacity="0.7">' + esc(it.label) + "</text>";
    }
  });
  out += "</svg>";
  return out;
}

// Generic inline-SVG single-series line chart (issue #145). items:
// [{label, value, title}]. opts.max fixes the y-axis scale (e.g. 1 for a
// 0..100% rate); omitted = auto-scale to the data's own max. opts.format(v)
// renders y-axis labels. Deliberately a plain line (no fill/area) — this
// page's other charts (chBars, chCostChart) already cover bars; this fills
// the "a rate/mean trending over time" gap those don't fit well.
function chLine(items, opts) {
  opts = opts || {};
  const width = 640;
  const height = opts.height || 170;
  const padL = 48, padR = 8, padT = 10, padB = 20;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  let max = typeof opts.max === "number" ? opts.max : 0;
  if (typeof opts.max !== "number") {
    for (const it of items) {
      if (typeof it.value === "number" && it.value > max) max = it.value;
    }
  }
  if (max <= 0) max = 1;
  const n = items.length;
  const slot = n > 1 ? plotW / (n - 1) : plotW;
  const steps = 4;
  let out = '<svg viewBox="0 0 ' + width + " " + height + '" width="100%" style="max-width:640px;height:auto" role="img">';
  for (let i = 0; i <= steps; i++) {
    const v = (max * i) / steps;
    const y = padT + plotH - (plotH * i) / steps;
    out += '<line x1="' + padL + '" y1="' + y + '" x2="' + (width - padR) + '" y2="' + y + '" stroke="currentColor" stroke-opacity="0.12"/>';
    out += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end" font-size="9" fill="currentColor" fill-opacity="0.7">' +
      esc(opts.format ? opts.format(v) : Math.round(v)) + "</text>";
  }
  const pts = [];
  items.forEach(function (it, i) {
    const x = n > 1 ? padL + i * slot : padL + plotW / 2;
    const v = typeof it.value === "number" ? it.value : 0;
    const y = padT + plotH - (plotH * Math.min(v, max)) / max;
    pts.push(x.toFixed(1) + "," + y.toFixed(1));
  });
  if (pts.length > 1) {
    out += '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + (opts.color || "#1a7f37") + '" stroke-width="1.5"/>';
  }
  items.forEach(function (it, i) {
    const x = n > 1 ? padL + i * slot : padL + plotW / 2;
    const v = typeof it.value === "number" ? it.value : 0;
    const y = padT + plotH - (plotH * Math.min(v, max)) / max;
    out += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2.5" fill="' + (opts.color || "#1a7f37") + '"><title>' +
      esc(it.title || (it.label + ": " + (opts.format ? opts.format(v) : v))) + "</title></circle>";
    if (n <= 24) {
      out += '<text x="' + x.toFixed(1) + '" y="' + (height - 6) + '" text-anchor="middle" font-size="8.5" fill="currentColor" fill-opacity="0.7">' + esc(it.label) + "</text>";
    }
  });
  out += "</svg>";
  return out;
}

// Spend per round (bars) + cumulative spend (line on a 0..total scale).
function chCostChart(asc) {
  const width = 640, height = 170;
  const padL = 48, padR = 8, padT = 10, padB = 20;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  let max = 0;
  let total = 0;
  for (const g of asc) {
    if (g.costUsd > max) max = g.costUsd;
    total += g.costUsd;
  }
  if (max <= 0) max = 1;
  const n = asc.length;
  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.max(2, slot * 0.5);
  const steps = 4;
  let out = '<svg viewBox="0 0 ' + width + " " + height + '" width="100%" style="max-width:640px;height:auto" role="img">';
  for (let i = 0; i <= steps; i++) {
    const v = (max * i) / steps;
    const y = padT + plotH - (plotH * i) / steps;
    out += '<line x1="' + padL + '" y1="' + y + '" x2="' + (width - padR) + '" y2="' + y + '" stroke="currentColor" stroke-opacity="0.12"/>';
    out += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end" font-size="9" fill="currentColor" fill-opacity="0.7">$' + v.toFixed(2) + "</text>";
  }
  const pts = [];
  let cum = 0;
  asc.forEach(function (g, i) {
    cum += g.costUsd;
    const cx = padL + i * slot + slot / 2;
    const cy = padT + plotH - (plotH * cum) / (total > 0 ? total : 1);
    pts.push(cx.toFixed(1) + "," + cy.toFixed(1));
    const x = padL + i * slot + (slot - barW) / 2;
    const h = Math.max(1, (plotH * g.costUsd) / max);
    const y = padT + plotH - h;
    out += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" fill="#8250df"><title>' + esc(chGroupLabel(g)) + ": " + chCost(g.costUsd) + "</title></rect>";
    if (n <= 24) {
      out += '<text x="' + (x + barW / 2).toFixed(1) + '" y="' + (height - 6) + '" text-anchor="middle" font-size="8.5" fill="currentColor" fill-opacity="0.7">' + esc(chGroupLabel(g)) + "</text>";
    }
  });
  if (pts.length > 1) {
    out += '<polyline points="' + pts.join(" ") + '" fill="none" stroke="#1a7f37" stroke-width="1.5"><title>cumulative spend</title></polyline>';
  }
  out += "</svg>";
  return out;
}

// Token usage per round: grouped bars for input / output / cached + gold dots
// for the cache-hit rate (cached ÷ input) on the same 0..max scale.
function chTokensChart(asc) {
  const width = 640, height = 170;
  const padL = 48, padR = 8, padT = 10, padB = 20;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  let max = 0;
  for (const g of asc) {
    const t = Math.max(g.inputTokens || 0, g.outputTokens || 0, g.cachedTokens || 0);
    if (t > max) max = t;
  }
  if (max <= 0) max = 1;
  const n = asc.length;
  const slot = n > 0 ? plotW / n : plotW;
  const groupW = Math.max(3, slot * 0.7);
  const barW = Math.max(1, groupW / 3 - 1);
  const steps = 4;
  let out = '<svg viewBox="0 0 ' + width + " " + height + '" width="100%" style="max-width:640px;height:auto" role="img">';
  for (let i = 0; i <= steps; i++) {
    const v = (max * i) / steps;
    const y = padT + plotH - (plotH * i) / steps;
    out += '<line x1="' + padL + '" y1="' + y + '" x2="' + (width - padR) + '" y2="' + y + '" stroke="currentColor" stroke-opacity="0.12"/>';
    out += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end" font-size="9" fill="currentColor" fill-opacity="0.7">' + esc(fmtInt(Math.round(v))) + "</text>";
  }
  const series = [
    { key: "inputTokens", color: "#8250df", name: "input" },
    { key: "outputTokens", color: "#1a7f37", name: "output" },
    { key: "cachedTokens", color: "#38bdf8", name: "cached" },
  ];
  asc.forEach(function (g, i) {
    const gx = padL + i * slot + (slot - groupW) / 2;
    series.forEach(function (s, j) {
      const v = g[s.key] || 0;
      const h = Math.max(1, (plotH * v) / max);
      const y = padT + plotH - h;
      const x = gx + j * (barW + 1);
      out += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + s.color + '"><title>' + esc(s.name) + " · " + esc(chGroupLabel(g)) + ": " + fmtInt(v) + "</title></rect>";
    });
    const rate = g.inputTokens > 0 ? (g.cachedTokens || 0) / g.inputTokens : 0;
    const cx = padL + i * slot + slot / 2;
    const cy = padT + plotH - plotH * rate;
    out += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="2.5" fill="#b8860b"><title>cache hit rate ' + fmtPct(rate * 100) + "</title></circle>";
    if (n <= 24) {
      out += '<text x="' + (padL + i * slot + slot / 2).toFixed(1) + '" y="' + (height - 6) + '" text-anchor="middle" font-size="8.5" fill="currentColor" fill-opacity="0.7">' + esc(chGroupLabel(g)) + "</text>";
    }
  });
  out += "</svg>";
  return out;
}

function chChip(label, value, cls) {
  return '<span class="ch-chip' + (cls ? " " + cls : "") + '"><span class="ch-chip-label">' + esc(label) + '</span><span class="ch-chip-value">' + esc(value) + "</span></span>";
}

async function loadCostHistory() {
  const el = costHistoryEl;
  if (!el) return;
  const repo = chRepo();
  if (!repo) {
    el.innerHTML = '<div class="empty">enter a workspace path in the file browser above (or start the dashboard with --repo) to load cost history</div>';
    return;
  }
  try {
    const res = await fetch("/api/cost-history?repo=" + encodeURIComponent(repo));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderCostHistory(data);
  } catch (err) {
    el.innerHTML = '<div class="empty">failed to load cost history: ' + esc(err) + "</div>";
  }
}

function renderCostHistory(data) {
  const el = costHistoryEl;
  if (!el) return;
  const groups = data.groups || [];
  const sessions = data.sessions || [];
  el.innerHTML = "";
  if (groups.length === 0 && sessions.length === 0) {
    el.innerHTML = '<div class="empty">no cost history recorded for this repo yet — per-round records appear once an orchestrated round reaches a terminal status</div>';
    return;
  }
  // Charts read oldest → newest; the server returns newest-first.
  const asc = groups.slice().sort(function (a, b) {
    return a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0;
  });
  const totalCost = groups.reduce(function (s, g) { return s + g.costUsd; }, 0);
  const totalMs = groups.reduce(function (s, g) { return s + (g.wallClockMs || 0); }, 0);
  const totalIter = groups.reduce(function (s, g) { return s + (g.iterations || 0); }, 0);
  const wasted = sessions.filter(function (r) { return r.status !== "success"; });
  const wastedCost = wasted.reduce(function (s, r) { return s + r.costUsd; }, 0);

  const chips = document.createElement("div");
  chips.className = "ch-chips";
  chips.innerHTML =
    chChip("rounds", fmtInt(groups.length)) +
    chChip("total spend", chCost(totalCost)) +
    chChip("wall-clock", chDuration(totalMs)) +
    chChip("iterations", fmtInt(totalIter)) +
    chChip("wasted sessions", fmtInt(wasted.length) + " · " + chCost(wastedCost), wasted.length ? "ch-wasted" : "");
  el.appendChild(chips);

  const costBlock = document.createElement("div");
  costBlock.className = "ch-block";
  costBlock.innerHTML = '<div class="ch-block-title">Spend over time</div>' +
    '<div class="ch-block-sub">cost per round (bars) + cumulative spend (line); rounds labeled by issue number(s).</div>' +
    chCostChart(asc);
  el.appendChild(costBlock);

  const tokBlock = document.createElement("div");
  tokBlock.className = "ch-block";
  tokBlock.innerHTML = '<div class="ch-block-title">Token usage per round</div>' +
    '<div class="ch-block-sub">input / output / cached bars; gold dot per round = cache-hit rate (cached ÷ input) — a useful efficiency signal.</div>' +
    chTokensChart(asc);
  el.appendChild(tokBlock);

  const wallItems = asc.map(function (g) {
    return {
      label: chGroupLabel(g),
      value: g.wallClockMs || 0,
      color: "#4f9cf9",
      title: chGroupLabel(g) + ": " + chDuration(g.wallClockMs),
    };
  });
  const wallBlock = document.createElement("div");
  wallBlock.className = "ch-block";
  wallBlock.innerHTML = '<div class="ch-block-title">Wall-clock time to completion per round</div>' +
    '<div class="ch-block-sub">dispatch (first session start) → recorded (terminal status). "?" = no start timestamp (records from before that field existed).</div>' +
    chBars(wallItems, { format: chDuration });
  el.appendChild(wallBlock);

  const iterItems = asc.map(function (g) {
    return {
      label: chGroupLabel(g),
      value: g.iterations || 0,
      color: "#f59e0b",
      title: chGroupLabel(g) + ": " + fmtInt(g.iterations) + " iterations · " + fmtInt(g.continuationCount || 0) + " continuations · " + fmtInt(g.reworkCount || 0) + " reworks",
    };
  });
  const iterBlock = document.createElement("div");
  iterBlock.className = "ch-block";
  iterBlock.innerHTML = '<div class="ch-block-title">Iterations per round</div>' +
    '<div class="ch-block-sub">hover a bar for continuation/rework counts — a proxy for how much friction the round hit.</div>' +
    chBars(iterItems, {});
  el.appendChild(iterBlock);

  // Wasted-spend breakdown, from the per-session records (same definition the
  // cost-history CLI's summary line uses: any non-success outcome).
  if (wasted.length > 0) {
    const byStatus = {};
    for (const r of wasted) {
      byStatus[r.status] = byStatus[r.status] || { count: 0, cost: 0 };
      byStatus[r.status].count += 1;
      byStatus[r.status].cost += r.costUsd;
    }
    let wasteRows = "";
    for (const st of ["error", "budget", "killed"]) {
      const info = byStatus[st];
      if (!info) continue;
      wasteRows += '<tr><td class="status-' + esc(st) + '">' + esc(st) + "</td><td>" + fmtInt(info.count) + "</td><td>" + chCost(info.cost) + "</td></tr>";
    }
    const wasteBlock = document.createElement("div");
    wasteBlock.className = "ch-block";
    wasteBlock.innerHTML = '<div class="ch-block-title">Wasted-spend breakdown</div>' +
      '<div class="ch-block-sub">sessions that ended error / budget / killed — spend that produced no completed-round outcome on its own.</div>' +
      '<div class="ch-table-wrap"><table><thead><tr><th>status</th><th>sessions</th><th>cost</th></tr></thead><tbody>' + wasteRows + "</tbody></table></div>";
    el.appendChild(wasteBlock);
  }

  // Full per-round table (the CLI table's data, browsable).
  const rows = asc.map(function (g) {
    return "<tr>" +
      "<td>" + esc(g.groupName) + "</td>" +
      '<td class="mono">' + esc(chGroupLabel(g)) + "</td>" +
      '<td class="status-' + esc(g.status) + '">' + esc(g.status) + "</td>" +
      "<td>" + chCost(g.costUsd) + "</td>" +
      "<td>" + fmtInt(g.iterations || 0) + "</td>" +
      "<td>" + chDuration(g.wallClockMs) + "</td>" +
      "<td>" + fmtInt(g.continuationCount || 0) + "</td>" +
      "<td>" + fmtInt(g.reworkCount || 0) + "</td>" +
      '<td class="mono">' + esc(g.recordedAt) + "</td>" +
      "</tr>";
  }).join("");
  const tableBlock = document.createElement("div");
  tableBlock.className = "ch-block";
  tableBlock.innerHTML = '<div class="ch-block-title">Rounds</div>' +
    '<div class="ch-table-wrap"><table><thead><tr><th>group</th><th>issues</th><th>status</th><th>cost</th><th>iter</th><th>time</th><th>cont</th><th>rework</th><th>recorded</th></tr></thead>' +
    "<tbody>" + rows + "</tbody></table></div>";
  el.appendChild(tableBlock);
}

// ── Self-improvement progress (issue #145) ──────────────────────────────────
// Recursive self-improvement loop metrics: session outcome/efficiency trends
// from this repo's own .headlesscode/usage/*.jsonl, standing guardrails
// landed from git log, issue lifecycle from "gh issue list" — served by
// GET /api/self-improvement?repo=<path> (see self-improvement-metrics.ts for
// the computation). Local-machine only, per direct product direction
// (2026-08-21): no external dashboard, this page IS the dashboard.

function siFmtHour(iso) {
  const d = new Date(iso);
  const mo = d.toLocaleString(undefined, { month: "short" });
  return mo + " " + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":00";
}

function siFmtPct(v) {
  return Math.round(v * 100) + "%";
}

async function loadSelfImprovement() {
  const el = selfImprovementEl;
  if (!el) return;
  const repo = chRepo();
  if (!repo) {
    el.innerHTML = '<div class="empty">enter a workspace path in the file browser above (or start the dashboard with --repo) to load self-improvement metrics</div>';
    return;
  }
  try {
    const res = await fetch("/api/self-improvement?repo=" + encodeURIComponent(repo));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderSelfImprovement(data);
  } catch (err) {
    el.innerHTML = '<div class="empty">failed to load self-improvement metrics: ' + esc(err) + "</div>";
  }
}

function renderSelfImprovement(data) {
  const el = selfImprovementEl;
  if (!el) return;
  el.innerHTML = "";
  if (!data.totalSessions) {
    el.innerHTML = '<div class="empty">no session records yet for this repo — run a session (any mode) to start building history</div>';
    return;
  }

  const lifecycle = data.issueLifecycle;
  const chips = document.createElement("div");
  chips.className = "ch-chips";
  chips.innerHTML =
    chChip("sessions", fmtInt(data.totalSessions)) +
    chChip("overall success rate", siFmtPct(data.overallSuccessRate), data.overallSuccessRate < 0.5 ? "ch-wasted" : "") +
    chChip("standing guardrails landed", fmtInt(data.standingGuardrails.totalCount)) +
    (lifecycle
      ? chChip("issues open / closed", fmtInt(lifecycle.currentOpenCount) + " / " + fmtInt(lifecycle.currentClosedCount))
      : chChip("issue lifecycle", "gh unavailable"));
  el.appendChild(chips);

  const outcomeItems = data.sessionOutcomesByHour.map(function (b) {
    return { label: siFmtHour(b.hour), value: b.successRate, title: siFmtHour(b.hour) + ": " + siFmtPct(b.successRate) + " (" + b.success + "/" + b.total + ")" };
  });
  const outcomeBlock = document.createElement("div");
  outcomeBlock.className = "ch-block";
  outcomeBlock.innerHTML = '<div class="ch-block-title">Session success rate over time</div>' +
    '<div class="ch-block-sub">the most direct "is it working" signal — % of dispatched sessions reaching real completion, per hour.</div>' +
    chLine(outcomeItems, { max: 1, format: siFmtPct });
  el.appendChild(outcomeBlock);

  const volItems = data.sessionVolumeByHour.map(function (b) {
    return { label: siFmtHour(b.hour), value: b.count, title: siFmtHour(b.hour) + ": " + b.count + " session(s)", color: "#4f9cf9" };
  });
  const volBlock = document.createElement("div");
  volBlock.className = "ch-block";
  volBlock.innerHTML = '<div class="ch-block-title">Session volume over time</div>' +
    '<div class="ch-block-sub">activity level — read the success-rate chart above against this: a spike on 2 sessions means less than one on 20.</div>' +
    chBars(volItems);
  el.appendChild(volBlock);

  const iterItems = data.iterationEfficiencyByHour.map(function (b) {
    return { label: siFmtHour(b.hour), value: b.meanIterations, title: siFmtHour(b.hour) + ": " + b.meanIterations.toFixed(1) + " mean iterations (" + b.successCount + " successes)" };
  });
  const iterBlock = document.createElement("div");
  iterBlock.className = "ch-block";
  iterBlock.innerHTML = '<div class="ch-block-title">Iteration efficiency (successful sessions only)</div>' +
    '<div class="ch-block-sub">mean iterations to reach a real completion — trending down means the model is getting more direct, not just more numerous.</div>' +
    chLine(iterItems, { color: "#8250df" });
  el.appendChild(iterBlock);

  const guardItems = data.standingGuardrails.cumulativeByHour.map(function (b) {
    return { label: siFmtHour(b.hour), value: b.cumulative, title: siFmtHour(b.hour) + ": " + b.cumulative + " cumulative guardrail commit(s)" };
  });
  const guardBlock = document.createElement("div");
  guardBlock.className = "ch-block";
  guardBlock.innerHTML = '<div class="ch-block-title">Standing guardrails landed (cumulative)</div>' +
    '<div class="ch-block-sub">commits referencing a real issue number — a proxy for "the system is learning from its own failures" (each fix still human/Claude-authored today).</div>' +
    (guardItems.length ? chLine(guardItems, { color: "#c0392b" }) : '<div class="empty">no guardrail commits found</div>');
  el.appendChild(guardBlock);

  if (lifecycle && lifecycle.hours.length) {
    const lifeItems = lifecycle.hours.map(function (h) {
      return { label: siFmtHour(h.hour), value: h.filed, title: siFmtHour(h.hour) + ": " + h.filed + " filed, " + h.closed + " closed" };
    });
    const lifeBlock = document.createElement("div");
    lifeBlock.className = "ch-block";
    lifeBlock.innerHTML = '<div class="ch-block-title">Issues filed over time</div>' +
      '<div class="ch-block-sub">' + fmtInt(lifecycle.totalTracked) + ' issues tracked total on this repo (via gh issue list).</div>' +
      chBars(lifeItems, { color: "#f0883e" });
    el.appendChild(lifeBlock);
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
// Chat-thread vs. flat event-log vs. timeline toggle: all three render the
// same feed data, just shaped differently.
document.getElementById("tabLog").addEventListener("click", () => setView("log"));
document.getElementById("tabChat").addEventListener("click", () => setView("chat"));
document.getElementById("tabTimeline").addEventListener("click", () => setView("timeline"));
document.getElementById("btnRestore").addEventListener("click", restoreSelected);

document.getElementById("fbLoad").addEventListener("click", fbLoad);
// Enter in the file-browser repo box loads too.
document.getElementById("fbRepo").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    fbLoad();
  }
});
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
loadPermissions();
loadModes();
loadCostHistory();
loadSelfImprovement();
setInterval(poll, 4000);
// Live event feed poll: faster than the summary poll (1.5s) so the detail
// view feels live, and only runs while a detail view is open.
setInterval(pollEvents, 1500);
</script>
</body>
</html>
`
}
