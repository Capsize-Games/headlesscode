/**
 * Unit tests for src/orchestrator/pipeline.ts — the stage-isolated pipeline
 * sequencing layer (issue #148).
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` → `tsx src/orchestrator/__tests__/pipeline.test.ts`.
 *
 * Covers the pure, deterministic pieces:
 *   - parseFilingResult extracts real issue numbers from a filing session's
 *     required `ISSUES: n1, n2` line AND from real `gh issue create` URLs,
 *     and fail-closes (status "error") when no verifiable number is present.
 *   - The research task text names the artifact path pattern, the required
 *     sections, and forbids `/tmp` writes (the standing workspace rule).
 *   - The filing task text embeds the research doc content (the artifact,
 *     not a conversation) and requires the `ISSUES:` line.
 */

import assert from "node:assert/strict"

import {
	DEFAULT_RESEARCH_ARTIFACT_PATTERN,
	FILER_MODE,
	RESEARCH_MODE,
	defaultFilingTaskText,
	defaultResearchTaskText,
	parseFilingResult,
} from "../pipeline.js"

function testParseFilingResultStructuredLine(): void {
	// The required `ISSUES:` line is authoritative.
	const r = parseFilingResult(
		"Filed issue for the finding.\n\nISSUES: 147, 148\n",
	)
	assert.equal(r.status, "ok")
	assert.deepEqual(r.issueNumbers, [147, 148], "parses both numbers from the ISSUES line")

	// Duplicates are deduped.
	const dup = parseFilingResult("ISSUES: 3, 3, 4\n")
	assert.deepEqual(dup.issueNumbers, [3, 4])
}

function testParseFilingResultUrlsFallback(): void {
	// Real `gh issue create` URLs are the fallback proof of a filing.
	const r = parseFilingResult(
		"Created https://github.com/Capsize-Games/headlesscode/issues/2049 " +
			"and https://github.com/Capsize-Games/headlesscode/issues/2050",
	)
	assert.equal(r.status, "ok")
	assert.deepEqual(r.issueNumbers, [2049, 2050])
}

function testParseFilingResultFailCloses(): void {
	// No ISSUES line, no URL → error (an unverifiable claim must not be trusted).
	const r = parseFilingResult("I filed the issues successfully! #42 was one of them")
	assert.equal(r.status, "error", "bare #42 in prose is not proof of a filed issue")
	assert.deepEqual(r.issueNumbers, [])
}

function testResearchTaskTextNamesArtifactAndSections(): void {
	const text = defaultResearchTaskText("/tmp/ws", DEFAULT_RESEARCH_ARTIFACT_PATTERN)
	assert.match(text, /research\/\*\.md/, "names the artifact path pattern")
	assert.match(text, /Finding/, "requires a Finding section")
	assert.match(text, /What to build/, "requires a What to build section")
	assert.match(text, /What NOT to do/, "requires a What NOT to do section")
	assert.match(text, /How to verify/, "requires a How to verify section")
	assert.match(text, /file:line/, "demands real file:line citations")
	assert.match(text, /NEVER write to `\/tmp`/, "forbids /tmp writes (standing workspace rule)")
	assert.match(text, /do NOT implement anything/, "scopes the session to research only")
}

function testFilingTaskTextEmbedsArtifactContent(): void {
	const content = "# Finding\n\nThe widget is broken at src/x.ts:12\n"
	const text = defaultFilingTaskText("/tmp/ws/research/finding.md", content)
	assert.match(text, /# Finding/, "embeds the research doc content (the artifact)")
	assert.match(text, /src\/x\.ts:12/, "embeds the artifact's real citations")
	assert.match(text, /gh issue create/, "instructs real gh issue create calls")
	assert.match(text, /ISSUES:/, "requires the ISSUES: line")
	assert.match(text, /do NOT investigate from scratch/, "filer does not re-investigate")
}

function testModeConstants(): void {
	assert.equal(RESEARCH_MODE, "researcher", "research stage uses the researcher mode")
	assert.equal(FILER_MODE, "issue-filer", "filing stage uses the issue-filer mode")
}

const tests: Array<[string, () => void | Promise<void>]> = [
	["parseFilingResult: ISSUES: line is authoritative + dedupes", testParseFilingResultStructuredLine],
	["parseFilingResult: real gh issue URLs are the fallback proof", testParseFilingResultUrlsFallback],
	["parseFilingResult: fail-closes when no verifiable issue number exists", testParseFilingResultFailCloses],
	["research task text names the artifact pattern + required sections + no /tmp", testResearchTaskTextNamesArtifactAndSections],
	["filing task text embeds the artifact content (not a conversation) + requires ISSUES:", testFilingTaskTextEmbedsArtifactContent],
	["mode constants match .roomodes slugs", testModeConstants],
]

async function main(): Promise<void> {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? err.stack ?? err.message : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} pipeline tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
