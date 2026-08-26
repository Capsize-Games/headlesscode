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
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	checkCommand,
	checkRedirectEscape,
	containsDangerousSubstitution,
	decideCommand,
	describeRedirect,
	findLongestPrefixMatch,
	getCommandDecision,
	isOutsideWorkspace,
	parseCommand,
	redirectTargets,
	resolveRedirectTarget,
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
	assert.equal(decideCommand("git status", [], []), "allow", "empty allow + empty deny = default-allow")
	assert.equal(decideCommand("echo hi", [], []), "allow")
	// ...but the always-on central-store protection still refuses recursive
	// deletes targeting the store or a PARENT of it, even with zero config —
	// `rm -rf /` (a parent of everything) and `rm -rf ~` are caught by it, not
	// by the (empty) deny-list. Full matrix in store-protection.test.ts.
	assert.equal(decideCommand("rm -rf /", [], []), "deny", "store protection refuses rm -rf / even with zero config")
	assert.equal(decideCommand("rm -rf /opt/scratch-x", [], []), "allow", "non-store targets still default-allow")
	// deniedCommands ALWAYS applies, even when the empty allow-list would
	// otherwise allow everything else.
	assert.equal(decideCommand("rm -rf /opt/scratch-x", [], ["rm"]), "deny")
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
	// When every sub-command is allowed, the chain passes (target is a
	// non-store path — the store protection only refuses store targets).
	assert.equal(decideCommand("echo hi && rm -rf /opt/scratch-x", ["echo", "rm"], []), "allow")
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

// ─── (e) redirect-escape guard (issue #122): >/>>/2>/&> outside the workspace ─

