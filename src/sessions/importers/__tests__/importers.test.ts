import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import path from "node:path"
import { parseClaudeRecords } from "../claude.js"
import { parseCodexRecords } from "../codex.js"
import { discoverImportFiles } from "../discover.js"
import { opaque, parseJsonLines, readBoundedFile } from "../common.js"
import { parseMuseExport, parseMuseRecords } from "../muse.js"
import { importFile } from "../index.js"
import { SessionStore } from "../../store.js"
import { buildHistoryContext } from "../../context.js"

const scratchRoot = path.join(process.cwd(), ".headlesscode", "scratch")
const fixturesRoot = path.join(process.cwd(), "fixtures", "sessions")

async function readFixture(name: string): Promise<string> {
	return fs.readFile(path.join(fixturesRoot, name), "utf8")
}

async function testClaudeFixtureMapsMessagesAndToolPairs(): Promise<void> {
	const text = await readFixture("claude-transcript-v2.1.synthetic.jsonl")
	const parsed = parseClaudeRecords(parseJsonLines(Buffer.from(text), []))
	assert.equal(parsed.sessionId, "synthetic-claude-1")
	assert.deepEqual(parsed.messages.map(item => item.role), ["user", "assistant", "tool", "assistant"])
	assert.equal(parsed.messages[1]?.toolCalls?.[0]?.id, "call-1")
	assert.equal(parsed.messages[2]?.toolCallId, "call-1")
	assert.match(parsed.messages[3]?.content ?? "", /SYNTHETIC: done/)
	assert.doesNotMatch(JSON.stringify(parsed.messages), /private reasoning omitted/)
	assert.match(JSON.stringify(parsed.messages[3]?.opaque), /SYNTHETIC ENCRYPTED DATA/)
	assert.doesNotMatch(buildHistoryContext(parsed.messages).text, /SYNTHETIC ENCRYPTED DATA/)
}

async function testCodexFixtureUsesCanonicalRecordsOnly(): Promise<void> {
	const parsed = parseCodexRecords(parseJsonLines(Buffer.from(await readFixture("codex-rollout-v2026.synthetic.jsonl")), []))
	assert.equal(parsed.sessionId, "synthetic-codex-1")
	assert.deepEqual(parsed.messages.map(item => item.role), ["user", "assistant", "tool", "assistant", "assistant"])
	assert.equal(parsed.messages[0]?.content, "SYNTHETIC: calculate 2 + 2")
	assert.match(JSON.stringify(parsed.messages[0]?.opaque), /synthetic-image-1/)
	assert.doesNotMatch(JSON.stringify(parsed.messages[0]?.opaque), /private\.invalid/)
	assert.equal(parsed.messages[1]?.toolCalls?.[0]?.id, "call-2")
	assert.match(parsed.messages[1]?.toolCalls?.[0]?.arguments ?? "", /2\+2/)
	assert.equal(parsed.messages[2]?.toolCallId, "call-2")
	assert.match(JSON.stringify(parsed.messages[4]?.opaque), /SYNTHETIC CODEX ENCRYPTED DATA/)
	assert.doesNotMatch(buildHistoryContext(parsed.messages).text, /SYNTHETIC CODEX ENCRYPTED DATA/)
}

async function testMuseV1FixtureMapsSafeHistory(): Promise<void> {
	const parsed = parseMuseExport(JSON.parse(await readFixture("muse-export-v1.synthetic.json")))
	assert.equal(parsed.sessionId, "synthetic-muse-1")
	assert.equal(parsed.messages.length, 5)
	assert.equal(parsed.messages[1]?.toolCalls?.[0]?.id, "call-3")
	assert.equal(parsed.messages[2]?.toolCallId, "call-3")
	assert.match(JSON.stringify(parsed.messages), /SYNTHETIC ENCRYPTED DATA/)
	assert.doesNotMatch(buildHistoryContext(parsed.messages).text, /SYNTHETIC ENCRYPTED DATA/)
	assert.ok(parsed.warnings.some(item => /approval or permission records were omitted/.test(item)))
	assert.throws(() => parseMuseExport({ export_schema_version: 2, messages: [] }), /Unsupported Muse export schema 2/)
	assert.throws(() => parseMuseExport({ export_schema_version: 1, messages: [] }), /expected an events array/)
}

