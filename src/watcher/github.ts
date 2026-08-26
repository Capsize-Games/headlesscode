/**
 * Phase 5 — minimal authenticated GitHub REST client for the issue watcher.
 *
 * Native `fetch` only (Node >= 18), no new dependencies. GET-only for the
 * watcher's needs (list issues by label, fetch a single issue) plus an
 * optional `addLabel` POST used by the label-marking idempotency strategy
 * (see docs/phase5-issue-watcher.md — the default watcher uses the state
 * file, but the label-marking option is documented and this function exists
 * for it).
 *
 * Auth: `Authorization: Bearer <token>` from `GH_TOKEN` or `GITHUB_TOKEN`
 * (the caller passes the token in; this module never reads the environment
 * itself so tests can inject a fake token). The token is NEVER logged and
 * never written to the watcher state file.
 *
 * Base URL override: `GITHUB_API_BASE_URL` env (or the `baseUrl` option)
 * points the client at a mock server for tests/e2e. Default api.github.com.
 *
 * Errors: non-2xx -> typed `GhApiError` with HTTP status + message; network
 * failures are wrapped in a plain Error.
 */

export const DEFAULT_GH_BASE_URL = "https://api.github.com"
/** GitHub REST API version header (see https://docs.github.com/en/rest). */
export const GH_API_VERSION = "2022-11-28"
/** Page size for list endpoints (GitHub max is 100). */
export const ISSUES_PAGE_SIZE = 100
/** Hard cap on total issues fetched per listIssues call (bounds runtime). */
export const DEFAULT_MAX_ISSUES = 1000

/** Typed error for non-2xx GitHub API responses. */
export class GhApiError extends Error {
	readonly status: number
	readonly url: string

	constructor(status: number, message: string, url: string) {
		super(message)
		this.name = "GhApiError"
		this.status = status
		this.url = url
	}
}

/** A normalized GitHub issue (PRs are filtered out by listIssues/getIssue). */
export interface GitHubIssue {
	number: number
	title: string
	body?: string
	/** Label names, e.g. ["needs-agent"]. */
	labels: string[]
	updated_at?: string
	html_url?: string
}

export interface GhRequestOptions {
	token: string
	/** API base URL (default: $GITHUB_API_BASE_URL or https://api.github.com). */
	baseUrl?: string
	method?: string
	body?: unknown
	/** Injectable fetch for tests (default: global fetch). */
	fetchImpl?: typeof fetch
}

/**
 * Build a GitHub API URL from a base URL + API path + query params.
 * Exported so tests can assert URL construction without a network.
 */
export function buildGhUrl(
	baseUrl: string,
	apiPath: string,
	params?: Record<string, string | number | undefined>,
): string {
	const cleanBase = baseUrl.replace(/\/+$/, "")
	const pathPart = apiPath.startsWith("/") ? apiPath : `/${apiPath}`
	const url = new URL(`${cleanBase}${pathPart}`)
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== "") {
				url.searchParams.set(key, String(value))
			}
		}
	}
	return url.toString()
}

/**
 * One authenticated GitHub REST call. GET by default (plus POST for
 * addLabel). Non-2xx -> GhApiError; network errors are wrapped.
 */