async function testRedirectEscapeAlwaysDenied(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-commands-redir-"))
	try {
		const outside = path.join(os.tmpdir(), `hc-commands-outside-${process.pid}`)
		await fs.rm(outside, { recursive: true, force: true })
		try {
			const escaping = [
				`cat > /tmp/foo.md`,
				`cat >> /tmp/foo.md`,
				`echo hi 2> /tmp/err.log`,
				`echo hi 2>> /tmp/err.log`,
				`echo hi &> /tmp/both.log`,
				`echo hi &>> /tmp/both.log`,
				`cat >| /tmp/foo.md`,
				`echo hi 2>| /tmp/err.log`,
				`echo hi > ~/out.txt`,
				`echo hi > ${outside}/out.txt`,
				`echo hi > $HC_TEST_OUTDIR/x.txt`,
				`echo hi > "${outside}/a b.txt"`,
				`echo hi > '${outside}/single.txt'`,
				`cat > /tmp/x && echo ok`, // compound: escaping sub-command blocks the chain
				`echo a > /tmp/a.txt; echo b > /tmp/b.txt`,
			]
			// $HC_TEST_OUTDIR resolves through expandEnv like any $VAR — pin it
			// to the temp dir so the escaping case is deterministic.
			const savedVar = process.env.HC_TEST_OUTDIR
			process.env.HC_TEST_OUTDIR = os.tmpdir()
			try {
				for (const cmd of escaping) {
					// Refused even with an allow-list that would otherwise permit it…
					assert.equal(
						decideCommand(cmd, ["cat", "echo", "rm"], [], { workspaceRoot: ws }),
						"deny",
						`decideCommand(${cmd}) with allow-list should deny`,
					)
					// …and with ZERO config (default-allow never covers redirect escapes).
					assert.equal(
						decideCommand(cmd, [], [], { workspaceRoot: ws }),
						"deny",
						`decideCommand(${cmd}) with zero config should deny`,
					)
					const refusal = checkCommand(cmd, ["cat", "echo", "rm"], [], { workspaceRoot: ws })
					assert.ok(
						refusal !== null && refusal.kind === "redirect_escape",
						`checkCommand(${cmd}) should be kind=redirect_escape (got ${refusal?.kind})`,
					)
					assert.ok(refusal.redirect !== undefined, "refusal must carry the offending redirect")
					assert.ok(
						isOutsideWorkspace(ws, resolveRedirectTarget(refusal.redirect.word, ws)),
						`refusal.redirect.word (${refusal.redirect.word}) must resolve outside the workspace`,
					)
				}

				// Redirects that STAY inside the workspace are allowed.
				const allowed = [
					`cat > out.txt`,
					`echo hi > ./out.txt`,
					`echo hi > ${path.join(ws, "sub")}/out.txt`,
					`echo hi >> ${ws}/out.log`,
					`echo hi 2> ${ws}/err.log`,
					`cat > "${ws}/a b.txt"`,
					`echo hi > $TMPDIR/x 2>&1`, // 2>&1 is fd duplication, NOT a path redirect
					`echo hi > out.txt && echo ok > out2.txt`,
				]
				for (const cmd of allowed) {
					assert.equal(
						decideCommand(cmd, [], [], { workspaceRoot: ws }),
						"allow",
						`decideCommand(${cmd}) should allow (target inside the workspace)`,
					)
				}

				// /dev/null and /dev/fd/* are harmless device targets — the
				// agent's routine `2>/dev/null` must not be refused.
				const deviceTargets = [
					`grep foo . 2>/dev/null`,
					`find . -name x 2>/dev/null | head`,
					`echo hi > /dev/null`,
					`echo hi 2>/dev/null 1>&2`,
					`cat x 2>/dev/fd/1`,
				]
				for (const cmd of deviceTargets) {
					assert.equal(
						decideCommand(cmd, [], [], { workspaceRoot: ws }),
						"allow",
						`decideCommand(${cmd}) should allow (/dev device target)`,
					)
				}
			} finally {
				if (savedVar === undefined) {
					delete process.env.HC_TEST_OUTDIR
				} else {
					process.env.HC_TEST_OUTDIR = savedVar
				}
			}
		} finally {
			await fs.rm(outside, { recursive: true, force: true })
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRedirectTargetParsing(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-commands-redir-parse-"))
	try {
		// Targets are extracted with quote-stripped words.
		assert.deepEqual(
			redirectTargets(`echo hi > /tmp/foo.md`).map((t) => t.word),
			["/tmp/foo.md"],
		)
		assert.deepEqual(
			redirectTargets(`echo hi >> /tmp/foo.md`).map((t) => t.word),
			["/tmp/foo.md"],
		)
		assert.deepEqual(
			redirectTargets(`echo hi 2> /tmp/err.log`).map((t) => t.word),
			["/tmp/err.log"],
		)
		assert.deepEqual(
			redirectTargets(`echo hi 2>> /tmp/err.log`).map((t) => t.word),
			["/tmp/err.log"],
		)
		assert.deepEqual(
			redirectTargets(`echo hi &> /tmp/both.log`).map((t) => t.word),
			["/tmp/both.log"],
		)
		assert.deepEqual(
			redirectTargets(`echo hi &>> /tmp/both.log`).map((t) => t.word),
			["/tmp/both.log"],
		)
		assert.deepEqual(
			redirectTargets(`cat > "${os.tmpdir()}/a b.txt"`).map((t) => t.word),
			[`${os.tmpdir()}/a b.txt`],
		)
		assert.deepEqual(
			redirectTargets(`echo a > /tmp/a.txt; echo b > /tmp/b.txt`).map((t) => t.word),
			["/tmp/a.txt", "/tmp/b.txt"],
		)
		// Input redirects (<, <<, <<<) and fd duplication (2>&1) carry no OUTPUT path.
		assert.deepEqual(redirectTargets(`cat < /etc/hostname`), [])
		assert.deepEqual(redirectTargets(`cat <<EOF\nhi\nEOF`), [])
		assert.deepEqual(redirectTargets(`cat <<< hi`), [])
		assert.deepEqual(redirectTargets(`echo hi 2>&1`), [])
		assert.deepEqual(redirectTargets(`echo hi 3>&2`), [])
		// A redirect with NO target word emits nothing (the shell would error).
		assert.deepEqual(redirectTargets(`echo hi >`), [])

		// checkRedirectEscape resolves `~` and `$VAR` against the workspace root.
		assert.notEqual(checkRedirectEscape(`echo hi > ~/x.txt`, ws), null, "~ escapes the workspace")
		assert.notEqual(checkRedirectEscape(`echo hi > $HOME/x.txt`, ws), null, "$HOME escapes the workspace")
		assert.equal(checkRedirectEscape(`echo hi > ./x.txt`, ws), null, "relative targets stay inside")
		assert.equal(checkRedirectEscape(`echo hi > out.txt`, ws), null)
		assert.equal(checkRedirectEscape(`echo hi > $TMPDIR/x 2>&1`, ws), null, "fd duplication is not a redirect target")
		// Heredoc BODY redirects are still caught (raw scan, pre-parse).
		assert.notEqual(checkRedirectEscape(`cat <<EOF\n> /tmp/x\nEOF`, ws), null, "heredoc body redirect escapes")

		// describeRedirect renders an operator + word pair for refusal messages.
		assert.equal(describeRedirect({ operator: ">", word: "/tmp/foo.md", index: 0 }), "> /tmp/foo.md")
		assert.equal(describeRedirect({ operator: ">>", word: "/tmp/foo.md", index: 0 }), ">>/tmp/foo.md")
		assert.equal(describeRedirect({ operator: "2>", word: "/tmp/err.log", index: 0 }), "2> /tmp/err.log")
		assert.equal(describeRedirect({ operator: "&>", word: "/tmp/both.log", index: 0 }), "&>/tmp/both.log")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRedirectEscapeNotOverridableByAllowList(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-commands-redir-override-"))
	try {
		// An allow-everything config does NOT bypass the redirect-escape guard.
		const refusal = checkCommand(`cat > /tmp/foo.md`, ["*", "cat"], [], { workspaceRoot: ws })
		assert.ok(refusal !== null && refusal.kind === "redirect_escape", "allow-everything config cannot override the guard")
		assert.equal(decideCommand(`cat > /tmp/foo.md`, ["*"], [], { workspaceRoot: ws }), "deny")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["dangerous substitutions always denied regardless of config", testDangerousSubstitutionsAlwaysDenied],
	["deny-list match refused even when also allow-listed (longest-prefix-match, tie->deny)", testDenyWinsOverAllow],
	["allow-list-only commands pass; default-ALLOW when list unset; deny always applies", testAllowListSemantics],
	["compound commands (&&/;||/|/&) checked per sub-command; malformed refused", testCompoundCommandsCheckedPerSubCommand],
	["getCommandDecision port matches upstream decision vocabulary", testGetCommandDecisionPortParity],
	["findLongestPrefixMatch port matches upstream semantics", testFindLongestPrefixMatch],
	["redirect-escape guard (issue #122): >/>>/2>/&> outside the workspace always denied, inside allowed", testRedirectEscapeAlwaysDenied],
	["redirect target extraction + resolution + describeRedirect", testRedirectTargetParsing],
	["redirect-escape guard is NOT overridable by an allow-everything config", testRedirectEscapeNotOverridableByAllowList],
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