async function testBranchesSummariesAndUnmatchedCallsAreExplicit(): Promise<void> {
	const claude = parseClaudeRecords([
		{ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "SYNTHETIC: first" } },
		{ type: "summary", summary: "SYNTHETIC: compacted summary" },
		{ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: "SYNTHETIC: branch" } },
	])
	assert.ok(claude.warnings.some(item => /summary/.test(item)))
	assert.ok(claude.warnings.some(item => /branches/.test(item)))
	assert.ok(claude.messages.some(item => String(item.content).includes("compacted summary")))
	const codex = parseCodexRecords([
		{ type: "response_item", payload: { type: "function_call", call_id: "no-result", name: "synthetic", arguments: "{}" } },
		{ type: "response_item", payload: { type: "function_call_output", call_id: "no-call", output: "SYNTHETIC orphan result" } },
		{ type: "compacted", payload: { summary: "SYNTHETIC compacted" } },
	])
	assert.ok(codex.warnings.some(item => /no matching call/.test(item)))
	assert.ok(codex.warnings.some(item => /no matching result/.test(item)))
	assert.ok(codex.warnings.some(item => /compacted/.test(item)))
	assert.ok(codex.messages.some(item => String(item.content).includes("SYNTHETIC compacted")))
	const muse = parseMuseRecords([
		{ sequence: 1, recorded_at: "2026-01-15T12:00:00.000Z", payload: { session_id: "synthetic-muse-native", kind: "run", event: { kind: "summary", summary: "SYNTHETIC Muse summary" } } },
		{ sequence: 2, recorded_at: "2026-01-15T12:00:01.000Z", payload: { kind: "run", event: { kind: "tool_call", call_id: "orphan-call", name: "synthetic" } } },
	])
	assert.equal(muse.sessionId, "synthetic-muse-native")
	assert.ok(muse.warnings.some(item => /flattened into chronological history/.test(item)))
	assert.ok(muse.warnings.some(item => /no matching result/.test(item)))
	assert.ok(muse.messages.some(item => String(item.content).includes("SYNTHETIC Muse summary")))
}

