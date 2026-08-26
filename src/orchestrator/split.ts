/**
 * Issue-splitting heuristics — deterministic TS port.
 *
 * SOURCE: the `multi-agent-orchestrator` custom mode's Step 2 "Decide the
 * split". The four
 * heuristics are reused unchanged in spirit:
 *
 *   1. Isolate anything touching a hot path alone (request handling,
 *      database sessions/migrations, auth, encryption, anything the
 *      codebase's own conventions flag as high blast radius) — never
 *      bundle a hot-path change with unrelated work, and never put two
 *      independent hot-path changes in the same worktree if avoidable.
 *   2. Group same-shape mechanical work together (e.g. multiple "split
 *      this file" issues, multiple "add test coverage" issues) — they
 *      share a risk profile and review checklist, and batching them
 *      means one worker/PR/review cycle instead of several.
 *   3. Never let a worktree exceed roughly a day of sequential work for
 *      one agent — if a single issue is enormous, it can be its own
 *      worktree; don't pad it with more work.
 *   4. Prefer 2-4 worktrees over 5+ in most cases.
 *
 * This module turns those judgment calls into a small deterministic
 * algorithm so the same decisions can be made headlessly, re-verified in
 * unit tests, and printed by `orchestrate --dry-run` before anything is
 * spawned. It is pure (no fs, no network) and fully unit-testable.
 *
 * Output naming follows the task-file convention:
 *   plans/parallel-tasks/<name>-issue<numbers>.md
 * e.g. `w1-issue27.md`, `w2-issue29-36.md`.
 */

/** One open GitHub issue (`gh issue view --json ...` shape). */
export interface SplitIssue {
	number: number
	title: string
	body?: string
}

/** A proposed worktree group, one harness worker will own it. */
export interface WorktreeSpec {
	/** Worktree name, e.g. `w1`. */
	name: string
	/** Issue numbers assigned to this worktree, ascending. */
	issues: number[]
	/** Task file name under plans/parallel-tasks/ (conventional naming). */
	taskFile: string
}

/** Hot-path keywords from heuristic 1 (matched against title + body). */
const HOT_PATH_RE = /(request|handler|migration|database|session|auth|encryption|crypto|password|token)/i

/**
 * Same-shape mechanical-work patterns from heuristic 2 (matched against the
 * title). The key is the "shape" used to group issues; all issues whose title
 * matches the same pattern share a risk profile + review checklist.
 */
const SAME_SHAPE_PATTERNS: Array<{ key: string; re: RegExp }> = [
	// "split" + "decompose" are the same mechanical shape — grouped
	// #29 "Split the 10 multi-class files" with #36 "Decompose remaining 25
	// files" in one worktree (w2-issue29-36.md) for exactly this reason.
	{ key: "split", re: /(split|decompose)/i },
	{ key: "coverage", re: /coverage/i },
	{ key: "test", re: /test/i },
	{ key: "docs", re: /docs/i },
	{ key: "refactor", re: /refactor/i },
]

/** Issues with no recognized mechanical shape land here. */
const GENERIC_KEY = "generic"

/** Max issues in a generic (non-same-shape) group — heuristic 3 (~1 day). */
export const GENERIC_GROUP_CAP = 2

/** Max issues in a same-shape group — mechanical batches can be larger. */
export const SAME_SHAPE_GROUP_CAP = 3

/** Prefer at most this many groups (heuristic 4: 2-4, never 5+). */
export const MAX_GROUPS = 4

function isHotPath(issue: SplitIssue): boolean {
	const haystack = `${issue.title}\n${issue.body ?? ""}`
	return HOT_PATH_RE.test(haystack)
}

/**
 * The mechanical "shape" of an issue (heuristic 2's grouping key): the first
 * same-shape pattern matched against the TITLE (split/coverage/test/docs/
 * refactor), or "generic" when none matches. Pure title-based — the same key
 * used to batch issues into worktrees. Exported because it doubles as the
 * similarity signal for cost estimation (cost-estimate.ts, issue #16): a NEW
 * issue whose shape matches past ones inherits their recorded cost profile.
 */
