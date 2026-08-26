/**
 * UwUChatMemoryStore — the harness-side client for the future AIRunner/UwUChat
 * memory API (Phase 3). See docs/memory-uwuchat-contract.md for the full
 * endpoint contract + the data-isolation guarantee.
 *
 * STATUS: awaiting the AIRunner endpoints. Until a base URL + token are
 * provided, every method throws a typed `UwUChatMemoryError` with the message
 * "not implemented — awaiting AIRunner endpoint". Once `UWUCHAT_BASE_URL` (and
 * optionally `UWUCHAT_TOKEN`) are set, the store fetches the documented
 * endpoints with native `fetch` and Bearer-token auth.
 *
 * It implements the SAME `MemoryStore` interface as `LocalMemoryStore`, so the
 * harness can swap backends without changing any caller.
 */

import type { Embedder, FactInput, MemoryFact, MemoryStore, RecallResult, SessionSummary } from "./types.js"

export interface UwUChatMemoryOptions {
	/** AIRunner/UwUChat base URL. Default: $UWUCHAT_BASE_URL. */
	baseUrl?: string
	/** Scoped service token. Default: $UWUCHAT_TOKEN. */
	token?: string
	/** Injectable fetch (tests use a fake; default: global fetch). */
	fetchImpl?: typeof fetch
	/** Unused here (embeddings are computed harness-side per the spec). */
	embedder?: Embedder
}

/** Typed error for UwUChat API failures. */
export class UwUChatMemoryError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly body?: unknown,
	) {
		super(message)
		this.name = "UwUChatMemoryError"
	}
}

/** Base path prefix for all harness memory endpoints on the AIRunner side. */
export const API_PREFIX = "/api/v1/harness/memory"

export class UwUChatMemoryStore implements MemoryStore {
	readonly baseUrl: string
	private readonly token: string | undefined
	private readonly fetchImpl: typeof fetch

	constructor(options: UwUChatMemoryOptions = {}) {
		this.baseUrl = (options.baseUrl ?? process.env.UWUCHAT_BASE_URL ?? "").replace(/\/+$/, "")
		this.token = options.token ?? process.env.UWUCHAT_TOKEN
		this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
	}

	/** Build the absolute URL for an API path under the memory prefix. */
	endpoint(apiPath: string): string {
		return `${this.baseUrl}${apiPath}`
	}

	/** Auth + content headers (Bearer token when configured). */
	authHeaders(): Record<string, string> {
		const headers: Record<string, string> = { "Content-Type": "application/json" }
		if (this.token) {
			headers["Authorization"] = `Bearer ${this.token}`
		}
		return headers
	}

	private ensureConfigured(): void {
		if (!this.baseUrl) {
			throw new UwUChatMemoryError(
				"UwUChatMemoryStore: not implemented — awaiting AIRunner endpoint (set UWUCHAT_BASE_URL and, if required, UWUCHAT_TOKEN)",
			)
		}
	}

	private async request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
		this.ensureConfigured()
		const init: RequestInit = { method, headers: this.authHeaders() }
		if (body !== undefined) {
			init.body = JSON.stringify(body)
		}

		let response: Response
		try {
			response = await this.fetchImpl(this.endpoint(apiPath), init)
		} catch (error) {
			throw new UwUChatMemoryError(
				`UwUChat ${method} ${apiPath} request failed: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		if (!response.ok) {
			let bodyText = ""
			try {
				bodyText = await response.text()
			} catch {
				// ignore body read errors
			}
			throw new UwUChatMemoryError(
				`UwUChat ${method} ${apiPath} failed with status ${response.status}`,
				response.status,
				bodyText,
			)
		}

		try {
			return (await response.json()) as T
		} catch (error) {
			throw new UwUChatMemoryError(`UwUChat ${method} ${apiPath} returned invalid JSON`, response.status)
		}
	}

	// ─── MemoryStore implementation (project-scoped) ─────────────────────────

	async listFacts(project: string): Promise<MemoryFact[]> {
		const data = await this.request<{ facts?: MemoryFact[] }>(
			"GET",
			`${API_PREFIX}/facts?project=${encodeURIComponent(project)}`,
		)
		return data.facts ?? []
	}

	async addFact(project: string, factInput: FactInput): Promise<MemoryFact> {
		const data = await this.request<{ fact: MemoryFact }>("POST", `${API_PREFIX}/record-fact`, {
			project,
			fact: factInput,
		})
		return data.fact
	}

	async queryRecall(project: string, query: string, limit = 5): Promise<RecallResult> {
		const data = await this.request<RecallResult>("POST", `${API_PREFIX}/query-recall`, { project, query, limit })
		return { facts: data.facts ?? [], summaries: data.summaries ?? [] }
	}

	async recordSession(project: string, summary: SessionSummary): Promise<void> {
		await this.request<{ ok?: boolean }>("POST", `${API_PREFIX}/record-session`, { project, session: summary })
	}

	async listSessions(project: string): Promise<SessionSummary[]> {
		const data = await this.request<{ sessions?: SessionSummary[] }>(
			"GET",
			`${API_PREFIX}/sessions?project=${encodeURIComponent(project)}`,
		)
		return data.sessions ?? []
	}

	async summarize(project: string, options: { maxEntries?: number } = {}): Promise<string> {
		const query = new URLSearchParams({ project })
		if (options.maxEntries !== undefined) {
			query.set("maxEntries", String(options.maxEntries))
		}
		const data = await this.request<{ summary: string }>("GET", `${API_PREFIX}/summaries?${query.toString()}`)
		return data.summary
	}
}
