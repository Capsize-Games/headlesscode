import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as assert from "node:assert"
import { execFileSync } from "node:child_process"

import {
	allClaimsVerified,
	extractClaims,
	firstUnverifiedDetail,
	resolveClaimPath,
	verifyClaims,
	type ClaimVerification,
} from "../claims.js"
import { resolvePermissions } from "../../permissions/config.js"

/** Deterministic tmp workspace per test. */
async function makeTmpWorkspace(files: Record<string, string> = {}): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "claims-test-"))
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel)
		await fsp.mkdir(path.dirname(full), { recursive: true })
		await fsp.writeFile(full, content)
	}
	return dir
}

const emptyPerms = (): ReturnType<typeof resolvePermissions> =>
	resolvePermissions({ workspaceRoot: "/tmp", env: {} })

// --- extractClaims ---------------------------------------------------------

function testExtractsFileExistenceClaims(): void {
	const claims = extractClaims(
		"I implemented kernel/e1000.curlee and added a Makefile target scripts/run-e1000.sh. Also wrote docs/e1000.md.",
	)
	const fileClaims = claims.filter((c) => c.kind === "file_exists")
	assert.ok(fileClaims.length >= 3, `expected >=3 file claims, got ${JSON.stringify(claims)}`)
	const paths = fileClaims.map((c) => (c as { path: string }).path)
	assert.ok(paths.includes("kernel/e1000.curlee"))
	assert.ok(paths.includes("scripts/run-e1000.sh"))
	assert.ok(paths.includes("docs/e1000.md"))
}

function testIgnoresBarePathMentionsWithoutVerbs(): void {
	// "read kernel/e1000.curlee" is not a claim the model WROTE it — no
	// affirmative creation/change verb, so no file-existence claim.
	const claims = extractClaims("I read kernel/e1000.curlee and kernel/net_stack.curlee for reference.")
	assert.equal(claims.filter((c) => c.kind === "file_exists").length, 0)
}

function testExtractsCommandPassedClaims(): void {
	const claims = extractClaims(
		"All three hard gates pass: make check passed cleanly, make qemu-e1000-smoke passed, and npm test succeeded.",
	)
	const cmdClaims = claims.filter((c) => c.kind === "command_passed") as { command: string }[]
	const cmds = cmdClaims.map((c) => c.command)
	assert.ok(cmds.includes("make check"), `expected make check, got ${JSON.stringify(cmds)}`)
	assert.ok(cmds.includes("make qemu-e1000-smoke"), `expected qemu-e1000-smoke, got ${JSON.stringify(cmds)}`)
	assert.ok(cmds.includes("npm test"), `expected npm test, got ${JSON.stringify(cmds)}`)
}

function testExtractsSerialMarkersOnlyWhenSerialMentioned(): void {
	// Serial/log context present → markers extracted.
	const withSerial = extractClaims("The serial log shows E1000: 1 then E1000: 2 — the gate passed.")
	assert.equal(withSerial.filter((c) => c.kind === "serial_marker").length, 1)
	const markers = (withSerial.find((c) => c.kind === "serial_marker") as { markers: string[] }).markers
	assert.deepEqual(markers, ["E1000: 1", "E1000: 2"])

	// No serial/log context → numbers not extracted as markers.
	const noSerial = extractClaims("The score was 1 out of 2 on the dashboard.")
	assert.equal(noSerial.filter((c) => c.kind === "serial_marker").length, 0)
}

function testExtractsPrUrlClaims(): void {
	const claims = extractClaims("Opened PR #123 — see https://github.com/example/repo/pull/123.")
	const prClaims = claims.filter((c) => c.kind === "pr_url") as { prNumber: string }[]
	assert.ok(prClaims.some((c) => c.prNumber === "123"))
}

function testDeduplicatesClaims(): void {
	const claims = extractClaims("make check passed. make check passed again. make check passed three times.")
	const cmdClaims = claims.filter((c) => c.kind === "command_passed")
	assert.equal(cmdClaims.length, 1, "identical command claims must dedupe")
}

// --- verifyClaims ----------------------------------------------------------

async function testFileExistsVerifiedAgainstDisk(): Promise<void> {
	const ws = await makeTmpWorkspace({ "kernel/e1000.curlee": "fn main() -> Int { return 0; }\n" })
	const results = await verifyClaims([{ kind: "file_exists", path: "kernel/e1000.curlee" }], {
		workspaceRoot: ws,
		permissions: emptyPerms(),
	})
	assert.equal(results[0]?.verified, true, `expected verified, got ${JSON.stringify(results[0])}`)

	const missing = await verifyClaims([{ kind: "file_exists", path: "kernel/never_written.curlee" }], {
		workspaceRoot: ws,
		permissions: emptyPerms(),
	})
	assert.equal(missing[0]?.verified, false)
	assert.match(missing[0]?.detail ?? "", /no file/)
	await fsp.rm(ws, { recursive: true, force: true })
}