export function shapeOf(issue: SplitIssue): string {
	for (const { key, re } of SAME_SHAPE_PATTERNS) {
		if (re.test(issue.title)) {
			return key
		}
	}
	return GENERIC_KEY
}

/**
 * The full shape taxonomy used for cost estimation: "hot" when the issue
 * touches a hot path (title OR body — the same scan that isolates hot-path
 * issues into their own worktree), else shapeOf's mechanical shape. A hot
 * issue keeps its hot label even when its title also matches a mechanical
 * pattern: hot-path work has its own risk/cost profile, and split.ts treats
 * it as its own category for isolation purposes.
 */
export function issueShape(issue: SplitIssue): string {
	return isHotPath(issue) ? "hot" : shapeOf(issue)
}

/**
 * Pre-flight issue-size check (issue #53). The two worst cost/iteration
 * outliers this repo has seen all
 * share one trait: the issue body asks for several substantial, largely
 * independent pieces of work in a single shot. This is the crude, free,
 * deterministic signal for that — the issue text itself explicitly asks for
 * "does the issue body have 3+ top-level numbered/bulleted sections" as an
 * acceptable first cut. Warning-only by design: a crude heuristic can false-
 * positive, so it never aborts a round, only warns loudly before dispatch.
 */

/** Flag an issue whose body reads like at least this many independent pieces. */
export const ISSUE_SIZE_WARN_THRESHOLD = 3

/** An issue flagged by the pre-flight size check, with the detected count. */
export interface IssueSizeWarning {
	number: number
	title: string
	/** Number of top-level numbered/bulleted sections detected in the body. */
	sections: number
}

/**
 * Count top-level numbered/bulleted list items in a markdown body — the crude
 * "N independent pieces" signal. Top-level = at most 3 leading spaces (the
 * CommonMark container rule); nested list items are indented deeper and are
 * deliberately excluded. Also counts headings carrying an explicit ordinal
 * ("## 1. Client session cards"). Pure line scan: prose without list markers
 * scores 0, so inline numbers ("Python 3.10", "$1.50", "#17") never
 * false-positive.
 */
export function topLevelSectionCount(body: string | undefined): number {
	if (!body) {
		return 0
	}
	let count = 0
	for (const line of body.split("\n")) {
		if (
			/^ {0,3}\d{1,3}[.)]\s+\S/.test(line) ||
			/^ {0,3}[-*+]\s+\S/.test(line) ||
			/^#{1,6} {0,3}\d{1,3}[.)]?\s+\S/.test(line)
		) {
			count++
		}
	}
	return count
}

/**
 * Issues whose body reads like `ISSUE_SIZE_WARN_THRESHOLD`+ independent pieces
 * of work — the exact shape that burned iteration caps and budget on real
 * rounds before dispatch-time detection existed.
 */
export function issueSizeWarnings(issues: SplitIssue[]): IssueSizeWarning[] {
	const warnings: IssueSizeWarning[] = []
	for (const issue of issues) {
		const sections = topLevelSectionCount(issue.body)
		if (sections >= ISSUE_SIZE_WARN_THRESHOLD) {
			warnings.push({ number: issue.number, title: issue.title, sections })
		}
	}
	return warnings
}

function capFor(shape: string): number {
	return shape === GENERIC_KEY ? GENERIC_GROUP_CAP : SAME_SHAPE_GROUP_CAP
}

/** Internal group shape used while deciding; not part of the public spec. */
interface InternalGroup {
	shape: string
	issues: number[]
}

/** Sort issue-number lists ascending (stable, deterministic). */
function sortedIssues(numbers: number[]): number[] {
	return [...numbers].sort((a, b) => a - b)
}

function minIssue(group: InternalGroup): number {
	return group.issues.length > 0 ? Math.min(...group.issues) : Number.MAX_SAFE_INTEGER
}

