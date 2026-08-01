/**
 * Unit tests for command allow/deny + dangerous-substitution decisions
 * (src/permissions/commands.ts). Plain assert-based script (no test framework,
 * no network), run via `npm test` -> `tsx src/permissions/__tests__/commands.test.ts`.
 *
 * Covers: dangerous substitutions always refused regardless of config; deny
 * wins over allow (longest-prefix-match, ties to deny); default-ALLOW when the
 * allow-list is unset; compound commands (&&/;/|) checked per sub-command; and
 * the faithful `getCommandDecision` port (upstream decision vocabulary).
 */

import assert from "node:assert/strict"

import {
	checkCommand,
	containsDangerousSubstitution,
	decideCommand,
	findLongestPrefixMatch,
	getCommandDecision,
	parseCommand,
} from "../commands.js"

// ─── (a) dangerous substitutions are always refused, regardless of config ───

async function testDangerousSubstitutionsAlwaysDenied(): Promise<void> {
	const dangerous = [
		'echo "${var@P}"', // prompt-string expansion
		'echo "${var@Q}"', // quote removal
		'echo "${x@E}"', // escape expansion
		'echo "${!var}"', // indirect expansion
		"cat <<<$(id)", // here-string with command substitution
		"cat <<<`id`", // here-string with backtick substitution
		"=(whoami)", // zsh process substitution that executes a command
		"rm -rf *(e:whoami:)", // zsh glob qualifier with code execution
		'echo "${x=\\140id\\140}"', // assignment with escape-embedded backtick
	]
	for (const cmd of dangerous) {
		assert.equal(containsDangerousSubstitution(cmd), true, `containsDangerousSubstitution(${cmd}) should be true`)
		// Refused even with an allow-list that would otherwise permit the prefix…
		assert.equal(decideCommand(cmd, ["echo", "cat", "rm"], []), "deny", `decideCommand(${cmd}, allow) should deny`)
		// …and refused even with ZERO config (default-allow still never covers these).
		assert.equal(decideCommand(cmd, [], []), "deny", `decideCommand(${cmd}, no config) should deny`)
		const refusal = checkCommand(cmd, ["echo", "cat", "rm"], [])
		assert.ok(refusal !== null && refusal.kind === "dangerous", `checkCommand(${cmd}) should be kind=dangerous`)
	}

	// Control: ordinary commands are NOT flagged.
	assert.equal(containsDangerousSubstitution("echo hi"), false)
	assert.equal(containsDangerousSubstitution("git status"), false)
}

// ─── (b) deny-list match refused even when also allow-listed ────────────────

async function testDenyWinsOverAllow(): Promise<void> {
	// More specific deny beats a shorter allow (longest-prefix-match).
	assert.equal(decideCommand("git push origin", ["git"], ["git push"]), "deny")
	// More specific allow beats a shorter deny.
	assert.equal(decideCommand("git push --dry-run", ["git push --dry-run"], ["git push"]), "allow")
	// Tie (equal-length matches) goes to deny.
	assert.equal(decideCommand("rm x", ["rm"], ["rm"]), "deny")
	// Deny in a compound chain blocks the whole command.
	assert.equal(decideCommand("echo hi && rm -rf /", ["echo"], ["rm"]), "deny")
	assert.equal(decideCommand("echo hi && rm -rf /", ["rm"], ["rm"]), "deny")

	const refusal = checkCommand("git push origin", ["git"], ["git push"])
	assert.ok(refusal !== null && refusal.kind === "denied", "checkCommand should report kind=denied")
	assert.equal(refusal.subCommand, "git push origin", "refusal must name the offending sub-command")
	assert.equal(refusal.pattern, "git push", "refusal must name the matched deny pattern")
}

// ─── (c) allow-list-only commands pass; default-ALLOW when list unset ───────

async function testAllowListSemantics(): Promise<void> {
	// Explicit allow-list: matching commands pass.
	assert.equal(decideCommand("echo hi", ["echo"], []), "allow")
	assert.equal(decideCommand("git status", ["git"], []), "allow")
	// Allow-list configured but a command doesn't match it: denied (a headless
	// harness has no human to ask, so "ask_user" is refused).
	assert.equal(decideCommand("rm x", ["git"], []), "deny")
	const notAllowed = checkCommand("rm x", ["git"], [])
	assert.ok(notAllowed !== null && notAllowed.kind === "not_allowed", "non-matching command with allow-list = not_allowed")

	// DEFAULT-ALLOW (deliberate, documented decision): empty allow-list means
	// "allow everything except the deny-list" — preserves pre-permissions
	// behavior for sessions that configure nothing.
	assert.equal(decideCommand("rm -rf /", [], []), "allow", "empty allow + empty deny = default-allow")
	assert.equal(decideCommand("echo hi", [], []), "allow")
	// deniedCommands ALWAYS applies, even when the empty allow-list would
	// otherwise allow everything else.
	assert.equal(decideCommand("rm -rf /", [], ["rm"]), "deny")
	assert.equal(decideCommand("echo hi", [], ["rm"]), "allow")
}

