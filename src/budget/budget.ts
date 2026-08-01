/**
 * Phase 6 — per-session cost/time/iteration budget enforcement.
 *
 * `BudgetTracker` is the pure, unit-testable core of the per-session budget
 * guardrail (spec 6.3): it sits inside a `HeadlessSession` (or any caller
 * that makes LLM calls) and trips a `BudgetExceededError` when ANY of these
 * limits is crossed:
 *
 *   - `maxCostUsd`     — accumulated estimated USD cost (tokens × pricing);
 *   - `maxDurationMs`  — wall-clock elapsed since the tracker was created;
 *   - `maxIterations`  — number of LLM calls (ticks) performed.
 *
 * Enforcement points (see `check` / `tick` / `record`):
 *   - `tick()` is called BEFORE each LLM call and re-checks elapsed time,
 *     iteration count AND accumulated cost (a previous call's `record()` may
 *     have pushed cost past the cap — the next `tick()` catches it before any
 *     further spend);
 *   - `record()` is called AFTER each LLM call with the provider's usage token
 *     counts and accumulates cost (checking the cost cap again).
 *
 * Pure by construction: no fs, no network, no global state. Time is
 * injectable (`now`), so duration tests use a fake clock; pricing is
 * injectable so cost tests don't depend on the env pricing file.
 *
 * When a budget is NOT configured the tracker is simply never created — zero
 * behavior change (the session default is `budget: null`).
 */

import { estimateCost, loadPricingTable, type PricingTable } from "./cost.js"

/** Per-session budget (all limits optional — only the set ones are enforced). */
export interface SessionBudget {
	/** Max estimated USD spend for the session (accumulated across LLM calls). */
	maxCostUsd?: number
	/** Max wall-clock duration for the session, ms (checked before each call). */
	maxDurationMs?: number
	/** Max LLM-call iterations (a stricter cap than the loop's maxIterations). */
	maxIterations?: number
}

export type BudgetLimitReason = "cost" | "duration" | "iterations"

/** Thrown by `tick()`/`record()` when a budget limit trips. */
export class BudgetExceededError extends Error {
	readonly reason: BudgetLimitReason
	readonly costUsd: number
	readonly elapsedMs: number
	readonly iterations: number

	constructor(reason: BudgetLimitReason, costUsd: number, elapsedMs: number, iterations: number) {
		super(`Budget exceeded: ${reason} (cost $${costUsd.toFixed(6)}, elapsed ${elapsedMs}ms, iterations ${iterations})`)
		this.name = "BudgetExceededError"
		this.reason = reason
		this.costUsd = costUsd
		this.elapsedMs = elapsedMs
		this.iterations = iterations
	}
}

export interface BudgetTrackerOptions {
	/** Clock (default Date.now) — inject a fake for duration tests. */
	now?: () => number
	/** Pricing table (default: env-merged defaults) — inject for cost tests. */
	pricing?: PricingTable
}

/** Non-throwing snapshot of the budget state (surfaced on SessionResult). */
export interface BudgetCheck {
	ok: boolean
	reason?: BudgetLimitReason
	costUsd: number
	elapsedMs: number
	iterations: number
}

export class BudgetTracker {
	private readonly budget: SessionBudget
	private readonly now: () => number
	private readonly pricing: PricingTable
	private readonly startedAt: number
	private iterations = 0
	private costUsd = 0

	constructor(budget: SessionBudget, options: BudgetTrackerOptions = {}) {
		this.budget = budget
		this.now = options.now ?? (() => Date.now())
		this.pricing = options.pricing ?? loadPricingTable()
		this.startedAt = this.now()
	}

	get elapsedMs(): number {
		return Math.max(0, this.now() - this.startedAt)
	}

	get iterationCount(): number {
		return this.iterations
	}

	get totalCostUsd(): number {
		return this.costUsd
	}

	/**
	 * Call BEFORE each LLM call. Increments the iteration counter and re-checks
	 * duration, iterations and accumulated cost. Throws `BudgetExceededError`
	 * when a limit is crossed.
	 */
	tick(): void {
		this.iterations++
		this.throwIfExceeded()
	}

	/**
	 * Call AFTER each LLM call with the provider's usage token counts.
	 * Accumulates the estimated cost and re-checks the cost cap. Throws
	 * `BudgetExceededError` when the cost limit trips.
	 */
	record(input: { model: string; inputTokens?: number; outputTokens?: number }): void {
		const cost = estimateCost({
			model: input.model,
			inputTokens: input.inputTokens ?? 0,
			outputTokens: input.outputTokens ?? 0,
			pricing: this.pricing,
		})
		this.costUsd += cost
		this.throwIfExceeded()
	}

	/** Non-throwing snapshot: { ok, reason?, costUsd, elapsedMs, iterations }. */
	check(): BudgetCheck {
		const { reason } = this.exceededReason()
		return {
			ok: reason === undefined,
			reason,
			costUsd: this.costUsd,
			elapsedMs: this.elapsedMs,
			iterations: this.iterations,
		}
	}

	private exceededReason(): { reason?: BudgetLimitReason } {
		if (this.budget.maxDurationMs !== undefined && this.elapsedMs >= this.budget.maxDurationMs) {
			return { reason: "duration" }
		}
		if (this.budget.maxIterations !== undefined && this.iterations > this.budget.maxIterations) {
			return { reason: "iterations" }
		}
		if (this.budget.maxCostUsd !== undefined && this.costUsd >= this.budget.maxCostUsd) {
			return { reason: "cost" }
		}
		return {}
	}

	private throwIfExceeded(): void {
		const { reason } = this.exceededReason()
		if (reason !== undefined) {
			throw new BudgetExceededError(reason, this.costUsd, this.elapsedMs, this.iterations)
		}
	}
}

/**
 * Build a `SessionBudget` from the harness env vars used by the CLI +
 * run-worker.sh/run-qa.sh. Returns undefined when neither cost nor duration is
 * set (budget OFF). Invalid values are ignored (validation lives in the CLI).
 */
export function sessionBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): SessionBudget | undefined {
	const costRaw = env.HEADLESSCODE_MAX_COST_USD
	const durationRaw = env.HEADLESSCODE_MAX_DURATION_MS
	const cost = costRaw !== undefined && costRaw !== "" ? Number(costRaw) : undefined
	const duration = durationRaw !== undefined && durationRaw !== "" ? Number(durationRaw) : undefined
	if ((cost !== undefined && Number.isFinite(cost) && cost > 0) || (duration !== undefined && Number.isFinite(duration) && duration > 0)) {
		return {
			...(cost !== undefined && Number.isFinite(cost) && cost > 0 ? { maxCostUsd: cost } : {}),
			...(duration !== undefined && Number.isFinite(duration) && duration > 0 ? { maxDurationMs: duration } : {}),
		}
	}
	return undefined
}