export async function ghApi(apiPath: string, options: GhRequestOptions): Promise<unknown> {
	const {
		token,
		baseUrl = process.env.GITHUB_API_BASE_URL || DEFAULT_GH_BASE_URL,
		method = "GET",
		body,
		fetchImpl = fetch,
	} = options
	if (!token) {
		throw new Error("ghApi: no GitHub token provided (set GH_TOKEN or GITHUB_TOKEN)")
	}
	// apiPath may be a relative API path ("/repos/o/r/issues") OR a fully
	// built URL (listIssues constructs the paginated URL itself) — pass
	// absolute URLs through unchanged.
	const url = /^https?:\/\//i.test(apiPath) ? apiPath : buildGhUrl(baseUrl, apiPath)

	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": GH_API_VERSION,
		Authorization: `Bearer ${token}`,
		"User-Agent": "headlesscode-watcher",
	}

	let response: Response
	try {
		response = await fetchImpl(url, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		})
	} catch (err) {
		throw new Error(
			`GitHub API network error (${method} ${url}): ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		)
	}

	if (!response.ok) {
		let message = `GitHub API HTTP ${response.status} for ${method} ${url}`
		try {
			const payload = (await response.json()) as { message?: unknown }
			if (typeof payload?.message === "string" && payload.message !== "") {
				message = `${payload.message} (HTTP ${response.status})`
			}
		} catch {
			// body is not JSON — keep the generic message
		}
		throw new GhApiError(response.status, message, url)
	}

	// 204/empty bodies (rare for GETs; addLabel returns 200 with a body).
	const text = await response.text()
	if (text.trim() === "") {
		return undefined
	}
	return JSON.parse(text)
}

export interface ListIssuesOptions {
	owner: string
	repo: string
	/** Filter by label name (e.g. "needs-agent"). */
	label?: string
	/** Issue state filter (default "open"). */
	state?: string
	token: string
	baseUrl?: string
	fetchImpl?: typeof fetch
	/** Hard cap on total issues (default 1000) to bound pagination runtime. */
	maxTotal?: number
}

/** Normalize one raw GitHub issue payload; undefined for PRs / garbage. */
export function toIssue(raw: unknown): GitHubIssue | undefined {
	if (raw === null || typeof raw !== "object") {
		return undefined
	}
	const r = raw as {
		number?: unknown
		title?: unknown
		body?: unknown
		labels?: unknown
		updated_at?: unknown
		html_url?: unknown
		pull_request?: unknown
	}
	// The /issues endpoint returns pull requests too — filter them out.
	if (r.pull_request !== undefined) {
		return undefined
	}
	const number = Number(r.number)
	if (!Number.isInteger(number) || number <= 0) {
		return undefined
	}
	const labels = Array.isArray(r.labels)
		? (r.labels as unknown[])
				.filter(
					(l): l is { name: string } =>
						l !== null && typeof l === "object" && typeof (l as { name?: unknown }).name === "string",
				)
				.map((l) => l.name)
		: []
	return {
		number,
		title: typeof r.title === "string" ? r.title : String(r.title ?? ""),
		...(typeof r.body === "string" ? { body: r.body } : {}),
		labels,
		...(typeof r.updated_at === "string" ? { updated_at: r.updated_at } : {}),
		...(typeof r.html_url === "string" ? { html_url: r.html_url } : {}),
	}
}

/**
 * List issues filtered by label (plus state), PRs filtered out, paginated via
 * a simple per_page/page loop (per_page=100 until a short page), capped at
 * `maxTotal` to bound runtime.
 */
export async function listIssues(options: ListIssuesOptions): Promise<GitHubIssue[]> {
	const { owner, repo, label, state = "open", token, baseUrl, fetchImpl, maxTotal = DEFAULT_MAX_ISSUES } = options

	const issues: GitHubIssue[] = []
	let page = 1

	while (issues.length < maxTotal) {
		const url = buildGhUrl(
			baseUrl ?? process.env.GITHUB_API_BASE_URL ?? DEFAULT_GH_BASE_URL,
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
			{
				per_page: ISSUES_PAGE_SIZE,
				page,
				state,
				labels: label,
			},
		)
		const raw = await ghApi(url, { token, baseUrl, fetchImpl })
		const batch = Array.isArray(raw) ? raw : []
		for (const entry of batch) {
			const issue = toIssue(entry)
			if (issue) {
				issues.push(issue)
				if (issues.length >= maxTotal) {
					break
				}
			}
		}
		// A short page (or an empty one) means we've reached the end.
		if (batch.length < ISSUES_PAGE_SIZE) {
			break
		}
		page++
	}

	return issues
}

/**
 * Fetch one issue by number. Used when an issue was only referenced by
 * number (e.g. a webhook payload or a plain-number trigger).
 */
export async function getIssue(
	owner: string,
	repo: string,
	number: number,
	options: GhRequestOptions,
): Promise<GitHubIssue> {
	const raw = await ghApi(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, options)
	const issue = toIssue(raw)
	if (!issue) {
		throw new Error(`GitHub API: issue #${number} in ${owner}/${repo} is not a usable issue (or is a PR)`)
	}
	return issue
}

/**
 * Add a label to an issue (POST /repos/{o}/{r}/issues/{n}/labels). Used by
 * the documented label-marking idempotency strategy — the default watcher
 * relies on the state file and does not call this.
 */
export async function addLabel(
	owner: string,
	repo: string,
	number: number,
	label: string,
	options: GhRequestOptions,
): Promise<void> {
	await ghApi(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/labels`, {
		...options,
		method: "POST",
		body: { labels: [label] },
	})
}

export interface GhClientOptions {
	token: string
	baseUrl?: string
	fetchImpl?: typeof fetch
}

/** The client shape the watcher consumes (DI-friendly for tests). */
export interface GhClient {
	listIssues(options: { owner: string; repo: string; label?: string; state?: string }): Promise<GitHubIssue[]>
	getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue>
	addLabel(owner: string, repo: string, number: number, label: string): Promise<void>
}

/** Build a GhClient bound to a token/base URL (or injectable fetch). */
export function createGhClient(options: GhClientOptions): GhClient {
	const { token, baseUrl, fetchImpl } = options
	return {
		listIssues: (o) => listIssues({ ...o, token, baseUrl, fetchImpl }),
		getIssue: (owner, repo, number) => getIssue(owner, repo, number, { token, baseUrl, fetchImpl }),
		addLabel: (owner, repo, number, label) => addLabel(owner, repo, number, label, { token, baseUrl, fetchImpl }),
	}
}