async function testEmptyFileClaimFails(): Promise<void> {
	const ws = await makeTmpWorkspace({ "stub.curlee": "" })
	const results = await verifyClaims([{ kind: "file_exists", path: "stub.curlee" }], {
		workspaceRoot: ws,
		permissions: emptyPerms(),
	})
	assert.equal(results[0]?.verified, false, "an empty stub must not satisfy a file claim")
	assert.match(results[0]?.detail ?? "", /empty/)
	await fsp.rm(ws, { recursive: true, force: true })
}

async function testCommandClaimRerunPasses(): Promise<void> {
	const ws = await makeTmpWorkspace({})
	const results = await verifyClaims([{ kind: "command_passed", command: "true" }], {
		workspaceRoot: ws,
		permissions: emptyPerms(),
	})
	assert.equal(results[0]?.verified, true, `expected verified, got ${JSON.stringify(results[0])}`)
	await fsp.rm(ws, { recursive: true, force: true })
}

async function testCommandClaimRerunFails(): Promise<void> {
	const ws = await makeTmpWorkspace({})
	const results = await verifyClaims([{ kind: "command_passed", command: "exit 1" }], {
		workspaceRoot: ws,
		permissions: emptyPerms(),
	})
	assert.equal(results[0]?.verified, false)
	assert.match(results[0]?.detail ?? "", /exit code 1/)
	await fsp.rm(ws, { recursive: true, force: true })
}

// Finding 3 (review round 1): plan A2's "exit 0 + claimed output marker"
// was only half-implemented — extraction never populated expectedMarker, so
// a claim like "make check passed" verified on exit 0 alone. Now a command
// whose pass-phrase names a specific output marker (quoted token, or an
// all-caps word) must ALSO have that marker present in the re-run's output.

// Extract: a quoted marker in the pass phrase becomes expectedMarker.
function testExtractsExpectedMarkerFromQuotedToken(): void {
	const claims = extractClaims("make check passed with 'ALL CHECKS OK'.")
	const cmd = claims.find((c) => c.kind === "command_passed") as
		| { command: string; expectedMarker?: string }
		| undefined
	assert.ok(cmd, "expected a command claim")
	assert.equal(cmd.command, "make check")
	assert.equal(cmd.expectedMarker, "ALL CHECKS OK", "quoted marker must be extracted")
}

// Extract: an all-caps word in the pass phrase becomes expectedMarker.
function testExtractsExpectedMarkerFromAllCapsWord(): void {
	const claims = extractClaims("npm test passed: all tests PASS.")
	const cmd = claims.find((c) => c.kind === "command_passed") as
		| { command: string; expectedMarker?: string }
		| undefined
	assert.ok(cmd, "expected a command claim")
	assert.equal(cmd.command, "npm test")
	assert.equal(cmd.expectedMarker, "PASS", "all-caps marker must be extracted")
}

// Extract: lowercase adjectives are NOT output markers (they describe the
// pass, they don't name a token) — "passed cleanly" keeps expectedMarker
// unset so it verifies on exit 0 alone.
function testLowercasePassPhraseDoesNotBecomeMarker(): void {
	const claims = extractClaims("make check passed cleanly.")
	const cmd = claims.find((c) => c.kind === "command_passed") as
		| { command: string; expectedMarker?: string }
		| undefined
	assert.ok(cmd, "expected a command claim")
	assert.equal(cmd.expectedMarker, undefined, "lowercase adjectives are not output markers")
}

// Verify: exit 0 but the claimed marker is missing from the output → FAIL
// (the exact half-implementation the finding called out).
async function testCommandClaimExitZeroButMissingMarkerFails(): Promise<void> {
	const ws = await makeTmpWorkspace({})
	// The command exits 0 but prints nothing resembling "PASS".
	const results = await verifyClaims(
		[{ kind: "command_passed", command: "printf 'all good\\n'", expectedMarker: "PASS" }],
		{ workspaceRoot: ws, permissions: emptyPerms() },
	)
	assert.equal(results[0]?.verified, false, "exit 0 without the claimed marker must NOT verify")
	assert.match(results[0]?.detail ?? "", /lacks expected marker/)
	await fsp.rm(ws, { recursive: true, force: true })
}

