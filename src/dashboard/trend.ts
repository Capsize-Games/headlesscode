/**
 * Cross-repo cost-efficiency trend — `headlesscode trend --repo <a> --repo <b> ...`.
 *
 * The single-repo dashboard's "Cost history" section (issue #29) already
 * charts one repo's rounds. This is a different question: comparing
 * multiple repos side by side, and surfacing whether the harness is
 * getting more or less efficient over time, computed FRESH from
 * cost-history.jsonl / session-cost-history.jsonl on every request (no
 * cached snapshot) so the page reflects live data as new rounds settle.
 *
 * Deliberately data-driven, not hardcoded to specific issue numbers: the
 * insight bullets below are generic computations (wasted-session
 * clustering, cost/iteration vs. round-size correlation, rework rate,
 * per-repo averages) that keep making sense as new rounds accumulate,
 * rather than prose written for one particular investigation.
 */

import * as http from "node:http"
import * as path from "node:path"

import { readCostHistory, readSessionCostHistory, type CostHistoryRecord, type SessionCostRecord } from "../orchestrator/cost-history.js"

export interface TrendPoint {
	recordedAt: string
	groupName: string
	issues: number[]
	costUsd: number
	iterations: number
	/** $ per 1,000 iterations — normalizes cheap and expensive rounds onto one scale. */
	rate: number
	continuationCount: number
	reworkCount: number
	/** True when a non-success session was recorded at the same settle event (see matchWastedSessions). */
	wasted: boolean
	wastedNote?: string
}

export interface RepoTrend {
	name: string
	points: TrendPoint[]
	avgRate: number
	totalCost: number
	wastedCost: number
	wastedCount: number
}

export interface TrendData {
	repos: RepoTrend[]
	insights: string[]
	generatedAt: string
}

/** Pearson correlation coefficient; NaN-safe (returns 0 for degenerate input). */
function correlation(xs: number[], ys: number[]): number {
	const n = xs.length
	if (n < 2) {
		return 0
	}
	const meanX = xs.reduce((s, v) => s + v, 0) / n
	const meanY = ys.reduce((s, v) => s + v, 0) / n
	let num = 0
	let denX = 0
	let denY = 0
	for (let i = 0; i < n; i++) {
		const dx = xs[i] - meanX
		const dy = ys[i] - meanY
		num += dx * dy
		denX += dx * dx
		denY += dy * dy
	}
	const den = Math.sqrt(denX * denY)
	return den === 0 ? 0 : num / den
}

/** Group and session records at the same settle event land within this window of each other. */
const SETTLE_EVENT_WINDOW_MS = 30_000

/**
 * A group record is "wasted-adjacent" when a non-success session was
 * recorded at the SAME settle event. recordGroupCost + recordAllSessionCosts
 * both flush at group-settle time (see cost-history.ts) but stamp their OWN
 * `new Date().toISOString()` a few ms apart — never identical — so pairing
 * requires a small tolerance window, not an exact string match. Each group
 * record claims the closest same-groupName non-success session(s) within
 * that window; a session matched to one group record is not reused for
 * another.
 */
function buildTrendPoints(groups: CostHistoryRecord[], sessions: SessionCostRecord[]): TrendPoint[] {
	const wastedSessions = sessions.filter((s) => s.status !== "success")
	const claimed = new Set<SessionCostRecord>()
	return [...groups]
		.sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0))
		.map((g) => {
			const groupMs = Date.parse(g.recordedAt)
			const wasted = wastedSessions.filter(
				(s) =>
					!claimed.has(s) &&
					s.groupName === g.groupName &&
					Math.abs(Date.parse(s.recordedAt) - groupMs) <= SETTLE_EVENT_WINDOW_MS,
			)
			wasted.forEach((s) => claimed.add(s))
			return {
				recordedAt: g.recordedAt,
				groupName: g.groupName,
				issues: g.issues,
				costUsd: g.costUsd,
				iterations: g.iterations,
				rate: g.iterations > 0 ? (g.costUsd / g.iterations) * 1000 : 0,
				continuationCount: g.continuationCount,
				reworkCount: g.reworkCount,
				wasted: wasted.length > 0,
				wastedNote:
					wasted.length > 0
						? wasted.map((w) => `${w.mode} ${w.status} ($${w.costUsd.toFixed(4)}, ${w.iterations} iter)`).join("; ")
						: undefined,
			}
		})
}