/**
 * Split issues into worktree groups using the orchestration heuristics.
 *
 * - Every hot-path issue is isolated alone (heuristic 1).
 * - Non-hot-path issues are batched by mechanical shape, capped at
 *   `capFor(shape)` issues per group (heuristics 2 + 3).
 * - If that yields more than `MAX_GROUPS` groups, the smallest groups are
 *   merged (same-shape pairs first, then the smallest remaining) until the
 *   round fits in 2-4 worktrees (heuristic 4).
 *
 * @param issues issues to split (order-independent; output is sorted)
 * @param opts.occupiedNames worktree names already in use in the TARGET repo
 *        (e.g. a still-running round's `.worktrees/w1`) — naming skips over
 *        these instead of colliding, so a second `orchestrate` invocation
 *        against the same repo can run alongside an in-flight round instead
 *        of failing the pre-spawn stale-worktree check. See cli.ts, which
 *        populates this from the repo's actual `.worktrees/` listing.
 * @returns worktree specs in ascending min-issue order, named around the
 *          first free wN slots with convention-named task files
 */
export function splitIssues(
	issues: SplitIssue[],
	opts: { occupiedNames?: ReadonlySet<string> } = {},
): WorktreeSpec[] {
	if (issues.length === 0) {
		return []
	}

	const hot: SplitIssue[] = []
	const rest: SplitIssue[] = []
	for (const issue of issues) {
		;(isHotPath(issue) ? hot : rest).push(issue)
	}
	hot.sort((a, b) => a.number - b.number)
	rest.sort((a, b) => a.number - b.number)

	// Heuristic 1: each hot-path issue alone.
	const groups: InternalGroup[] = hot.map((issue) => ({ shape: "hot", issues: [issue.number] }))

	// Heuristics 2 + 3: batch same-shape work, cap non-same-shape at ~2.
	const buckets = new Map<string, InternalGroup[]>()
	for (const issue of rest) {
		const shape = shapeOf(issue)
		const list = buckets.get(shape) ?? []
		let bucket = list[list.length - 1]
		if (!bucket || bucket.issues.length >= capFor(shape)) {
			bucket = { shape, issues: [] }
			list.push(bucket)
			buckets.set(shape, list)
		}
		bucket.issues.push(issue.number)
	}
	for (const list of buckets.values()) {
		groups.push(...list)
	}

	// Deterministic group ordering by smallest issue number.
	groups.sort((a, b) => minIssue(a) - minIssue(b))

	// Heuristic 4: never exceed MAX_GROUPS. Merge smallest groups, preferring
	// same-shape pairs so merged work still shares one review checklist.
	while (groups.length > MAX_GROUPS) {
		groups.sort((a, b) => {
			const bySize = a.issues.length - b.issues.length
			if (bySize !== 0) {
				return bySize
			}
			return minIssue(a) - minIssue(b)
		})
		const smallest = groups[0]
		const sameShape = groups
			.slice(1)
			.find((g) => g.shape === smallest.shape && g.shape !== "hot")
		const target = sameShape ?? groups[1]
		target.issues = sortedIssues([...target.issues, ...smallest.issues])
		groups.splice(0, 1)
	}

	// Final sort by min issue number, then assign names + task files. Skips
	// over any name already reserved via opts.occupiedNames (a still-running
	// round in the same repo) — reserves each assigned name as it goes so two
	// groups from THIS call never double-book the same slot either.
	groups.sort((a, b) => minIssue(a) - minIssue(b))
	const reserved = new Set(opts.occupiedNames ?? [])
	let nextSlot = 1
	return groups.map((group) => {
		while (reserved.has(`w${nextSlot}`)) {
			nextSlot++
		}
		const name = `w${nextSlot}`
		reserved.add(name)
		nextSlot++
		const issues = sortedIssues(group.issues)
		return {
			name,
			issues,
			taskFile: `${name}-issue${issues.join("-")}.md`,
		}
	})
}
