/**
 * List repositories accessible to a GitHub App installation.
 *
 * `GET /installation/repositories` — the endpoint a future "choose a project"
 * UI would call to populate a repo picker. This task only needs the
 * underlying function + a way to exercise it (the `provision` CLI prints the
 * list with --list-repos; a future UI can call listInstallationRepos directly).
 *
 * The response shape is documented by GitHub
 * (https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation):
 * `{ total_count, repositories: [{ name, full_name, default_branch, ... }] }`.
 * We normalize to a minimal shape — callers never see raw GitHub payloads.
 */

/** A repository an installation can access (normalized, minimal). */
export interface InstallationRepo {
	owner: string
	name: string
	fullName: string
	defaultBranch: string
}

const DEFAULT_PAGE_SIZE = 100

interface ListInstallationReposOptions {
	/** The function that supplies a fresh installation access token. */
	getToken: () => Promise<string>
	baseUrl?: string
	fetchImpl?: typeof fetch
	/** Hard cap on total repos fetched (bounds pagination runtime). */
	maxTotal?: number
}

interface RawRepo {
	name?: unknown
	full_name?: unknown
	default_branch?: unknown
}

/** Normalize one raw repository payload; undefined for garbage. */
export function toInstallationRepo(raw: unknown): InstallationRepo | undefined {
	if (raw === null || typeof raw !== "object") {
		return undefined
	}
	const r = raw as RawRepo
	if (typeof r.name !== "string" || r.name === "") {
		return undefined
	}
	if (typeof r.full_name !== "string" || !r.full_name.includes("/")) {
		return undefined
	}
	const [owner, name] = r.full_name.split("/")
	if (!owner || name !== r.name) {
		return undefined
	}
	return {
		owner,
		name: r.name,
		fullName: r.full_name,
		defaultBranch: typeof r.default_branch === "string" && r.default_branch !== "" ? r.default_branch : "main",
	}
}

/**
 * List repositories accessible to the app installation, paginated
 * (per_page=100 until a short page), capped at `maxTotal` to bound runtime.
 * Requires the App's Metadata (read-only) permission — the only permission
 * GitHub requires for this endpoint beyond the ones already granted.
 */
export async function listInstallationRepos(
	installationId: number | string,
	options: ListInstallationReposOptions,
): Promise<InstallationRepo[]> {
	const { getToken, baseUrl, fetchImpl = fetch, maxTotal = 1000 } = options
	const token = await getToken()

	const apiBase = (baseUrl ?? "https://api.github.com").replace(/\/+$/, "")
	const repos: InstallationRepo[] = []
	let page = 1

	while (repos.length < maxTotal) {
		const url = `${apiBase}/installation/repositories?per_page=${DEFAULT_PAGE_SIZE}&page=${page}`
		let response: Response
		try {
			response = await fetchImpl(url, {
				method: "GET",
				headers: {
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					Authorization: `Bearer ${token}`,
					"User-Agent": "headlesscode-provision",
				},
			})
		} catch (err) {
			throw new Error(
				`GitHub API network error (GET ${url}): ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err },
			)
		}

		if (!response.ok) {
			let message = `GitHub API HTTP ${response.status} for GET ${url}`
			try {
				const payload = (await response.json()) as { message?: unknown }
				if (typeof payload?.message === "string" && payload.message !== "") {
					message = `${payload.message} (HTTP ${response.status})`
				}
			} catch {
				// body is not JSON — keep the generic message
			}
			throw new Error(message)
		}

		const raw = (await response.json()) as { repositories?: unknown }
		const batch = Array.isArray(raw?.repositories) ? raw.repositories : []
		for (const entry of batch) {
			const repo = toInstallationRepo(entry)
			if (repo) {
				repos.push(repo)
				if (repos.length >= maxTotal) {
					break
				}
			}
		}
		// A short page (or an empty one) means we've reached the end.
		if (batch.length < DEFAULT_PAGE_SIZE) {
			break
		}
		page++
	}

	return repos
}