export function computeTrendData(repos: Array<{ name: string; groups: CostHistoryRecord[]; sessions: SessionCostRecord[] }>): TrendData {
	const repoTrends: RepoTrend[] = repos.map(({ name, groups, sessions }) => {
		const points = buildTrendPoints(groups, sessions)
		const totalCost = points.reduce((s, p) => s + p.costUsd, 0)
		const avgRate = points.length > 0 ? points.reduce((s, p) => s + p.rate, 0) / points.length : 0
		const wastedSessions = sessions.filter((s) => s.status !== "success")
		return {
			name,
			points,
			avgRate,
			totalCost,
			wastedCost: wastedSessions.reduce((s, w) => s + w.costUsd, 0),
			wastedCount: wastedSessions.length,
		}
	})

	const insights: string[] = []

	// Wasted-session clustering: are they all in the past, or ongoing?
	const allWasted = repoTrends.flatMap((r) =>
		r.points.filter((p) => p.wasted).map((p) => ({ repo: r.name, ...p })),
	)
	if (allWasted.length > 0) {
		const totalWastedCost = repoTrends.reduce((s, r) => s + r.wastedCost, 0)
		const totalWastedCount = repoTrends.reduce((s, r) => s + r.wastedCount, 0)
		const lastWastedAt = allWasted.reduce((max, p) => (p.recordedAt > max ? p.recordedAt : max), allWasted[0].recordedAt)
		const roundsSince = repoTrends.reduce(
			(s, r) => s + r.points.filter((p) => p.recordedAt > lastWastedAt).length,
			0,
		)
		if (roundsSince > 0) {
			insights.push(
				`${totalWastedCount} wasted session(s) ($${totalWastedCost.toFixed(4)}) recorded, all before ${lastWastedAt} — zero wasted sessions in the ${roundsSince} round(s) recorded since. If that holds as more rounds land, whatever fix landed around then is working.`,
			)
		} else {
			insights.push(
				`${totalWastedCount} wasted session(s) ($${totalWastedCost.toFixed(4)}) recorded, most recently at ${lastWastedAt} — still an active source of waste; worth checking what those sessions have in common.`,
			)
		}
	} else {
		insights.push("No wasted sessions (session-level error/killed/budget outcomes) recorded in this data.")
	}

	// Cost/iteration vs. round size: does a bigger round cost MORE per iteration, not just more iterations?
	const allPoints = repoTrends.flatMap((r) => r.points)
	if (allPoints.length >= 4) {
		const corr = correlation(allPoints.map((p) => p.iterations), allPoints.map((p) => p.rate))
		if (corr > 0.35) {
			insights.push(
				`Cost per iteration correlates positively with round size (r=${corr.toFixed(2)} across ${allPoints.length} rounds) — larger rounds aren't just longer, each iteration gets more expensive too. Splitting oversized issues before dispatch likely helps more than tuning iteration count alone.`,
			)
		} else if (corr < -0.35) {
			insights.push(
				`Cost per iteration correlates negatively with round size (r=${corr.toFixed(2)}) — larger rounds are actually getting cheaper per iteration, possibly from cache-hit growth outpacing complexity.`,
			)
		}
	}

	// Rework rate.
	if (allPoints.length > 0) {
		const reworked = allPoints.filter((p) => p.reworkCount > 0).length
		insights.push(
			`${reworked}/${allPoints.length} round(s) (${((reworked / allPoints.length) * 100).toFixed(0)}%) needed at least one rework cycle.`,
		)
	}

	// Per-repo average comparison.
	if (repoTrends.length >= 2) {
		const sorted = [...repoTrends].filter((r) => r.points.length > 0).sort((a, b) => b.avgRate - a.avgRate)
		if (sorted.length >= 2) {
			const [highest, lowest] = [sorted[0], sorted[sorted.length - 1]]
			if (highest.name !== lowest.name && lowest.avgRate > 0) {
				const ratio = highest.avgRate / lowest.avgRate
				insights.push(
					`${highest.name} averages $${highest.avgRate.toFixed(3)}/1k-iter vs. ${lowest.name}'s $${lowest.avgRate.toFixed(3)}/1k-iter — ${ratio.toFixed(1)}x higher, consistent with ${highest.name} handling larger/less-familiar tasks.`,
				)
			}
		}
	}

	return { repos: repoTrends, insights, generatedAt: new Date().toISOString() }
}

export interface TrendServerOptions {
	port: number
	repos: string[]
}

async function loadTrendData(repoPaths: string[]): Promise<TrendData> {
	const repos = await Promise.all(
		repoPaths.map(async (repoPath) => {
			const [groups, sessions] = await Promise.all([readCostHistory(repoPath), readSessionCostHistory(repoPath)])
			return { name: path.basename(repoPath.replace(/\/$/, "")), groups, sessions }
		}),
	)
	return computeTrendData(repos)
}