// Verify: exit 0 AND the marker is present → verified.
async function testCommandClaimExitZeroWithMarkerPasses(): Promise<void> {
	const ws = await makeTmpWorkspace({})
	const results = await verifyClaims(
		[{ kind: "command_passed", command: "printf 'ALL CHECKS OK\\n'", expectedMarker: "ALL CHECKS OK" }],
		{ workspaceRoot: ws, permissions: emptyPerms() },
	)
	assert.equal(results[0]?.verified, true, `expected verified, got ${JSON.stringify(results[0])}`)
	await fsp.rm(ws, { recursive: true, force: true })
}

// Non-blocking (review round 1): resolveClaimPath must reject any claim path
// that would escape the workspace — a `../` traversal and an absolute path.
function testResolveClaimPathRejectsEscapes(): void {
	const root = "/tmp/claims-root-ws"
	// A `../` traversal resolves outside the root → null.
	assert.equal(resolveClaimPath(root, "../etc/passwd"), null)
	// An absolute path is never workspace-relative → null.
	assert.equal(resolveClaimPath(root, "/etc/passwd"), null)
	// An absolute path under the root is also rejected (claims are relative).
	assert.equal(resolveClaimPath(root, root + "/kernel/e1000.curlee"), null)
	// A legit workspace-relative path resolves inside the root.
	const resolved = resolveClaimPath(root, "kernel/e1000.curlee")
	assert.ok(resolved, "a workspace-relative path must resolve")
	assert.ok(resolved!.startsWith(root + "/"), "resolved path stays inside the workspace")
}

async function testCommandClaimRefusedByPermissionGate(): Promise<void> {
	const ws = await makeTmpWorkspace({})
	const perms = resolvePermissions({
		workspaceRoot: ws,
		env: { HEADLESSCODE_DENIED_COMMANDS: "rm -rf" },
	})
	const results = await verifyClaims([{ kind: "command_passed", command: "rm -rf /tmp/something" }], {
		workspaceRoot: ws,
		permissions: perms,
	})
	assert.equal(results[0]?.verified, false, "denied commands must not be re-run — refuse, never verify")
	assert.match(results[0]?.detail ?? "", /permission gate/)
	await fsp.rm(ws, { recursive: true, force: true })
}

async function testCommandClaimNonexistentCommandFails(): Promise<void> {
	const ws = await makeTmpWorkspace({})
	const results = await verifyClaims([{ kind: "command_passed", command: "this-command-does-not-exist-xyz" }], {
		workspaceRoot: ws,
		permissions: emptyPerms(),
	})
	assert.equal(results[0]?.verified, false)
	await fsp.rm(ws, { recursive: true, force: true })
}

async function testSerialMarkerVerifiedAgainstLog(): Promise<void> {
	const ws = await makeTmpWorkspace({
		"build/serial-e1000.log": "boot...\nE1000: 1\nE1000: 2\nHello World from JOE!\n",
	})
	const results = await verifyClaims([{ kind: "serial_marker", markers: ["E1000: 1", "E1000: 2"] }], {
		workspaceRoot: ws,
		permissions: emptyPerms(),
	})
	assert.equal(results[0]?.verified, true, `expected verified, got ${JSON.stringify(results[0])}`)

	// Missing marker fails.
	const missing = await verifyClaims([{ kind: "serial_marker", markers: ["E1000: 1", "E1000: 9"] }], {
		workspaceRoot: ws,
		permissions: emptyPerms(),
	})
	assert.equal(missing[0]?.verified, false)
	assert.match(missing[0]?.detail ?? "", /lacks marker/)

	// Wrong order fails.
	const unordered = await verifyClaims([{ kind: "serial_marker", markers: ["E1000: 2", "E1000: 1"] }], {
		workspaceRoot: ws,
		permissions: emptyPerms(),
	})
	assert.equal(unordered[0]?.verified, false)
	assert.match(unordered[0]?.detail ?? "", /not in claimed order/)
	await fsp.rm(ws, { recursive: true, force: true })
}

async function testSerialMarkerNoLogFails(): Promise<void> {
	const ws = await makeTmpWorkspace({})
	const results = await verifyClaims([{ kind: "serial_marker", markers: ["E1000: 1"] }], {
		workspaceRoot: ws,
		permissions: emptyPerms(),
	})
	assert.equal(results[0]?.verified, false)
	assert.match(results[0]?.detail ?? "", /no build\/serial-.*\.log/)
	await fsp.rm(ws, { recursive: true, force: true })
}

