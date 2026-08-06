/**
 * Cost estimation from recorded cost history (issue #16) — the "future half"
 * of cost-history.ts: once enough groups have reached a terminal status and
 * been recorded, use those records to estimate the likely cost of a NEW task
 * before spawning it.
 *
 * Matching signal is the issue SHAPE (split.ts's issueShape: hot / split /
 * coverage / test / docs / refactor / generic), which split.ts already uses
 * to batch same-shape mechanical work — an issue whose shape matches past
 * ones inherits their recorded cost profile. A STRONGER signal is an exact
 * issue-number match (the same task was worked on in a previous round) and
 * always wins when present.
 *
 * Estimation is deliberately rough and honest about data scarcity: a shape
 * needs at least MIN_SHAPE_SAMPLES recorded groups before a numeric estimate
 * is offered (below that, the dry-run prints "insufficient data (N
 * sample(s))"), because a 1-2 sample median is not an estimate, it's an
 * anecdote — the issue itself says to revisit "once a meaningful number of
 * records exist". Historical records are per-GROUP totals that can span
 * several issues, so costs/iterations are normalized per-issue
 * (total / max(issues.length, 1)) before matching against a NEW issue.
 *
 * Pure functions (no fs, no network) — fully unit-testable; the only I/O is
 * readCostHistory() at the call site (cli.ts's dry-run).
 */

import type { CostHistoryRecord } from "./cost-history.js"
import { issueShape, type SplitIssue, type WorktreeSpec } from "./split.js"

/**
 * Minimum recorded groups of a shape before a numeric cost/iteration
 * estimate is offered. Below this the estimate is suppressed in favor of an
 * explicit "insufficient data" note. Exact issue-number matches (direct
 * history of the SAME task) are exempt — one record of the very task being
 * estimated is meaningful on its own.
 */
export const MIN_SHAPE_SAMPLES = 3

/** Per-shape aggregate over recorded history (one per distinct shape seen). */
export interface ShapeStats {
	shape: string
	/** Distinct recorded groups carrying this shape (a mixed-shape group counts once per shape). */
	samples: number
	/** Min / median / max of the groups' raw combined cost, USD. */
	costMinUsd: number
	costMedianUsd: number
	costMaxUsd: number
	/**
	 * Median of costUsd / max(issues.length, 1) — per-issue normalized, since
	 * a recorded group can span several issues and a NEW issue is one issue.
	 */
	costPerIssueMedianUsd: number
	/** Median of the groups' raw iteration counts. */
	iterationsMedian: number
	/** Mean auto-continuation cycles per group (worker hit the iteration cap and was re-spawned). */
	continuationRate: number
	/** Mean review-rework cycles per group (reviewer found issues, worker was re-spawned to fix them). */
	reworkRate: number
}

/** A single new issue's estimate, matched to recorded history. */
export interface IssueEstimate {
	issue: number
	shape: string
	/**
	 * "direct" — this exact issue number appears in a past record (strongest
	 * signal, always usable); "shape" — matched via issueShape, usable only
	 * when samples >= MIN_SHAPE_SAMPLES; "none" — no matching history at all.
	 */
	match: "direct" | "shape" | "none"
	/** Recorded groups behind this estimate (0 when match === "none"). */
	samples: number
	/** Median normalized per-issue cost, USD. Undefined when not usable / no match. */
	costPerIssueUsd?: number
	/** [min, max] of the same normalized per-issue cost — the range of what a single issue actually cost. */
	costPerIssueRangeUsd?: [number, number]
	/** Median normalized per-issue iterations. */
	iterationsPerIssue?: number
	iterationsPerIssueRange?: [number, number]
	/** Mean continuation cycles per group among the matched records. */
	continuationRate?: number
	/** Mean rework cycles per group among the matched records. */
	reworkRate?: number
}

