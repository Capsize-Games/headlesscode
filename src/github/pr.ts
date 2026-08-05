/**
 * Open a pull request via the GitHub REST API using the installation token.
 *
 * `openPullRequest()` is the PR half of push-back: after `pushBranch()` has
 * pushed a named branch (see src/github/push.ts), this opens a PR from that
 * `head` branch into a `base` branch.
 *
 * `getPullRequestStatus()` is the read-back half used by orchestrator
 * worktree cleanup (`src/orchestrator/merge-check.ts`): a squash/rebase PR
 * merge creates a NEW commit whose hash is nothing on the source branch, so
 * the local `merge-base --is-ancestor` check alone would wrongly report
 * "not merged". GitHub's server-computed `.merged` boolean on
 * `GET /repos/{owner}/{repo}/pulls/{number}` is the only authoritative
 * "is this PR merged" answer for that workflow.
 *
 * The base branch is never hardcoded: when `base` is omitted it is resolved
 * fresh from the repo API (`GET /repos/{owner}/{repo}` → `default_branch`),
 * so the PR always targets the repo's REAL default branch unless the caller
 * overrides it explicitly.
 *
 * Transport: plain authenticated `fetch` (Node >= 18) against the one REST
 * endpoint needed, matching src/github/installations.ts — no new runtime
 * dependency (this project deliberately avoids heavy SDKs; @octokit/rest is
 * not even present). The token goes in an `Authorization: Bearer` header and
 * is never logged.
 *
 * Failure honesty: a PR whose head→base has nothing to merge is a REAL GitHub
 * API error (HTTP 422 "No commits between ..." / "The head and base branches
 * are the same"). It is surfaced as a typed NoDiffError — never silently
 * succeeded or retried.
 */

/** The function that supplies a fresh installation access token. */
type TokenSupplier = () => Promise<string>

export interface OpenPrOptions {
	installationId: number | string
	owner: string
	repo: string
	/** Branch name pushed in step 1 (the PR's source). */
	head: string
	/**
	 * Target branch, e.g. "main"/"master". Omitted → resolved fresh from the
	 * repo API's default_branch (never hardcoded here).
	 */
	base?: string
	title: string
	body: string
	getToken: TokenSupplier
	/** API base URL override (tests/mocks; default api.github.com). */
	baseUrl?: string
	/** Injectable fetch for tests (default: global fetch). */
	fetchImpl?: typeof fetch
}

export interface OpenPrResult {
	number: number
	/** The human-facing PR page URL (GitHub's `html_url`), not the API URL. */
	url: string
}

/** Non-2xx GitHub API response for one of the PR endpoints. */
export class OpenPrError extends Error {
	readonly status: number
	readonly url: string
	constructor(status: number, message: string, url: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "OpenPrError"
		this.status = status
		this.url = url
	}
}

/** The PR has nothing to merge (no commits between head and base, or head ===
 * base) — GitHub's real "you cannot open this PR" case. */
export class NoDiffError extends OpenPrError {
	constructor(status: number, message: string, url: string, options?: ErrorOptions) {
		super(status, message, url, options)
		this.name = "NoDiffError"
	}
}

const DEFAULT_GH_BASE_URL = "https://api.github.com"
const GH_API_VERSION = "2022-11-28"
const USER_AGENT = "headlesscode-push-pr"

function ghHeaders(token: string): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": GH_API_VERSION,
		Authorization: `Bearer ${token}`,
		"User-Agent": USER_AGENT,
		"Content-Type": "application/json",
	}
}

interface ErrorPayload {
	message?: unknown
	errors?: unknown
}

async function parseErrorPayload(response: Response): Promise<ErrorPayload> {
	try {
		return (await response.json()) as ErrorPayload
	} catch {
		return {}
	}
}

/** The message GitHub gives for "nothing to merge" (top-level or in errors[]). */
const NO_DIFF_PATTERNS = [/no commits between/i, /head and base branches are the same/i]

function isNoDiff(payload: ErrorPayload): boolean {
	const message = payload.message
	if (typeof message === "string" && NO_DIFF_PATTERNS.some((re) => re.test(message))) {
		return true
	}
	if (Array.isArray(payload.errors)) {
		for (const entry of payload.errors) {
			if (entry === null || typeof entry !== "object") {
				continue
			}
			const entryMessage = (entry as { message?: unknown }).message
			if (typeof entryMessage === "string" && NO_DIFF_PATTERNS.some((re) => re.test(entryMessage))) {
				return true
			}
		}
	}
	return false
}

function formatErrorMessage(payload: ErrorPayload, fallback: string): string {
	if (typeof payload.message === "string" && payload.message !== "") {
		return payload.message
	}
	return fallback
}

/** The repo API's `default_branch` for <owner>/<repo> (never hardcoded). */
export async function getRepoDefaultBranch(options: {
	owner: string
	repo: string
	getToken: TokenSupplier
	baseUrl?: string
	fetchImpl?: typeof fetch
}): Promise<string> {
	const { owner, repo, getToken, baseUrl, fetchImpl = fetch } = options
	const token = await getToken()

	const apiBase = (baseUrl ?? DEFAULT_GH_BASE_URL).replace(/\/+$/, "")
	const url = `${apiBase}/repos/${owner}/${repo}`

	let response: Response
	try {
		response = await fetchImpl(url, {
			method: "GET",
			headers: ghHeaders(token),
		})
	} catch (err) {
		throw new OpenPrError(
			0,
			`GitHub API network error (GET ${url}): ${err instanceof Error ? err.message : String(err)}`,
			url,
			{ cause: err },
		)
	}

	if (!response.ok) {
		const payload = await parseErrorPayload(response)
		throw new OpenPrError(response.status, formatErrorMessage(payload, `GitHub API HTTP ${response.status} for GET ${url}`), url)
	}

	const body = (await response.json()) as { default_branch?: unknown }
	if (typeof body.default_branch !== "string" || body.default_branch === "") {
		throw new OpenPrError(response.status, `repo API for ${owner}/${repo} returned no default_branch`, url)
	}
	return body.default_branch
}