async function testPrUrlVerifiedAgainstGitHistory(): Promise<void> {
	// Build a tiny git repo with a commit mentioning PR #42.
	const ws = await makeTmpWorkspace({})
	await fsp.writeFile(path.join(ws, "README.md"), "hi\n")
	const git = (args: string[]): void => {
		execFileSync("git", ["-C", ws, ...args], { stdio: "pipe" })
	}
	git(["init", "-q"])
	git(["add", "."])
	git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fix #42: e1000 driver"])

	const results = await verifyClaims([{ kind: "pr_url", prNumber: "42" }], {
		workspaceRoot: ws,
		permissions: emptyPerms(),
	})
	assert.equal(results[0]?.verified, true, `expected verified, got ${JSON.stringify(results[0])}`)

	const bad = await verifyClaims([{ kind: "pr_url", prNumber: "999" }], {
		workspaceRoot: ws,
		permissions: emptyPerms(),
	})
	assert.equal(bad[0]?.verified, false)
	await fsp.rm(ws, { recursive: true, force: true })
}

function testAllClaimsVerifiedHelpers(): void {
	const ok: ClaimVerification = {
		claim: { kind: "file_exists", path: "x" },
		verified: true,
		detail: "x",
	}
	const bad: ClaimVerification = { claim: { kind: "file_exists", path: "y" }, verified: false, detail: "nope" }
	// Empty set is NOT "all verified" (fail-closed).
	assert.equal(allClaimsVerified([]), false)
	assert.equal(allClaimsVerified([ok, ok]), true)
	assert.equal(allClaimsVerified([ok, bad]), false)
	assert.equal(firstUnverifiedDetail([ok, bad]), "nope")
}

// --- runner ----------------------------------------------------------------

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [
	{ name: "extract: file-existence claims", fn: testExtractsFileExistenceClaims },
	{ name: "extract: bare path mentions without verbs ignored", fn: testIgnoresBarePathMentionsWithoutVerbs },
	{ name: "extract: command-passed claims", fn: testExtractsCommandPassedClaims },
	{ name: "extract: serial markers only when serial mentioned", fn: testExtractsSerialMarkersOnlyWhenSerialMentioned },
	{ name: "extract: PR URL claims", fn: testExtractsPrUrlClaims },
	{ name: "extract: dedupe identical claims", fn: testDeduplicatesClaims },
	{ name: "verify: file exists against disk", fn: testFileExistsVerifiedAgainstDisk },
	{ name: "verify: empty file fails", fn: testEmptyFileClaimFails },
	{ name: "verify: command re-run passes", fn: testCommandClaimRerunPasses },
	{ name: "verify: command re-run fails on non-zero exit", fn: testCommandClaimRerunFails },
	{ name: "extract: quoted token in pass phrase becomes expectedMarker", fn: testExtractsExpectedMarkerFromQuotedToken },
	{ name: "extract: all-caps word in pass phrase becomes expectedMarker", fn: testExtractsExpectedMarkerFromAllCapsWord },
	{ name: "extract: lowercase adjectives are not output markers", fn: testLowercasePassPhraseDoesNotBecomeMarker },
	{ name: "verify: exit 0 but missing claimed marker FAILS", fn: testCommandClaimExitZeroButMissingMarkerFails },
	{ name: "verify: exit 0 with the claimed marker passes", fn: testCommandClaimExitZeroWithMarkerPasses },
	{ name: "resolveClaimPath: ../ traversal and absolute paths rejected", fn: testResolveClaimPathRejectsEscapes },
	{ name: "verify: denied command refused, never re-run", fn: testCommandClaimRefusedByPermissionGate },
	{ name: "verify: nonexistent command fails", fn: testCommandClaimNonexistentCommandFails },
	{ name: "verify: serial markers against newest serial log", fn: testSerialMarkerVerifiedAgainstLog },
	{ name: "verify: no serial log fails closed", fn: testSerialMarkerNoLogFails },
	{ name: "verify: PR number against real git history", fn: testPrUrlVerifiedAgainstGitHistory },
	{ name: "helpers: allClaimsVerified / firstUnverifiedDetail", fn: testAllClaimsVerifiedHelpers },
]

async function run(): Promise<void> {
	let failed = 0
	for (const t of tests) {
		try {
			await t.fn()
			console.log(`PASS ${t.name}`)
		} catch (err) {
			failed++
			console.error(`FAIL ${t.name}`)
			console.error(err instanceof Error ? err.message : String(err))
		}
	}
	if (failed > 0) {
		process.exitCode = 1
		console.error(`\n${failed}/${tests.length} tests failed`)
	} else {
		console.log(`\nAll ${tests.length} claims tests passed`)
	}
}

void run()