export function startTrendServer(options: TrendServerOptions): Promise<http.Server> {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost")
			if (url.pathname === "/api/trend") {
				loadTrendData(options.repos)
					.then((data) => {
						res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
						res.end(JSON.stringify(data))
					})
					.catch((err) => {
						res.writeHead(500, { "content-type": "application/json; charset=utf-8" })
						res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
					})
				return
			}
			if (url.pathname === "/") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
				res.end(renderTrendPage(options.repos))
				return
			}
			res.writeHead(404, { "content-type": "text/plain" })
			res.end("not found")
		})
		server.on("error", reject)
		server.listen(options.port, "127.0.0.1", () => resolve(server))
	})
}

function renderTrendPage(repoPaths: string[]): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>headlesscode: cost-efficiency trend</title>
<style>
:root {
  color-scheme: light;
  --surface-1: #fcfcfb; --page: #f9f9f7; --text-primary: #0b0b0b; --text-secondary: #52514e;
  --text-muted: #898781; --grid: #e1e0d9; --baseline: #c3c2b7; --border: rgba(11,11,11,0.10);
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100;
  --status-critical: #d03b3b; --status-good: #0ca30c;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --surface-1: #1a1a19; --page: #0d0d0d; --text-primary: #ffffff; --text-secondary: #c3c2b7;
    --text-muted: #898781; --grid: #2c2c2a; --baseline: #383835; --border: rgba(255,255,255,0.10);
    --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
    --status-critical: #e66767; --status-good: #0ca30c;
  }
}
body { background: var(--page); color: var(--text-primary); margin: 0; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
.wrap { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--text-secondary); font-size: 14px; margin: 0 0 8px; }
.stamp { color: var(--text-muted); font-size: 12px; margin: 0 0 28px; }
.card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 20px; }
.card h2 { font-size: 15px; margin: 0 0 12px; }
svg { display: block; overflow: visible; }
.axis-label { fill: var(--text-muted); font-size: 10px; }
.gridline { stroke: var(--grid); stroke-width: 1; }
.baseline { stroke: var(--baseline); stroke-width: 1; }
.legend { display: flex; gap: 16px; font-size: 12px; color: var(--text-secondary); margin: 10px 0 2px; flex-wrap: wrap; }
.legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
.tooltip { position: fixed; pointer-events: none; z-index: 50; background: var(--text-primary); color: var(--surface-1);
  font-size: 12px; padding: 6px 9px; border-radius: 6px; line-height: 1.4; opacity: 0; transition: opacity 80ms; max-width: 260px; }