/**
 * Open a PR from `head` into `base` (resolved to the repo's real default
 * branch when omitted) on <owner>/<repo>. Returns the PR number + human-facing
 * URL. A "nothing to merge" API response surfaces as NoDiffError.
 */
export async function openPullRequest(options: OpenPrOptions): Promise<OpenPrResult> {
	const { owner, repo, head, title, body, getToken, baseUrl, fetchImpl = fetch } = options
	if (!owner || !repo) {
		throw new OpenPrError(0, "openPullRequest: owner and repo are required", "")
	}
	if (!head) {
		throw new OpenPrError(0, "openPullRequest: head is required", "")
	}
	if (!title) {
		throw new OpenPrError(0, "openPullRequest: title is required", "")
	}

	const token = await getToken()
	if (!token) {
		throw new OpenPrError(0, "openPullRequest: no installation token provided", "")
	}

	// Resolve the real target branch fresh unless the caller overrode it.
	const base = options.base ?? (await getRepoDefaultBranch({ owner, repo, getToken: async () => token, baseUrl, fetchImpl }))

	const apiBase = (baseUrl ?? DEFAULT_GH_BASE_URL).replace(/\/+$/, "")
	const url = `${apiBase}/repos/${owner}/${repo}/pulls`

	let response: Response
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: ghHeaders(token),
			body: JSON.stringify({ title, head, base, body }),
		})
	} catch (err) {
		throw new OpenPrError(
			0,
			`GitHub API network error (POST ${url}): ${err instanceof Error ? err.message : String(err)}`,
			url,
			{ cause: err },
		)
	}

	if (!response.ok) {
		const payload = await parseErrorPayload(response)
		const message = formatErrorMessage(payload, `GitHub API HTTP ${response.status} for POST ${url}`)
		if (isNoDiff(payload)) {
			// Nothing to merge is a real, permanent API rejection (422) — a
			// retry would fail identically. Surface it clearly, never retry.
			throw new NoDiffError(response.status, `nothing to merge: ${message}`, url)
		}
		throw new OpenPrError(response.status, message, url)
	}

	const pr = (await response.json()) as { number?: unknown; html_url?: unknown }
	if (typeof pr.number !== "number" || typeof pr.html_url !== "string") {
		throw new OpenPrError(response.status, `unexpected PR response shape from POST ${url}`, url)
	}
	return { number: pr.number, url: pr.html_url }
}

export interface PullRequestStatus {
	number: number
	/** "open" | "closed" — the PR's lifecycle state, NOT its merge status. */
	state: string
	/** GitHub's server-computed merge boolean — the authoritative answer. */
	merged: boolean
	mergedAt?: string
	htmlUrl?: string
	title?: string
}

/**
	* Read a PR's status back from `GET /repos/{owner}/{repo}/pulls/{number}`.
	* The `.merged` field is computed server-side by GitHub and is the ONLY
	* correct "is this PR merged" answer for squash/rebase merges (which create
	* a new commit hash unrelated to anything on the source branch). Non-2xx
	* API responses throw OpenPrError exactly like openPullRequest; a malformed
	* 2xx body (missing `merged`/`state`) also throws rather than guessing.
	*/
export async function getPullRequestStatus(options: {
	owner: string
	repo: string
	prNumber: number
	getToken: TokenSupplier
	baseUrl?: string
	fetchImpl?: typeof fetch
}): Promise<PullRequestStatus> {
	const { owner, repo, prNumber, getToken, baseUrl, fetchImpl = fetch } = options
	if (!owner || !repo || !Number.isInteger(prNumber) || prNumber <= 0) {
		throw new OpenPrError(0, "getPullRequestStatus: owner, repo and a positive prNumber are required", "")
	}

	const token = await getToken()
	if (!token) {
		throw new OpenPrError(0, "getPullRequestStatus: no installation token provided", "")
	}

	const apiBase = (baseUrl ?? DEFAULT_GH_BASE_URL).replace(/\/+$/, "")
	const url = `${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}`

	let response: Response
	try {
		response = await fetchImpl(url, {
			method: "GET",
			headers: ghHeaders(token),
		})
	} catch (err) {
		throw new OpenPrError(
			0,
			`GitHub API network error (GET ${url}): ${err instanceof Error ? err.message : String(err)}`,
			url,
			{ cause: err },
		)
	}

	if (!response.ok) {
		const payload = await parseErrorPayload(response)
		throw new OpenPrError(response.status, formatErrorMessage(payload, `GitHub API HTTP ${response.status} for GET ${url}`), url)
	}

	const body = (await response.json()) as {
		number?: unknown
		state?: unknown
		merged?: unknown
		merged_at?: unknown
		html_url?: unknown
		title?: unknown
	}
	if (typeof body.number !== "number" || typeof body.state !== "string" || typeof body.merged !== "boolean") {
		throw new OpenPrError(response.status, `unexpected PR status shape from GET ${url}`, url)
	}
	return {
		number: body.number,
		state: body.state,
		merged: body.merged,
		...(typeof body.merged_at === "string" ? { mergedAt: body.merged_at } : {}),
		...(typeof body.html_url === "string" ? { htmlUrl: body.html_url } : {}),
		...(typeof body.title === "string" ? { title: body.title } : {}),
	}
}