// ─── (d) compound commands checked per sub-command, not as one opaque string ─

async function testCompoundCommandsCheckedPerSubCommand(): Promise<void> {
	// `echo hi` is allowed but the chained `rm -rf /` is not — must be caught.
	assert.equal(decideCommand("echo hi && rm -rf /", ["echo"], []), "deny")
	assert.equal(decideCommand("echo hi; rm -rf /", ["echo"], []), "deny")
	assert.equal(decideCommand("echo hi || rm -rf /", ["echo"], []), "deny")
	assert.equal(decideCommand("ls | rm -rf /", ["ls"], []), "deny")
	assert.equal(decideCommand("echo hi & rm -rf /", ["echo"], []), "deny")
	// When every sub-command is allowed, the chain passes.
	assert.equal(decideCommand("echo hi && rm -rf /", ["echo", "rm"], []), "allow")
	// Quoted operators are NOT separators — single sub-command.
	assert.equal(decideCommand('echo "a && b"', ["echo"], []), "allow")

	assert.deepEqual(parseCommand("echo hi && rm -rf /").commands, ["echo hi", "rm -rf /"])
	assert.deepEqual(parseCommand("echo hi; rm -rf /").commands, ["echo hi", "rm -rf /"])
	assert.deepEqual(parseCommand("echo hi | head -1").commands, ["echo hi", "head -1"])
	assert.deepEqual(parseCommand('echo "a && b"').commands, ['echo "a && b"'])
	// Subshell contents are promoted to their own sub-command (reference behavior).
	assert.deepEqual(parseCommand("echo $(rm -rf /)").commands, ["echo", "rm -rf /"])

	// Malformed commands (unterminated quote) are refused, never auto-run.
	const malformed = parseCommand('echo "unterminated')
	assert.ok(malformed.parseError !== null, "unterminated quote must produce a parseError")
	assert.equal(decideCommand('echo "unterminated', ["echo"], []), "deny")
	const malformedRefusal = checkCommand('echo "unterminated', ["echo"], [])
	assert.ok(malformedRefusal !== null && malformedRefusal.kind === "malformed", "malformed = kind malformed")
}

// ─── upstream getCommandDecision port parity ────────────────────────────────

async function testGetCommandDecisionPortParity(): Promise<void> {
	assert.equal(getCommandDecision("", [], []), "auto_approve")
	assert.equal(getCommandDecision("git status", ["git"], []), "auto_approve")
	assert.equal(getCommandDecision('echo "${var@P}"', ["echo"], []), "ask_user") // never auto-approved
	assert.equal(getCommandDecision("git push origin", ["git"], ["git push"]), "auto_deny")
	assert.equal(getCommandDecision("git status && rm file", ["git"], ["rm"]), "auto_deny")
	assert.equal(getCommandDecision("unknown command", ["git"], ["rm"]), "ask_user")
	assert.equal(getCommandDecision('echo "unterminated', ["echo"], []), "malformed_command")
}

// ─── findLongestPrefixMatch port parity ─────────────────────────────────────

async function testFindLongestPrefixMatch(): Promise<void> {
	assert.equal(findLongestPrefixMatch("git push origin", ["git", "git push"]), "git push")
	assert.equal(findLongestPrefixMatch("npm install", ["*", "npm"]), "npm", "specific match beats wildcard")
	assert.equal(findLongestPrefixMatch("unknown command", ["git", "npm"]), null)
	assert.equal(findLongestPrefixMatch("rm -rf /", ["rm"]), "rm")
	assert.equal(findLongestPrefixMatch("", ["git"]), null)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["dangerous substitutions always denied regardless of config", testDangerousSubstitutionsAlwaysDenied],
	["deny-list match refused even when also allow-listed (longest-prefix-match, tie->deny)", testDenyWinsOverAllow],
	["allow-list-only commands pass; default-ALLOW when list unset; deny always applies", testAllowListSemantics],
	["compound commands (&&/;||/|/&) checked per sub-command; malformed refused", testCompoundCommandsCheckedPerSubCommand],
	["getCommandDecision port matches upstream decision vocabulary", testGetCommandDecisionPortParity],
	["findLongestPrefixMatch port matches upstream semantics", testFindLongestPrefixMatch],
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
	console.log(`\nAll ${tests.length} command-permissions tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