/** A whole dry-run group's estimate — the sum of its issues' per-issue estimates. */
export interface GroupEstimate {
	name: string
	issues: number[]
	/** Distinct shapes in the group, first-seen order (the dry-run shape label). */
	shapes: string[]
	/** Per-issue estimates, same order as `issues`. */
	perIssue: IssueEstimate[]
	/** Sum of per-issue median cost. Undefined when NO issue has usable history. */
	expectedCostUsd?: number
	/** [sum of per-issue min, sum of per-issue max] — the "rough range" the issue asks for. */
	costRangeUsd?: [number, number]
	/** Sum of per-issue median iterations. */
	expectedIterations?: number
	iterationsRange?: [number, number]
	/** Mean of the per-issue continuation/rework rates (cycles per group). */
	continuationRate?: number
	reworkRate?: number
	/** Issues with no usable history (excluded from the sums above). */
	unmatched: number
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	if (sorted.length === 0) {
		return 0
	}
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** min/median/max of a non-empty list (0,0,0 for an empty list). */
function minMedMax(values: number[]): [number, number, number] {
	if (values.length === 0) {
		return [0, 0, 0]
	}
	return [Math.min(...values), median(values), Math.max(...values)]
}

/** A record's per-issue cost/iterations (a group record can span several issues). */
function perIssueCost(record: CostHistoryRecord): number {
	return record.costUsd / Math.max(1, (record.issues ?? []).length)
}

function perIssueIterations(record: CostHistoryRecord): number {
	return (record.iterations ?? 0) / Math.max(1, (record.issues ?? []).length)
}

function mean(values: number[]): number {
	if (values.length === 0) {
		return 0
	}
	return values.reduce((sum, v) => sum + v, 0) / values.length
}

/** Summarize a set of same-shape records into ShapeStats. */
function summarize(shape: string, records: CostHistoryRecord[]): ShapeStats {
	const [costMinUsd, costMedianUsd, costMaxUsd] = minMedMax(records.map((r) => r.costUsd))
	return {
		shape,
		samples: records.length,
		costMinUsd,
		costMedianUsd,
		costMaxUsd,
		costPerIssueMedianUsd: median(records.map(perIssueCost)),
		iterationsMedian: median(records.map((r) => r.iterations ?? 0)),
		continuationRate: mean(records.map((r) => r.continuationCount ?? 0)),
		reworkRate: mean(records.map((r) => r.reworkCount ?? 0)),
	}
}

/**
 * Aggregate recorded history by issue shape. A record with several shapes
 * (a mixed-shape group) contributes to EACH of them — it is evidence about
 * every kind of work it covered. Records with no `shapes` (written before
 * issue #16's field existed) contribute to nothing and are skipped.
 * Returns shapes sorted by sample count (descending), then name.
 */
export function aggregateByShape(records: CostHistoryRecord[]): ShapeStats[] {
	const byShape = new Map<string, CostHistoryRecord[]>()
	for (const record of records) {
		for (const shape of new Set(record.shapes ?? [])) {
			const list = byShape.get(shape) ?? []
			list.push(record)
			byShape.set(shape, list)
		}
	}
	return [...byShape.entries()]
		.map(([shape, list]) => summarize(shape, list))
		.sort((a, b) => b.samples - a.samples || a.shape.localeCompare(b.shape))
}

/** Estimate one new issue from recorded history. */
export function estimateIssue(records: CostHistoryRecord[], issueNumber: number, shape: string): IssueEstimate {
	// Exact issue-number history is the strongest signal — the same task ran
	// before (e.g. a re-opened issue, or an issue batched in a prior round).
	const direct = records.filter((r) => (r.issues ?? []).includes(issueNumber))
	if (direct.length > 0) {
		return issueEstimateFrom(issueNumber, shape, "direct", direct)
	}
	const byShape = records.filter((r) => (r.shapes ?? []).includes(shape))
	if (byShape.length >= MIN_SHAPE_SAMPLES) {
		return issueEstimateFrom(issueNumber, shape, "shape", byShape)
	}
	return {
		issue: issueNumber,
		shape,
		match: byShape.length > 0 ? "shape" : "none",
		samples: byShape.length,
	}
}

function issueEstimateFrom(issueNumber: number, shape: string, match: IssueEstimate["match"], records: CostHistoryRecord[]): IssueEstimate {
	const [costLo, costMed, costHi] = minMedMax(records.map(perIssueCost))
	const [iterLo, iterMed, iterHi] = minMedMax(records.map(perIssueIterations))
	return {
		issue: issueNumber,
		shape,
		match,
		samples: records.length,
		costPerIssueUsd: costMed,
		costPerIssueRangeUsd: [costLo, costHi],
		iterationsPerIssue: iterMed,
		iterationsPerIssueRange: [iterLo, iterHi],
		continuationRate: mean(records.map((r) => r.continuationCount ?? 0)),
		reworkRate: mean(records.map((r) => r.reworkCount ?? 0)),
	}
}

function sum(values: number[]): number {
	return values.reduce((acc, v) => acc + v, 0)
}

/** Combine a spec's per-issue estimates into a group-level estimate. */
export function estimateGroup(spec: WorktreeSpec, perIssue: IssueEstimate[]): GroupEstimate {
	const usable = perIssue.filter((e) => e.costPerIssueUsd !== undefined && e.iterationsPerIssue !== undefined)
	const costs = usable.map((e) => e.costPerIssueUsd ?? 0)
	const iters = usable.map((e) => e.iterationsPerIssue ?? 0)
	const withRates = usable.filter((e) => e.continuationRate !== undefined && e.reworkRate !== undefined)
	const costLo = sum(usable.map((e) => e.costPerIssueRangeUsd?.[0] ?? 0))
	const costHi = sum(usable.map((e) => e.costPerIssueRangeUsd?.[1] ?? 0))
	const iterLo = sum(usable.map((e) => e.iterationsPerIssueRange?.[0] ?? 0))
	const iterHi = sum(usable.map((e) => e.iterationsPerIssueRange?.[1] ?? 0))
	const estimate: GroupEstimate = {
		name: spec.name,
		issues: spec.issues,
		shapes: [...new Set(perIssue.map((e) => e.shape))],
		perIssue,
		unmatched: perIssue.length - usable.length,
	}
	if (usable.length > 0) {
		estimate.expectedCostUsd = sum(costs)
		estimate.costRangeUsd = [costLo, costHi]
		estimate.expectedIterations = sum(iters)
		estimate.iterationsRange = [iterLo, iterHi]
	}
	if (withRates.length > 0) {
		estimate.continuationRate = mean(withRates.map((e) => e.continuationRate ?? 0))
		estimate.reworkRate = mean(withRates.map((e) => e.reworkRate ?? 0))
	}
	return estimate
}

/**
 * Estimate every dry-run group from recorded history. Shapes are computed
 * from the loaded issues (the only place titles/bodies exist for NEW work);
 * a number without a loaded issue falls back to "generic".
 */
export function estimateGroups(records: CostHistoryRecord[], specs: WorktreeSpec[], issues: SplitIssue[]): GroupEstimate[] {
	const shapes = new Map<number, string>()
	for (const issue of issues) {
		shapes.set(issue.number, issueShape(issue))
	}
	return specs.map((spec) => {
		const perIssue = spec.issues.map((n) => estimateIssue(records, n, shapes.get(n) ?? "generic"))
		return estimateGroup(spec, perIssue)
	})
}

function formatUsd(value: number): string {
	return `$${value.toFixed(4)}`
}

function formatRate(value: number | undefined): string {
	return value === undefined ? "?" : value.toFixed(1)
}

/**
 * Human-readable dry-run section lines (one per group, "rough" by design).
 * `historyRecordCount` is the total recorded groups; 0 means the section is
 * a single "no history yet" note rather than N identical per-group ones.
 */
export function buildEstimateSection(estimates: GroupEstimate[], historyRecordCount: number): string[] {
	if (historyRecordCount === 0) {
		return ["no cost history recorded yet — estimates appear once groups reach a terminal status (cost-history.ts)"]
	}
	const lines: string[] = []
	for (const group of estimates) {
		const issuesLabel = group.issues.join(", ")
		const shapeLabel = group.shapes.join("/")
		if (group.expectedCostUsd !== undefined && group.costRangeUsd && group.expectedIterations !== undefined) {
			const [costLo, costHi] = group.costRangeUsd
			const [iterLo, iterHi] = group.iterationsRange ?? [group.expectedIterations, group.expectedIterations]
			const samples = Math.max(0, ...group.perIssue.map((e) => e.samples))
			let line =
				`${group.name} (issues ${issuesLabel} — ${shapeLabel}): expected ~${formatUsd(costLo)}–${formatUsd(costHi)} · ` +
				`~${iterLo}–${iterHi} iterations · ${samples} sample(s)`
			if (group.unmatched > 0) {
				line += ` (${group.unmatched} issue(s) unmatched)`
			}
			lines.push(line)
			lines.push(
				`       continuation/rework: ${formatRate(group.continuationRate)} / ${formatRate(group.reworkRate)} cycles per group avg`,
			)
		} else {
			const withData = group.perIssue.filter((e) => e.match !== "none")
			if (withData.length > 0) {
				const samples = Math.max(...withData.map((e) => e.samples))
				lines.push(
					`${group.name} (issues ${issuesLabel} — ${shapeLabel}): insufficient data (${samples} sample(s), need ${MIN_SHAPE_SAMPLES}) — no estimate yet`,
				)
			} else {
				lines.push(`${group.name} (issues ${issuesLabel} — ${shapeLabel}): no history for this shape yet`)
			}
		}
	}
	return lines
}