async function testOpaqueOversizeFilteringAndSymlinkSource(): Promise<void> {
	const huge = JSON.parse('{"harmless":"' + "x".repeat(70_000) + '","access_token":"SYNTHETIC SECRET MUST NOT SURVIVE","__proto__":{"polluted":true}}')
	const result = JSON.stringify(opaque("synthetic", huge))
	assert.doesNotMatch(result, /SYNTHETIC SECRET MUST NOT SURVIVE/)
	assert.doesNotMatch(result, /polluted/)
	assert.match(result, /truncated/)
	await fs.mkdir(scratchRoot, { recursive: true })
	const directory = await fs.mkdtemp(path.join(scratchRoot, "import-symlink-source-"))
	const target = path.join(directory, "source.jsonl")
	const link = path.join(directory, "link.jsonl")
	try {
		await fs.writeFile(target, "{}\n")
		await fs.symlink(target, link)
		await assert.rejects(readBoundedFile(link), /contains a symlink/)
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testMalformedTailAndDeepJsonWarn(): Promise<void> {
	const warnings: string[] = []
	const nested = '{"x":'.repeat(28) + "0" + "}".repeat(28)
	const records = parseJsonLines(Buffer.from(`{\"type\":\"ok\"}\n{bad\n${nested}\n`), warnings)
	assert.equal(records.length, 1)
	assert.ok(warnings.some(item => /malformed JSON/.test(item)))
	assert.ok(warnings.some(item => /too deeply nested/.test(item)))
}

async function testLineCountLimitStopsParsing(): Promise<void> {
	const warnings: string[] = []
	const records = parseJsonLines(Buffer.from("{}\n".repeat(100_002)), warnings)
	assert.equal(records.length, 100_000)
	assert.ok(warnings.some(item => /more than 100000 lines/.test(item)))
}

async function testImportCreatesArchiveAndSafeContinuationContext(): Promise<void> {
	await fs.mkdir(scratchRoot, { recursive: true })
	const directory = await fs.mkdtemp(path.join(scratchRoot, "import-archive-"))
	const workspace = path.join(directory, "workspace")
	const data = path.join(directory, "store")
	const source = path.join(fixturesRoot, "claude-transcript-v2.1.synthetic.jsonl")
	const originalEnv = process.env.HEADLESSCODE_DATA_DIR
	try {
		await fs.mkdir(workspace, { recursive: true })
		const original = await fs.readFile(source)
		process.env.HEADLESSCODE_DATA_DIR = data
		const { archive, warnings } = await importFile("claude", source, workspace)
		assert.match(archive.id, /^[0-9a-f-]{36}$/)
		assert.equal(archive.provenance?.provider, "claude")
		assert.equal(archive.provenance?.sessionId, "synthetic-claude-1")
		assert.ok(archive.provenance?.sha256)
		assert.ok(archive.warnings.some(item => /unverified historical context/.test(item)))
		assert.ok((await new SessionStore(workspace).load(archive.id)).messages.length > 0)
		const context = buildHistoryContext(archive.messages)
		assert.match(context.text, /Historical conversation \(unverified reference only\)/)
		assert.match(context.text, /historicalToolCalls/)
		assert.equal(warnings.length, archive.warnings.length)
		assert.deepEqual(await fs.readFile(source), original)
	} finally {
		if (originalEnv === undefined) delete process.env.HEADLESSCODE_DATA_DIR
		else process.env.HEADLESSCODE_DATA_DIR = originalEnv
		await fs.rm(directory, { recursive: true, force: true })
	}
}

async function testBoundedReadRejectsOversize(): Promise<void> {
	await fs.mkdir(scratchRoot, { recursive: true })
	const directory = await fs.mkdtemp(path.join(scratchRoot, "import-limit-"))
	const source = path.join(directory, "large.jsonl")
	try {
		const handle = await fs.open(source, "w")
		try { await handle.truncate(32 * 1024 * 1024 + 1) } finally { await handle.close() }
		await assert.rejects(readBoundedFile(source), /exceeds the 33554432 byte limit/)
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testDiscoverySkipsSymlinksAndDoesNotPrintBodies(): Promise<void> {
	await fs.mkdir(scratchRoot, { recursive: true })
	const directory = await fs.mkdtemp(path.join(scratchRoot, "import-discovery-"))
	const workspace = path.join(directory, "workspace")
	const providerRoot = path.join(directory, "codex-sessions")
	const dated = path.join(providerRoot, "2026", "01", "01")
	const source = path.join(dated, "rollout.synthetic.jsonl")
	const outside = path.join(directory, "outside.jsonl")
	try {
		await fs.mkdir(workspace, { recursive: true })
		await fs.mkdir(dated, { recursive: true })
		const header = JSON.stringify({ type: "session_meta", payload: { id: "synthetic-discovery", cwd: workspace } })
		await fs.writeFile(source, `${header}\n${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "PRIVATE BODY MUST NOT DISPLAY" }] } })}\n`)
		await fs.writeFile(outside, header)
		await fs.symlink(outside, path.join(dated, "linked.jsonl"))
		const found = await discoverImportFiles("codex", { workspaceRoot: workspace, sourceRoot: providerRoot })
		assert.deepEqual(found.map(item => item.file), [source])
		assert.doesNotMatch(JSON.stringify(found), /PRIVATE BODY MUST NOT DISPLAY/)
		const cancelled = new AbortController()
		cancelled.abort(new Error("synthetic cancellation"))
		await assert.rejects(discoverImportFiles("codex", { workspaceRoot: workspace, sourceRoot: providerRoot, signal: cancelled.signal }), /synthetic cancellation/)
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testExplicitClaudeRootScopesWorkspaceUnlessAll(): Promise<void> {
	await fs.mkdir(scratchRoot, { recursive: true })
	const directory = await fs.mkdtemp(path.join(scratchRoot, "claude-discovery-scope-"))
	const workspace = path.join(directory, "workspace-a")
	const otherWorkspace = path.join(directory, "workspace-b")
	const providerRoot = path.join(directory, "claude-projects")
	try {
		await fs.mkdir(workspace, { recursive: true })
		await fs.mkdir(otherWorkspace, { recursive: true })
		await fs.mkdir(providerRoot, { recursive: true })
		const a = path.join(providerRoot, "project-a.jsonl")
		const b = path.join(providerRoot, "nested", "project-b.jsonl")
		await fs.mkdir(path.dirname(b), { recursive: true })
		await fs.writeFile(a, `${JSON.stringify({ type: "user", sessionId: "synthetic-a", cwd: workspace, message: { role: "user", content: "SYNTHETIC A" } })}\n`)
		await fs.writeFile(b, `${JSON.stringify({ type: "user", sessionId: "synthetic-b", cwd: otherWorkspace, message: { role: "user", content: "SYNTHETIC B" } })}\n`)
		const scoped = await discoverImportFiles("claude", { workspaceRoot: workspace, sourceRoot: providerRoot })
		assert.deepEqual(scoped.map(item => item.file), [a])
		const all = await discoverImportFiles("claude", { workspaceRoot: workspace, sourceRoot: providerRoot, all: true })
		assert.deepEqual(new Set(all.map(item => item.file)), new Set([a, b]))
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testDiscoveryRejectsSymlinkedRootAncestorsAndIgnoresMuseToolCwd(): Promise<void> {
	await fs.mkdir(scratchRoot, { recursive: true })
	const directory = await fs.mkdtemp(path.join(scratchRoot, "discovery-ancestors-"))
	const workspace = path.join(directory, "workspace")
	const actualRoot = path.join(directory, "actual-root")
	const symlinkParent = path.join(directory, "linked-parent")
	const linkedRoot = path.join(symlinkParent, "sessions")
	try {
		await fs.mkdir(workspace, { recursive: true })
		await fs.mkdir(path.join(actualRoot, "2026", "01", "01"), { recursive: true })
		await fs.symlink(actualRoot, symlinkParent)
		await assert.rejects(discoverImportFiles("codex", { workspaceRoot: workspace, sourceRoot: linkedRoot }), /contains a symlink/)

		const museFile = path.join(actualRoot, "2026", "01", "01", "session.jsonl")
		await fs.writeFile(museFile, `${JSON.stringify({
			sequence: 1,
			recorded_at: "2026-01-01T00:00:00.000Z",
			payload_type: "synthetic.tool.output",
			payload: { cwd: workspace, task: { workspace_root: workspace, command: "SYNTHETIC" } },
		})}\n`)
		await assert.rejects(discoverImportFiles("muse", { workspaceRoot: workspace, sourceRoot: actualRoot }), /workspace metadata discovery is not supported/)
		await assert.rejects(discoverImportFiles("muse", { workspaceRoot: workspace, all: true }), /requires an explicit --source-root/)
		const allMuse = await discoverImportFiles("muse", { workspaceRoot: workspace, sourceRoot: actualRoot, all: true })
		assert.deepEqual(allMuse.map(item => item.file), [museFile])
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

const tests: [string, () => Promise<void>][] = [
	["Claude fixture maps messages and tool pairs", testClaudeFixtureMapsMessagesAndToolPairs],
	["Codex fixture uses canonical records only", testCodexFixtureUsesCanonicalRecordsOnly],
	["Muse v1 fixture maps safe history", testMuseV1FixtureMapsSafeHistory],
	["Branches, summaries, and unmatched calls warn", testBranchesSummariesAndUnmatchedCallsAreExplicit],
	["Opaque data filters secrets before truncation and source symlinks fail", testOpaqueOversizeFilteringAndSymlinkSource],
	["Import creates archive and safe continuation context", testImportCreatesArchiveAndSafeContinuationContext],
	["Malformed tails and deep JSON warn", testMalformedTailAndDeepJsonWarn],
	["Line count limit stops parsing", testLineCountLimitStopsParsing],
	["Bounded read rejects oversized source", testBoundedReadRejectsOversize],
	["Discovery skips symlinks and hides bodies", testDiscoverySkipsSymlinksAndDoesNotPrintBodies],
	["Explicit Claude root scopes to workspace unless all is requested", testExplicitClaudeRootScopesWorkspaceUnlessAll],
	["Discovery rejects symlink ancestors and ignores arbitrary Muse cwd fields", testDiscoveryRejectsSymlinkedRootAncestorsAndIgnoresMuseToolCwd],
]

for (const [name, test] of tests) {
	await test()
	process.stdout.write(`✓ ${name}\n`)
}
process.stdout.write(`All ${tests.length} session importer tests passed\n`)