ul.insights { margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.6; }
ul.insights li { margin-bottom: 10px; }
.refresh-note { color: var(--text-muted); font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>headlesscode: cost-efficiency trend</h1>
  <p class="sub">Live from <code>cost-history.jsonl</code> across ${repoPaths.length} repo(s): ${repoPaths.map((p) => path.basename(p)).join(", ")}. Refreshes every 30s.</p>
  <p class="stamp" id="stamp">loading…</p>

  <div class="card">
    <h2>Cost per 1,000 iterations, chronological (all repos, own timeline each)</h2>
    <div id="chart-lines"></div>
    <div class="legend" id="legend-lines"></div>
  </div>

  <div class="card">
    <h2>Repo averages</h2>
    <div id="chart-bars"></div>
  </div>

  <div class="card">
    <h2>What the data says</h2>
    <ul class="insights" id="insights"></ul>
  </div>
</div>
<div class="tooltip" id="tooltip"></div>
<script>
const SERIES = ["var(--series-1)","var(--series-2)","var(--series-3)","var(--series-4)"];
const tooltip = document.getElementById("tooltip");
function showTip(evt, html) {
  tooltip.innerHTML = html;
  tooltip.style.opacity = 1;
  tooltip.style.left = (evt.clientX + 14) + "px";
  tooltip.style.top = (evt.clientY + 14) + "px";
}
function hideTip() { tooltip.style.opacity = 0; }
window.__tip = showTip;
window.__hidetip = hideTip;

function lineChart(el, legendEl, repos) {
  const W = 900, H = 240, padL = 44, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const allRates = repos.flatMap(r => r.points.map(p => p.rate));
  const maxY = (Math.max(1e-6, ...allRates)) * 1.15;
  const maxLen = Math.max(1, ...repos.map(r => r.points.length));
  const x = i => padL + (maxLen <= 1 ? 0 : (i / (maxLen - 1)) * plotW);
  const y = v => padT + plotH - (v / maxY) * plotH;

  let gridlines = "";
  for (let s = 0; s <= 4; s++) {
    const val = (maxY/4)*s, yy = y(val);
    gridlines += \`<line class="gridline" x1="\${padL}" x2="\${W-padR}" y1="\${yy}" y2="\${yy}"/>
      <text class="axis-label" x="\${padL-6}" y="\${yy+3}" text-anchor="end">\${val.toFixed(2)}</text>\`;
  }

  let body = "";
  repos.forEach((r, ri) => {
    const color = SERIES[ri % SERIES.length];
    if (r.points.length === 0) return;
    const pathD = r.points.map((p,i) => \`\${i===0?"M":"L"}\${x(i).toFixed(1)},\${y(p.rate).toFixed(1)}\`).join(" ");
    body += \`<path d="\${pathD}" fill="none" stroke="\${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>\`;
    body += r.points.map((p,i) => {
      const cx = x(i), cy = y(p.rate);
      const rad = p.wasted ? 5 : 3.5;
      const fill = p.wasted ? "var(--status-critical)" : color;
      const stroke = p.wasted ? \`stroke="var(--surface-1)" stroke-width="2"\` : "";
      const tip = \`<b>\${r.name} · \${p.groupName} · #\${p.issues.join(",")}</b><br>$\${p.costUsd.toFixed(4)} · \${p.iterations} iter · \${p.rate.toFixed(3)} $/1k-iter\${p.wasted ? "<br>wasted: " + p.wastedNote : ""}\`;
      return \`<circle cx="\${cx.toFixed(1)}" cy="\${cy.toFixed(1)}" r="\${rad}" fill="\${fill}" \${stroke}
        onmousemove='window.__tip(event, \${JSON.stringify(tip)})' onmouseleave='window.__hidetip()' style="cursor:pointer"/>\`;
    }).join("");
  });

  el.innerHTML = \`<svg viewBox="0 0 \${W} \${H}" width="100%" height="\${H}">
    \${gridlines}
    <line class="baseline" x1="\${padL}" x2="\${W-padR}" y1="\${padT+plotH}" y2="\${padT+plotH}"/>
    \${body}
  </svg>\`;

  legendEl.innerHTML = repos.map((r, ri) => \`<span><span class="dot" style="background:\${SERIES[ri % SERIES.length]}"></span>\${r.name}</span>\`).join("")
    + \`<span><span class="dot" style="background:var(--status-critical)"></span>wasted session</span>\`;
}

function barChart(el, repos) {
  const W = 500, H = 180, padL = 44, padR = 12, padT = 14, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxY = Math.max(1e-6, ...repos.map(r => r.avgRate)) * 1.2;
  const y = v => padT + plotH - (v / maxY) * plotH;
  const bw = plotW / Math.max(1, repos.length) * 0.4;
  let gridlines = "";
  for (let s = 0; s <= 4; s++) {
    const val = (maxY/4)*s, yy = y(val);
    gridlines += \`<line class="gridline" x1="\${padL}" x2="\${W-padR}" y1="\${yy}" y2="\${yy}"/>
      <text class="axis-label" x="\${padL-6}" y="\${yy+3}" text-anchor="end">\${val.toFixed(2)}</text>\`;
  }
  const bars = repos.map((r,i) => {
    const cx = padL + (i+0.5)/repos.length*plotW;
    const barY = y(r.avgRate), barH = (padT+plotH)-barY;
    const color = SERIES[i % SERIES.length];
    return \`<rect x="\${(cx-bw/2).toFixed(1)}" y="\${barY.toFixed(1)}" width="\${bw.toFixed(1)}" height="\${barH.toFixed(1)}" rx="4" fill="\${color}"/>
      <text class="axis-label" x="\${cx.toFixed(1)}" y="\${padT+plotH+16}" text-anchor="middle">\${r.name}</text>
      <text x="\${cx.toFixed(1)}" y="\${(barY-6).toFixed(1)}" text-anchor="middle" font-size="12" fill="var(--text-primary)" font-weight="600">\${r.avgRate.toFixed(3)}</text>\`;
  }).join("");
  el.innerHTML = \`<svg viewBox="0 0 \${W} \${H}" width="100%" height="\${H}">
    \${gridlines}
    <line class="baseline" x1="\${padL}" x2="\${W-padR}" y1="\${padT+plotH}" y2="\${padT+plotH}"/>
    \${bars}
  </svg>\`;
}

async function refresh() {
  try {
    const res = await fetch("/api/trend");
    const data = await res.json();
    document.getElementById("stamp").textContent = "last updated " + new Date(data.generatedAt).toLocaleString();
    lineChart(document.getElementById("chart-lines"), document.getElementById("legend-lines"), data.repos);
    barChart(document.getElementById("chart-bars"), data.repos);
    document.getElementById("insights").innerHTML = data.insights.map(t => "<li>" + t + "</li>").join("");
  } catch (err) {
    document.getElementById("stamp").textContent = "failed to load: " + err;
  }
}
refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`
}
