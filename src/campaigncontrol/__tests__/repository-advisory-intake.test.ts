import assert from "node:assert/strict"
import { OsvCommitAdvisoryIntake } from "../repository-advisory-intake.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

async function testPinnedCommitPollFollowsBoundedPagesAndDeduplicatesAliases(): Promise<void> {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = []
	const intake = new OsvCommitAdvisoryIntake({ fetch: async (url, body) => {
		const parsed = JSON.parse(body) as Record<string, unknown>
		calls.push({ url, body: parsed })
		const page = parsed.page_token === "next" ? { vulns: [{ id: "OSV-2026-2", aliases: ["CVE-2026-2222"], summary: "Second", affected: [] }] } : {
			vulns: [{ id: "GHSA-2345-2345-2345", aliases: ["CVE-2026-1111"], summary: " First\n advisory ",
				affected: [{ package: { ecosystem: "crates.io", name: "curl" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "9.2.3" }] }] }] }],
			next_page_token: "next",
		}
		return { status: 200, body: Buffer.from(JSON.stringify(page)) }
	} })
	const rows = await intake.poll("a".repeat(40))
	assert.deepEqual(calls.map((call) => call.body), [{ commit: "a".repeat(40) }, { commit: "a".repeat(40), page_token: "next" }])
	assert.ok(calls.every((call) => call.url === "https://api.osv.dev/v1/query"))
	assert.deepEqual(rows.map((row) => row.advisoryId), ["CVE-2026-1111", "CVE-2026-2222"])
	assert.equal(rows[0]?.summary, "First advisory")
	assert.equal(rows[0]?.sourceUrl, "https://osv.dev/vulnerability/CVE-2026-1111")
	assert.equal(rows[0]?.snapshotSha256.length, 64)
}

async function testPinnedCommitPollRejectsUnboundedOrInvalidResponses(): Promise<void> {
	const intake = new OsvCommitAdvisoryIntake({ maxPages: 1, fetch: async () => ({ status: 200,
		body: Buffer.from(JSON.stringify({ vulns: [], next_page_token: "more" })) }) })
	await assert.rejects(intake.poll("bad"), /pinned public upstream commit/)
	await assert.rejects(intake.poll("b".repeat(40)), /page limit/)
	const invalid = new OsvCommitAdvisoryIntake({ fetch: async () => ({ status: 200, body: Buffer.from("{}") }) })
	await assert.rejects(invalid.poll("c".repeat(40)), /schema is invalid/)
}

const tests: readonly SuiteTest[] = [
	["OSV commit intake follows bounded pages and deduplicates canonical CVE aliases", testPinnedCommitPollFollowsBoundedPagesAndDeduplicatesAliases],
	["OSV commit intake rejects invalid identity, truncated pagination, and malformed feed responses", testPinnedCommitPollRejectsUnboundedOrInvalidResponses],
]

await runMain("repository-advisory-intake", tests)
