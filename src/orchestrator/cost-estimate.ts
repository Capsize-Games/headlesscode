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
 * Verification-intensity multiplier (issue #124): test-shaped issues (and
 * issues whose remediation mentions CI/GitHub Actions) are verification-
 * heavy — a diff that adds CI config forces real GitHub-runner round-trips,
 * which dominated round-2026-08-17's cost. The thin samples for those shapes
 * under-predicted ~2.6x (preflight ~$0.79 vs ~$2.09 actual; w13's test/hot
 * group estimated ~$0.05-$0.27, actual $1.03). A shape-match estimate's
 * COST is therefore scaled up until real samples accumulate — the recorded
 * median of a verification-heavy shape is not trusted as-is while its
 * samples are thin (see TEST_SHAPE_VERIFICATION_MULTIPLIER).
 *
 * Flagged CI/config higher bound (issue #125): complementary to the
 * verification multiplier above, but a SEPARATE mechanism — an issue whose
 * title/body itself names CI/config work (CI_CONFIG_RE) gets an additional
 * flagged higher-bound estimate (its per-issue median times
 * CI_CONFIG_HIGHER_BOUND_MULTIPLIER, rolled into the group's higherBoundUsd)
 * surfaced alongside — not instead of — the primary cost estimate, since
 * CI/test-infrastructure work historically costs 2-3x its shape median and
 * the plain shape estimate under-predicted rounds containing it
 * (round-2026-08-17: ~$0.79 estimated vs ~$2.09 actual).
 *
 * Issue #126: every group estimate carries a lowConfidence flag, set when
 * the estimate is built on thin or missing history (unmatched issues whose
 * cost is excluded from the total, an under-sampled direct match, or no
 * usable history at all) — buildEstimateSection renders it as a prominent
 * LOW-CONFIDENCE marker so preflight output can't present an unreliable
 * total as if it were solid.
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
 * estimated is meaningful on its own (though it counts as LOW-CONFIDENCE,
 * issue #126 — see estimateGroup).
 */
export const MIN_SHAPE_SAMPLES = 3

/**
 * Issue #124: multiplier applied to a verification-heavy issue's shape-match
 * COST estimate while that shape's recorded samples are thin (the observed
 * under-prediction was ~2.6x in round-2026-08-17, dominated by test/CI
 * shapes). Maintainers' discretion per the issue; 2.5 sits between the 2-3x
 * observed misses. Tapers toward 1 as real samples accumulate — the median
 * of a well-sampled verification-heavy shape already reflects real
 * verification cost.
 */
export const TEST_SHAPE_VERIFICATION_MULTIPLIER = 2.5

/**
 * Issue #124: the sample count at which the verification multiplier has
 * fully tapered to 1 (samples >= this are trusted as-is). Between
 * MIN_SHAPE_SAMPLES (full multiplier) and this (1.0) it tapers linearly.
 */
export const VERIFICATION_MULTIPLIER_FULL_SAMPLES = 6

/** CI/GitHub Actions mention in an issue's title/body — a signal that its
 * remediation is verification-heavy (real runner round-trips dominate cost). */
const CI_MENTION_RE = /(github\s*actions|\bci\b|workflow|runner|continuous\s+integration)/i

/**
 * CI/config-change keyword scan (issue #125). Matched against an issue's
 * title AND body; `\b` guards around "ci"/"actions" keep false positives
 * out ("transactions" contains "actions" but is not CI work — the observed
 * 2026-08-17 under-prediction was specifically rounds touching GitHub
 * Actions/workflow config, e.g. w13's `test/hot` group for issues #62/#90/
 * #98 which added .github/workflows and forced real runner round-trips).
 */
export const CI_CONFIG_RE = /(\bci\b|workflow|\bactions\b|runner)/i

/**
 * The flagged higher-bound multiplier for a CI/config-changing issue
 * (issue #125): round-2026-08-17's preflight under-predicted rounds
 * containing CI/test-infrastructure work by 2-3x (~$0.79 estimated vs
 * ~$2.09 actual), so the higher bound uses the top of that observed range.
 */
export const CI_CONFIG_HIGHER_BOUND_MULTIPLIER = 3

/** Whether an issue touches CI/config (title or body — see CI_CONFIG_RE). */
export function isCiConfigChange(issue: SplitIssue): boolean {
	return CI_CONFIG_RE.test(`${issue.title}\n${issue.body ?? ""}`)
}

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
	/**
	 * Issue #124: multiplier applied to a verification-heavy issue's COST
	 * (not iterations) while its shape's samples are thin — see
	 * TEST_SHAPE_VERIFICATION_MULTIPLIER. 1 when not verification-heavy,
	 * when samples >= VERIFICATION_MULTIPLIER_FULL_SAMPLES, or on a direct
	 * match (a direct record of the very task is trusted as-is).
	 */
	verificationMultiplier?: number
	/**
	 * The issue touches CI/config (title/body matches CI_CONFIG_RE, issue
	 * #125). CI work historically costs 2-3x its shape median — see
	 * higherBoundUsd.
	 */
	ciConfig?: boolean
	/**
	 * Flagged higher-bound per-issue cost for a CI/config change:
	 * costPerIssueUsd * CI_CONFIG_HIGHER_BOUND_MULTIPLIER. Only present when
	 * the issue is a CI/config change AND has usable history (issue #125).
	 */
	higherBoundUsd?: number
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
	/**
	 * Issue #124: the maximum per-issue verification multiplier among the
	 * group's USABLE (cost-bearing) estimates — i.e. the largest multiplier
	 * that actually scaled the group's expected cost. Undefined when no
	 * usable estimate was scaled: a multiplier recorded on an
	 * insufficient-data estimate never surfaces here, because it did not
	 * scale the displayed cost.
	 */
	verificationMultiplier?: number
	/**
	 * Issue #125: the flagged higher-bound group total — CI/config-changing
	 * issues contribute their higherBoundUsd, everything else its plain
	 * median. Only present when at least one usable CI/config issue exists.
	 */
	higherBoundUsd?: number
	/**
	 * Issue #126: the estimate is built on thin or missing history —
	 * unmatched issues (their cost is silently excluded from the total), a
	 * usable-but-under-sampled direct match (fewer than MIN_SHAPE_SAMPLES
	 * records of the same task), or NO usable history at all. Preflight
	 * renders this as a prominent LOW-CONFIDENCE marker.
	 */
	lowConfidence: boolean
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

/** Whether an issue's work is verification-heavy: test-shaped, or its
 * title/body mentions CI/GitHub Actions (a diff that adds CI config forces
 * real GitHub-runner round-trips, which dominated round-2026-08-17's cost). */
export function isVerificationHeavy(shape: string, issue?: SplitIssue): boolean {
	if (shape === "test") {
		return true
	}
	if (!issue) {
		return false
	}
	return CI_MENTION_RE.test(`${issue.title}\n${issue.body ?? ""}`)
}

/**
 * Issue #124: the cost multiplier for a verification-heavy issue. Tapers
 * linearly from TEST_SHAPE_VERIFICATION_MULTIPLIER at MIN_SHAPE_SAMPLES to 1
 * at VERIFICATION_MULTIPLIER_FULL_SAMPLES — the thin samples for test/CI
 * shapes are not trusted as-is, but once real samples accumulate the recorded
 * median already reflects real verification cost. CLAMPED at
 * TEST_SHAPE_VERIFICATION_MULTIPLIER below MIN_SHAPE_SAMPLES: a thin-but-
 * nonzero sample set gets the full scale, never more — the multiplier never
 * exceeds its documented maximum (the taper formula is only meaningful on
 * [MIN_SHAPE_SAMPLES, VERIFICATION_MULTIPLIER_FULL_SAMPLES], so it must not
 * be extrapolated below the lower bound). 1 for a direct match (a record of
 * the VERY task is meaningful on its own), for a non-verification-heavy
 * issue, or when no usable numeric estimate is offered (samples <= 0).
 */
export function verificationMultiplier(
	shape: string,
	issue: SplitIssue | undefined,
	match: IssueEstimate["match"],
	samples: number,
): number {
	if (match === "direct" || samples <= 0 || !isVerificationHeavy(shape, issue)) {
		return 1
	}
	if (samples < MIN_SHAPE_SAMPLES) {
		return TEST_SHAPE_VERIFICATION_MULTIPLIER
	}
	if (samples >= VERIFICATION_MULTIPLIER_FULL_SAMPLES) {
		return 1
	}
	const span = VERIFICATION_MULTIPLIER_FULL_SAMPLES - MIN_SHAPE_SAMPLES
	const progress = (samples - MIN_SHAPE_SAMPLES) / span
	return TEST_SHAPE_VERIFICATION_MULTIPLIER - (TEST_SHAPE_VERIFICATION_MULTIPLIER - 1) * progress
}

/** Estimate one new issue from recorded history. */
export function estimateIssue(
	records: CostHistoryRecord[],
	issueNumber: number,
	shape: string,
	issue?: SplitIssue,
): IssueEstimate {
	// Exact issue-number history is the strongest signal — the same task ran
	// before (e.g. a re-opened issue, or an issue batched in a prior round).
	const direct = records.filter((r) => (r.issues ?? []).includes(issueNumber))
	if (direct.length > 0) {
		return issueEstimateFrom(issueNumber, shape, "direct", direct, issue)
	}
	const byShape = records.filter((r) => (r.shapes ?? []).includes(shape))
	if (byShape.length >= MIN_SHAPE_SAMPLES) {
		return issueEstimateFrom(issueNumber, shape, "shape", byShape, issue)
	}
	return {
		issue: issueNumber,
		shape,
		match: byShape.length > 0 ? "shape" : "none",
		samples: byShape.length,
		verificationMultiplier: verificationMultiplier(shape, issue, "shape", byShape.length),
	}
}

function issueEstimateFrom(
	issueNumber: number,
	shape: string,
	match: IssueEstimate["match"],
	records: CostHistoryRecord[],
	issue?: SplitIssue,
): IssueEstimate {
	const [costLo, costMed, costHi] = minMedMax(records.map(perIssueCost))
	const [iterLo, iterMed, iterHi] = minMedMax(records.map(perIssueIterations))
	const multiplier = verificationMultiplier(shape, issue, match, records.length)
	const costPerIssueUsd = costMed * multiplier
	const estimate: IssueEstimate = {
		issue: issueNumber,
		shape,
		match,
		samples: records.length,
		costPerIssueUsd,
		costPerIssueRangeUsd: [costLo * multiplier, costHi * multiplier],
		iterationsPerIssue: iterMed,
		iterationsPerIssueRange: [iterLo, iterHi],
		continuationRate: mean(records.map((r) => r.continuationCount ?? 0)),
		reworkRate: mean(records.map((r) => r.reworkCount ?? 0)),
		verificationMultiplier: multiplier,
	}
	// Issue #125: flag the CI/config issue and stamp its higher bound (the
	// per-issue median, multiplied) — a separate, complementary signal to
	// the verification multiplier above, which scales the primary estimate;
	// this instead surfaces an additional flagged higher-bound alongside it.
	if (issue !== undefined && isCiConfigChange(issue)) {
		estimate.ciConfig = true
		estimate.higherBoundUsd = costPerIssueUsd * CI_CONFIG_HIGHER_BOUND_MULTIPLIER
	}
	return estimate
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
		// Issue #126: a usable DIRECT match with fewer than MIN_SHAPE_SAMPLES
		// records of the same task is still an anecdote, not a real estimate
		// (estimateIssue offers it because one record of the very task IS
		// meaningful, but its confidence is low).
		lowConfidence: perIssue.some(
			(e) => e.costPerIssueUsd === undefined || (e.match === "direct" && e.samples < MIN_SHAPE_SAMPLES),
		),
	}
	// Only a multiplier that actually scaled a USABLE estimate (one that
	// contributes to expectedCostUsd) is surfaced — a multiplier recorded on
	// an insufficient-data estimate never scaled the displayed cost, so
	// claiming it in the dry-run line would be false.
	const multipliers = usable
		.map((e) => e.verificationMultiplier ?? 1)
		.filter((m) => m > 1)
	if (multipliers.length > 0) {
		estimate.verificationMultiplier = Math.max(...multipliers)
	}
	// Issue #125: flagged higher-bound total — CI/config-changing issues
	// historically cost 2-3x their shape median (round-2026-08-17: w13
	// `test/hot` estimated ~$0.05-$0.27, actual $1.03 then $1.11 with
	// review). Emit it whenever at least one usable CI/config issue exists.
	const ciUsable = usable.filter((e) => e.ciConfig === true)
	if (ciUsable.length > 0) {
		estimate.higherBoundUsd = sum(
			usable.map((e) =>
				e.ciConfig === true
					? (e.higherBoundUsd ?? e.costPerIssueUsd ?? 0)
					: (e.costPerIssueUsd ?? 0),
			),
		)
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
		const perIssue = spec.issues.map((n) => estimateIssue(records, n, shapes.get(n) ?? "generic", issues.find((i) => i.number === n)))
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
			if (group.verificationMultiplier !== undefined && group.verificationMultiplier > 1) {
				line += ` · ${group.verificationMultiplier.toFixed(2)}x verification multiplier`
			}
			if (group.unmatched > 0) {
				line += ` (${group.unmatched} issue(s) unmatched)`
			}
			// Issue #125: CI/config-changing issues historically cost 2-3x
			// their shape median — surface the flagged higher bound right on
			// the estimate line instead of burying it in a footnote.
			if (group.higherBoundUsd !== undefined) {
				line += ` · CI/config work: higher bound ~${formatUsd(group.higherBoundUsd)}`
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
		// Issue #126: prominent LOW-CONFIDENCE marker whenever the estimate
		// is built on thin or missing history (unmatched issues, an
		// under-sampled direct match, or no usable history at all).
		if (group.lowConfidence) {
			lines.push(`       ⚠ LOW-CONFIDENCE: ${lowConfidenceReason(group)}`)
		}
	}
	return lines
}

/** Human-readable reason behind a group's low-confidence flag (issue #126). */
export function lowConfidenceReason(group: GroupEstimate): string {
	if (group.expectedCostUsd === undefined) {
		const withData = group.perIssue.filter((e) => e.match !== "none")
		return withData.length > 0
			? `insufficient history (${Math.max(...withData.map((e) => e.samples))} sample(s), need ${MIN_SHAPE_SAMPLES}) — no numeric estimate`
			: "no history for this shape yet"
	}
	if (group.unmatched > 0) {
		return `${group.unmatched} issue(s) unmatched (their cost is NOT included in the estimate)`
	}
	const underSampled = group.perIssue.find((e) => e.match === "direct" && e.samples < MIN_SHAPE_SAMPLES)
	if (underSampled) {
		return `direct history for issue ${underSampled.issue} is a single-run anecdote (${underSampled.samples} sample(s), need ${MIN_SHAPE_SAMPLES})`
	}
	return "estimate relies on thin history"
}
