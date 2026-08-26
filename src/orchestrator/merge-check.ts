/**
 * Deterministic "is this group's work merged?" predicates for `orchestrate
 * cleanup` (see cleanup.ts). Two sources of truth, dispatched by which
 * workflow produced the group — never a heuristic:
 *
 *   - checkMergedByAncestor: local merge (`git merge <branch>` /
 *     fast-forward into the base branch). `git merge-base --is-ancestor
 *     <branchTip> <base>` is provable with total certainty — exit 0 means
 *     every commit on the branch is in history. No guessing, no network.
 *   - checkMergedByGitHubPr: GitHub PR merge (squash or rebase). GitHub
 *     creates a NEW commit whose hash is nothing on the worker's branch, so
 *     the ancestor check above would wrongly say "not merged" — the only
 *     correct answer for that workflow is GitHub's server-computed `.merged`
 *     field (GET /repos/{owner}/{repo}/pulls/{number}).
 *
 * Both checks are conservative by construction: an API error or unexpected
 * git failure is "unknown" (via checkMergedByGitHubPr) or a throw (ancestor
 * check) — never guessed as merged.
 */

import { execFileSync } from "node:child_process"

import { getPullRequestStatus, OpenPrError } from "../github/pr.js"

export type MergeCheckResult =
	| { merged: true; via: "local-ancestor" | "github-pr"; detail: string }
	| { merged: false; via: "local-ancestor" | "github-pr" | "unknown"; detail: string }

/**
 * Local-merge check — no network, fully deterministic. Pass the branch names
 * (or commits) directly; git resolves them itself.
 *
 * Exit-code contract (git's documented behavior for
 * `merge-base --is-ancestor`):
 *   0  the branch tip IS an ancestor of baseBranch → merged
 *   1  not an ancestor → not merged
 *   anything else (e.g. 128 for a missing ref) → THROW; an unknown git
 *   state must never be guessed as merged or not-merged.
 */
export function checkMergedByAncestor(repo: string, branch: string, baseBranch: string): MergeCheckResult {
	let status: number | null
	try {
		execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", branch, baseBranch], {
			stdio: "ignore",
			timeout: 10_000,
		})
		status = 0
	} catch (err) {
		status = (err as { status?: number }).status ?? null
	}
	if (status === 0) {
		return {
			merged: true,
			via: "local-ancestor",
			detail: `${branch} tip is an ancestor of ${baseBranch}`,
		}
	}
	if (status === 1) {
		return {
			merged: false,
			via: "local-ancestor",
			detail: `${branch} tip is NOT an ancestor of ${baseBranch}`,
		}
	}
	throw new Error(
		`git merge-base --is-ancestor ${branch} ${baseBranch} failed (exit ${status ?? "unknown"}) — merge status unknown`,
	)
}

/**
 * GitHub PR check — only attempted when the group records a PR number. Asks
 * GitHub directly and trusts the server-computed `.merged` boolean (the only
 * correct answer for squash/rebase merges). An API/network failure fails
 * CLOSED as `{ merged: false, via: "unknown" }` — an unverifiable merge is
 * never treated as merged.
 */
export async function checkMergedByGitHubPr(options: {
	owner: string
	repo: string
	prNumber: number
	getInstallationToken: () => Promise<string>
	/** API base URL override (tests/mocks; default api.github.com). */
	baseUrl?: string
	/** Injectable fetch for tests (default: global fetch). */
	fetchImpl?: typeof fetch
}): Promise<MergeCheckResult> {
	const { owner, repo, prNumber } = options
	try {
		const status = await getPullRequestStatus({
			owner,
			repo,
			prNumber,
			getToken: options.getInstallationToken,
			...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
			...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
		})
		if (status.merged) {
			return { merged: true, via: "github-pr", detail: `PR #${prNumber} merged (state ${status.state})` }
		}
		return { merged: false, via: "github-pr", detail: `PR #${prNumber} not merged (state ${status.state})` }
	} catch (err) {
		const detail =
			err instanceof OpenPrError
				? `GitHub API error (GET ${err.url}, HTTP ${err.status}): ${err.message}`
				: `GitHub PR check error: ${err instanceof Error ? err.message : String(err)}`
		return { merged: false, via: "unknown", detail }
	}
}
