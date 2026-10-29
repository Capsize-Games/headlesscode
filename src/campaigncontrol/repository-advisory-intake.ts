import { createHash } from "node:crypto"

const OSV_QUERY_URL = "https://api.osv.dev/v1/query"
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_PAGES = 8
const MAX_RECORDS = 500
const MAX_PAGE_TOKEN = 512
const ID = /^(?:CVE-\d{4}-\d{4,12}|GHSA-[23456789cfghjmpqrvwx-]{4}-[23456789cfghjmpqrvwx-]{4}-[23456789cfghjmpqrvwx-]{4}|PYSEC-\d{4}-\d+|RUSTSEC-\d{4}-\d+)$/

export interface PublishedAdvisoryRecord {
	advisoryId: string
	snapshotSha256: string
	sourceUrl: string
	summary: string
	affectedRange: string
}

export interface OsvCommitIntakeOptions {
	fetch?: (url: string, body: string, timeoutMs: number) => Promise<{ status: number; body: Uint8Array }>
	timeoutMs?: number
	maxPages?: number
	maxRecords?: number
}

function recordId(value: unknown): string | undefined {
	if (typeof value !== "string" || !ID.test(value)) return undefined
	return value
}

function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return item
		return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
	})
}

function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex") }

function safeString(value: unknown, max: number): string {
	return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : ""
}

/** Poll only the official OSV query API for a compiled public upstream commit. */
export class OsvCommitAdvisoryIntake {
	private readonly fetcher: NonNullable<OsvCommitIntakeOptions["fetch"]>
	private readonly timeoutMs: number
	private readonly maxPages: number
	private readonly maxRecords: number

	constructor(options: OsvCommitIntakeOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? 12_000
		this.maxPages = options.maxPages ?? MAX_PAGES
		this.maxRecords = options.maxRecords ?? MAX_RECORDS
		if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000 ||
			!Number.isSafeInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > MAX_PAGES ||
			!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1 || this.maxRecords > MAX_RECORDS) throw new Error("OSV intake bounds are invalid")
		this.fetcher = options.fetch ?? defaultFetch
	}

	async poll(publicBaseRevision: string): Promise<PublishedAdvisoryRecord[]> {
		if (!/^[a-f0-9]{40}$/.test(publicBaseRevision)) throw new Error("OSV intake requires a pinned public upstream commit")
		const rows = new Map<string, PublishedAdvisoryRecord>()
		const seenTokens = new Set<string>()
		let pageToken: string | undefined
		for (let page = 0; page < this.maxPages; page++) {
			const request = { commit: publicBaseRevision, ...(pageToken ? { page_token: pageToken } : {}) }
			const body = JSON.stringify(request)
			const response = await this.fetcher(OSV_QUERY_URL, body, this.timeoutMs)
			if (response.status !== 200 || response.body.byteLength > MAX_RESPONSE_BYTES) throw new Error("OSV intake response is unavailable or exceeds its bound")
			let payload: unknown
			try { payload = JSON.parse(Buffer.from(response.body).toString("utf8")) } catch { throw new Error("OSV intake response is invalid JSON") }
			if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray((payload as any).vulns)) throw new Error("OSV intake response schema is invalid")
			const vulns = (payload as { vulns: unknown[] }).vulns
			if (vulns.length > this.maxRecords) throw new Error("OSV intake page exceeds record limit")
			for (const item of vulns) {
				if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("OSV advisory row is invalid")
				const advisory = item as Record<string, unknown>
				const aliases = [advisory.id, ...(Array.isArray(advisory.aliases) ? advisory.aliases : [])].map(recordId).filter((id): id is string => !!id)
				const advisoryId = aliases.find((id) => id.startsWith("CVE-")) ?? aliases.sort()[0]
				if (!advisoryId) continue
				const facts = { id: safeString(advisory.id, 96), aliases: [...new Set(aliases)].sort(),
					summary: safeString(advisory.summary, 1200), details: safeString(advisory.details, 12_000),
					affected: Array.isArray(advisory.affected) ? advisory.affected : [],
					modified: safeString(advisory.modified, 64), published: safeString(advisory.published, 64), withdrawn: safeString(advisory.withdrawn, 64) }
				const affectedRange = JSON.stringify(facts.affected).slice(0, 400)
				rows.set(advisoryId, { advisoryId, snapshotSha256: digest(facts), sourceUrl: `https://osv.dev/vulnerability/${encodeURIComponent(advisoryId)}`,
					summary: facts.summary || facts.details.slice(0, 1200) || "Published advisory record", affectedRange })
				if (rows.size > this.maxRecords) throw new Error("OSV intake result exceeds record limit")
			}
			const next = (payload as Record<string, unknown>).next_page_token
			if (next === undefined || next === "") return [...rows.values()].sort((a, b) => a.advisoryId.localeCompare(b.advisoryId))
			if (typeof next !== "string" || next.length > MAX_PAGE_TOKEN || seenTokens.has(next)) throw new Error("OSV intake page cursor is invalid")
			seenTokens.add(next)
			pageToken = next
		}
		throw new Error("OSV intake reached the configured page limit")
	}
}

async function defaultFetch(url: string, body: string, timeoutMs: number): Promise<{ status: number; body: Uint8Array }> {
	if (url !== OSV_QUERY_URL || Buffer.byteLength(body) > 4096) throw new Error("OSV intake request is outside its fixed scope")
	const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
		headers: { "content-type": "application/json", accept: "application/json", "user-agent": "HeadlessCode-Repository-Campaign/1.0" }, body })
	const raw = new Uint8Array(await response.arrayBuffer())
	if (raw.byteLength > MAX_RESPONSE_BYTES) throw new Error("OSV intake response exceeds its bound")
	return { status: response.status, body: raw }
}
