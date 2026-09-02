/**
 * Evidence-gated completion — the fabrication-fix core (2026-09-01).
 *
 * The FINAL_REPORT's central finding (joeos_finetune_data/FINAL_REPORT.md,
 * §4): a real headlesscode session reported complete success with a
 * fabricated QEMU serial log excerpt ("E1000: 1 / E1000: 2") claiming three
 * hard gates passed, when the driver file was never merged and the claimed
 * `make qemu-e1000-smoke` target did not even exist. Every pre-existing
 * completion guardrail was token-based — it checked *wording* (did the last
 * command fail? did any write tool ever get called?), never *ground truth*
 * (does the file the model names exist with the content implied? did the
 * exact command the model names actually run and pass?).
 *
 * This module closes that gap with the same philosophy the orchestrator's
 * verification-gate.ts already applies to review/QA verdicts: the model's
 * own prose is never a source of truth about what really happened. Ground
 * truth comes from the filesystem and real re-runs, never from the report.
 *
 * Two stages:
 *
 *   1. `extractClaims` — conservatively parse an attempt_completion result
 *      for machine-checkable claims. ONLY claims that are BOTH specific
 *      (name a concrete file, command, marker, or PR) AND verifiable get
 *      extracted. Vague prose ("the driver works") is not a checkable claim
 *      and never gates — but it also can never *pass* a gate.
 *   2. `verifyClaims` — check each extracted claim against ground truth:
 *        file_exists   → fs.stat on the resolved path (path-safety enforced)
 *        command_passed→ RE-RUN the exact command through the same
 *                        permission gate as execute_command, require exit 0
 *                        (+ optional expected output marker)
 *        serial_marker → grep the newest build/serial-*.log for the claimed
 *                        ordered markers (mirrors the qemu-smoke gate idiom)
 *        pr_url        → only verified if the PR number appears in real
 *                        git history (a real gh/git side effect); else
 *                        fail-closed
 *
 * Fail-closed posture throughout: a claim that cannot be verified (missing
 * file, failed re-run, no serial log, no git evidence) is UNVERIFIED, never
 * "probably fine". The loop refuses the completion and names the specific
 * unverified claim so the model has something concrete to fix.
 */

import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { execFile } from "node:child_process"

import { checkCommand, checkRedirectEscape } from "../permissions/commands.js"
import type { PermissionsConfig } from "../permissions/config.js"
import { BASH_PATH } from "../tools/executor.js"

/** A machine-checkable claim extracted from an attempt_completion result. */
export type ExtractedClaim =
	| {
			kind: "file_exists"
			/** The workspace-relative path the result claims exists (posix). */
			path: string
	  }
	| {
			kind: "command_passed"
			/** The exact command the result claims passed (re-run verbatim). */
			command: string
			/** Optional output marker the re-run must contain (e.g. "PASS"). */
			expectedMarker?: string
	  }
	| {
			kind: "serial_marker"
			/** The claimed ordered markers, e.g. ["E1000: 1", "E1000: 2"]. */
			markers: string[]
	  }
	| {
			kind: "pr_url"
			/** The claimed pull-request number. */
			prNumber: string
	  }

/** One claim's verification outcome. */
export interface ClaimVerification {
	claim: ExtractedClaim
	/** True only when ground truth positively confirms the claim. */
	verified: boolean
	/** Human-readable evidence for the verdict (fed to the deferral nudge). */
	detail: string
}

/** Options for verifyClaims (the loop resolves these from session config). */
export interface ClaimVerificationOptions {
	workspaceRoot: string
	permissions: PermissionsConfig
	/** Cap on a single re-verification command's runtime, seconds (default 60). */
	commandTimeoutS?: number
}

/**
 * Conservative extraction of machine-checkable claims from a completion
 * result. See the module doc for the "specific AND verifiable" rule — this
 * deliberately does NOT extract bare `make <target>` mentions, bare file
 * paths, or bare numbers; each requires an affirmative claim verb nearby.
 */
export function extractClaims(result: string): ExtractedClaim[] {
	const claims: ExtractedClaim[] = []
	const seen = new Set<string>()

	const add = (c: ExtractedClaim, key: string) => {
		if (!seen.has(key)) {
			seen.add(key)
			claims.push(c)
		}
	}

	// --- File-existence claims ---------------------------------------------
	// "wrote/created/added/updated/edited/implemented kernel/foo.curlee" —
	// a concrete source-ish file path + an affirmative creation/change verb.
	// A bounded gap between the verb and the path is allowed ("added a Makefile
	// target scripts/run-e1000.sh" — 3 filler words), but the path itself must
	// still be a real workspace-relative source-like file.
	const fileVerb =
		/\b(?:wrote|created|added|updated|edited|implemented|landed|merged|writes?|creates?|updates?|edits?)\b(?:\s+[A-Za-z0-9_-]+){0,4}\s+([A-Za-z0-9_./-]+\.(?:curlee|ts|js|py|sh|c|h|rs|go|json|md|mk))\b/gi
	for (const m of result.matchAll(fileVerb)) {
		const raw = m[1] as string
		// Only workspace-relative-looking paths (never absolute /tmp or $HOME).
		if (raw.startsWith("/") || raw.includes("..")) {
			continue
		}
		// Skip paths that are clearly not files the model wrote (docs dirs are
		// legitimately written too, so no filter there — existence is the check).
		add({ kind: "file_exists", path: raw }, `file:${raw}`)
	}

	// --- Command-passed claims ---------------------------------------------
	// "make qemu-e1000-smoke passed" / "curlee check kernel/foo.curlee
	// passed cleanly" / "npm test passed" — the verification-shaped commands
	// this harness cares about, followed (within a bounded window) by an
	// affirmative pass verb. This is the exact class of claim the e1000
	// fabrication made ("all three hard gates pass").
	//
	// The pass-phrase group (m[3], the whole match text between the command
	// and the pass verb — e.g. "cleanly", " with all checks", " (PASS)") is
	// also scanned for a concrete output marker the re-run must CONTAIN, not
	// just exit 0 on. A claim like "make check passed cleanly" names no
	// specific marker and verifies on exit 0 alone (the marker field stays
	// unset); a claim like "make check passed with 'PASS'" (or an uppercase
	// word like "PASS"/"OK" in the pass phrase) is only verified when the
	// re-ran command's real output actually contains that token. This closes
	// plan A2's half-implementation: exit 0 alone is no longer enough when
	// the model named a specific expected output.
	const cmdClaim = /\b(make\s+[A-Za-z0-9_./-]+|npm\s+(?:test|run\s+[A-Za-z0-9_-]+)|curlee\s+(?:check|run)\s+[A-Za-z0-9_./-]+)\b([^.\n]{0,80}?)\b(pass(?:ed|es)?|clean(?:ly)?|green|succeed(?:ed)?|success)\b/gi
	for (const m of result.matchAll(cmdClaim)) {
		const command = (m[1] as string).trim()
		const between = m[2] as string
		const passPhrase = m[3] as string
		// A specific output marker the re-run's output must contain. The
		// marker usually sits AFTER the pass verb ("passed with 'PASS'",
		// "passed: all tests PASS"), so look at a bounded window of the ORIGINAL
		// result text following this match (sliced from the source, not
		// consumed by matchAll — later claims must still match independently),
		// cut at the sentence boundary. Prefer a quoted token ("passed 'PASS'",
		// "output shows 'OK'") anywhere in the claim; fall back to an all-caps
		// word ONLY in the text AFTER the pass verb ("passed: all tests PASS",
		// "passed CLEANLY"), which is the conventional shape of a real gate's
		// printed marker. The all-caps fallback deliberately never scans the
		// `between` gap or the pass verb itself — "make check in CI PASSED" or
		// an emphasized "PASSED" verb must not become an output marker.
		// Lowercase adjectives like "cleanly" / "green" are NOT output markers
		// either — they describe the pass, they don't name a token.
		const afterStart = (m.index ?? 0) + m[0].length
		const after = (result.slice(afterStart, afterStart + 60).split(/[.\n]/)[0] ?? "").trim()
		const quoted = /['"]([A-Za-z0-9][A-Za-z0-9 _.:/-]{0,40})['"]/.exec(`${between} ${passPhrase} ${after}`)
		const capped = /([A-Z]{2,})/.exec(after)
		const expectedMarker = quoted?.[1] ?? capped?.[1]
		add(
			{
				kind: "command_passed",
				command,
				...(expectedMarker ? { expectedMarker } : {}),
			},
			`cmd:${command}`,
		)
	}

	// --- Serial-marker claims ----------------------------------------------
	// The known smoke-gate marker families ("E1000: 1", "NET: 3", "JSON: 1",
	// "FB: 1", ...) when the result ALSO talks about serial/log/verification —
	// the fabricated e1000 report claimed "E1000: 1 / E1000: 2" in the serial
	// log. Extraction requires the marker family AND a nearby serial/log
	// reference so unrelated numbers never get extracted.
	const markerFamilies = /(E1000|NET|JSON|LLM|ARP|TCP|SND|RCV|TOOL|RX|FB|FR|RING):\s*\d+/g
	const mentionsSerial = /serial|log|boot|qemu/i.test(result)
	if (mentionsSerial) {
		const markers = [...result.matchAll(markerFamilies)].map((m) => m[0].trim())
		if (markers.length > 0) {
			add({ kind: "serial_marker", markers }, `markers:${markers.join("|")}`)
		}
	}

	// --- PR-URL claims -----------------------------------------------------
	// Any pull-request URL/number in a completion result is only trustworthy
	// if real git history shows it — a fabricated "PR #123" was a documented
	// incident shape (add_no_fabricated_report_examples.py). Extract and let
	// verification fail-closed.
	const prClaim = /pull\/(\d+)|PR\s*#?(\d+)/gi
	for (const m of result.matchAll(prClaim)) {
		const n = (m[1] ?? m[2]) as string
		if (n) {
			add({ kind: "pr_url", prNumber: n }, `pr:${n}`)
		}
	}

	return claims
}

/**
 * Path-safety check for a file claim: the resolved target must stay inside
 * the workspace root (mirrors the executor's resolveWithinWorkspace posture).
 */
function resolveClaimPath(workspaceRoot: string, rel: string): string | null {
	// Claims are workspace-relative ONLY — an absolute path is not a valid
	// claim path (extractClaims already filters `/`-prefixed and `..` paths
	// before they reach verification; this is defense in depth so a direct
	// caller can never resolve an absolute path into a "verified" file).
	if (path.isAbsolute(rel)) {
		return null
	}
	const resolved = path.resolve(workspaceRoot, rel)
	const root = path.resolve(workspaceRoot)
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		return null
	}
	return resolved
}

/**
 * Re-run a claimed command through the SAME permission gate as
 * execute_command (deny-list, redirect-escape) with a bounded timeout.
 * Returns { exitCode, output } — never throws for a non-zero exit (that's a
 * failed verification, not a harness crash).
 */
async function rerunCommand(
	command: string,
	opts: ClaimVerificationOptions,
): Promise<{ exitCode: number | null; output: string; refused: string | null }> {
	const timeoutS = opts.commandTimeoutS ?? 60
	// Permission gate — same checks executeCommandHandler applies (executor.ts).
	const redirectEscape = checkRedirectEscape(command, opts.workspaceRoot)
	if (redirectEscape !== null) {
		return { exitCode: null, output: "", refused: `redirect escapes workspace (${redirectEscape.operator} ${redirectEscape.word})` }
	}
	const refusal = checkCommand(command, opts.permissions.allowedCommands, opts.permissions.deniedCommands, {
		workspaceRoot: opts.workspaceRoot,
	})
	if (refusal !== null) {
		const detail =
			refusal.kind === "denied"
				? `denied (matched '${refusal.pattern ?? "?"}')`
				: refusal.kind === "redirect_escape" && refusal.redirect
					? `redirect escapes workspace (${refusal.redirect.operator} ${refusal.redirect.word})`
					: refusal.kind === "not_allowed"
						? "not on the allow-list"
						: `denied (${refusal.kind})`
		return { exitCode: null, output: "", refused: detail }
	}

	return new Promise((resolve) => {
		let stdout = ""
		let stderr = ""
		let settled = false
		const finish = (exitCode: number | null, output: string) => {
			if (!settled) {
				settled = true
				resolve({ exitCode, output, refused: null })
			}
		}
		const child = execFile(
			BASH_PATH ?? "/bin/sh",
			["-c", command],
			{ cwd: opts.workspaceRoot, timeout: timeoutS * 1000, maxBuffer: 8 * 1024 * 1024 },
			(err, so, se) => {
				stdout = so
				stderr = se
				const code = err && typeof err.code === "number" ? err.code : err ? null : 0
				finish(code, [stdout, stderr].filter(Boolean).join("\n"))
			},
		)
		// A timeout kills the child (unlike execute_command's backgrounding) —
		// verification re-runs are exactly the deterministic, bounded gates the
		// session claims to have run; there is no legitimate "background" here.
		child.on("error", () => finish(null, "spawn error during claim re-verification"))
	})
}

/**
 * Find the newest build/serial-*.log (or any *.log under build/) for
 * serial-marker claims. Mirrors the smoke-gate scripts' serial capture path.
 */
async function newestSerialLog(workspaceRoot: string): Promise<string | null> {
	const buildDir = path.join(workspaceRoot, "build")
	try {
		const entries = await fsp.readdir(buildDir)
		const logs = entries.filter((f) => /^serial-.*\.log$/.test(f) || /^serial.*\.log$/.test(f))
		if (logs.length === 0) {
			return null
		}
		// Newest by mtime.
		let best: { name: string; mtime: number } | null = null
		for (const name of logs) {
			try {
				const st = await fsp.stat(path.join(buildDir, name))
				if (!best || st.mtimeMs > best.mtime) {
					best = { name, mtime: st.mtimeMs }
				}
			} catch {
				// unreadable entry — skip
			}
		}
		return best ? path.join(buildDir, best.name) : null
	} catch {
		return null
	}
}

/** Verify one claim against ground truth. */
async function verifyClaim(
	claim: ExtractedClaim,
	opts: ClaimVerificationOptions,
): Promise<ClaimVerification> {
	switch (claim.kind) {
		case "file_exists": {
			const resolved = resolveClaimPath(opts.workspaceRoot, claim.path)
			if (!resolved) {
				return {
					claim,
					verified: false,
					detail: `claim path '${claim.path}' escapes the workspace`,
				}
			}
			try {
				const st = await fsp.stat(resolved)
				if (st.size === 0) {
					return { claim, verified: false, detail: `'${claim.path}' exists but is empty (0 bytes)` }
				}
				return { claim, verified: true, detail: `'${claim.path}' exists on disk (${st.size} bytes)` }
			} catch {
				return { claim, verified: false, detail: `no file '${claim.path}' exists on disk` }
			}
		}

		case "command_passed": {
			const { exitCode, output, refused } = await rerunCommand(claim.command, opts)
			if (refused) {
				return { claim, verified: false, detail: `re-verification refused by permission gate: ${refused}` }
			}
			if (exitCode !== 0) {
				return {
					claim,
					verified: false,
					detail: `re-ran '${claim.command}' → exit code ${exitCode ?? "unknown"}; the claimed pass is not confirmed`,
				}
			}
			if (claim.expectedMarker && !output.includes(claim.expectedMarker)) {
				return {
					claim,
					verified: false,
					detail: `re-ran '${claim.command}' → exit 0 but output lacks expected marker '${claim.expectedMarker}'`,
				}
			}
			return { claim, verified: true, detail: `re-ran '${claim.command}' → exit 0` }
		}

		case "serial_marker": {
			const logPath = await newestSerialLog(opts.workspaceRoot)
			if (!logPath) {
				return { claim, verified: false, detail: `no build/serial-*.log exists to confirm markers ${claim.markers.join(", ")}` }
			}
			try {
				const content = await fsp.readFile(logPath, "utf-8")
				const missing = claim.markers.filter((m) => !content.includes(m))
				if (missing.length > 0) {
					return {
						claim,
						verified: false,
						detail: `serial log ${path.basename(logPath)} lacks marker(s): ${missing.join(", ")}`,
					}
				}
				// Ordered check: each marker's index must be >= the previous one's.
				let last = -1
				for (const m of claim.markers) {
					const idx = content.indexOf(m)
					if (idx < last) {
						return {
							claim,
							verified: false,
							detail: `serial log ${path.basename(logPath)} has markers but not in claimed order (${m} precedes an earlier marker)`,
						}
					}
					last = idx
				}
				return { claim, verified: true, detail: `serial log ${path.basename(logPath)} contains all claimed markers in order` }
			} catch {
				return { claim, verified: false, detail: `could not read serial log ${logPath}` }
			}
		}

		case "pr_url": {
			// A PR number is only verified by real git/gh evidence: search the
			// last 50 commit subjects for the number. No gh call (avoid a
			// network dependency in a verification path) — git history is the
			// deterministic, offline ground truth for "a PR with this number
			// was actually involved".
			return new Promise((resolve) => {
				execFile(
					"git",
					["-C", opts.workspaceRoot, "log", "--oneline", "-50"],
					{ timeout: 10_000, maxBuffer: 1024 * 1024 },
					(err, stdout) => {
						if (err) {
							resolve({ claim, verified: false, detail: "no git history available to confirm PR evidence" })
							return
						}
						if (stdout.includes(`#${claim.prNumber}`) || stdout.includes(`pull/${claim.prNumber}`)) {
							resolve({ claim, verified: true, detail: `git history references PR #${claim.prNumber}` })
						} else {
							resolve({
								claim,
								verified: false,
								detail: `no git history entry references PR #${claim.prNumber} — no real PR side effect found`,
							})
						}
					},
				)
			})
		}
	}
}

/**
 * Verify a list of extracted claims against ground truth. Returns the full
 * per-claim results; the caller (the loop) treats ANY unverified claim as
 * grounds to defer the completion.
 */
export async function verifyClaims(
	claims: ExtractedClaim[],
	opts: ClaimVerificationOptions,
): Promise<ClaimVerification[]> {
	const results: ClaimVerification[] = []
	for (const claim of claims) {
		// Sequential on purpose: verification re-runs commands that share the
		// host's shell; parallel re-runs could interfere (and the count is
		// small — a completion report has at most a handful of claims).
		results.push(await verifyClaim(claim, opts))
	}
	return results
}

/** Convenience: a stable human-readable label for a claim (for deferral messages). */
export function claimLabel(claim: ExtractedClaim): string {
	switch (claim.kind) {
		case "file_exists":
			return `the file '${claim.path}' exists`
		case "command_passed":
			return `the command '${claim.command}' passed`
		case "serial_marker":
			return `the serial markers ${claim.markers.join(", ")} appear in order in a serial log`
		case "pr_url":
			return `a real PR #${claim.prNumber} exists`
	}
}

/** Convenience: did a claim set pass verification entirely? */
export function allClaimsVerified(results: ClaimVerification[]): boolean {
	return results.length > 0 && results.every((r) => r.verified)
}

/** Convenience: the first unverified claim's detail (for the deferral nudge). */
export function firstUnverifiedDetail(results: ClaimVerification[]): string | undefined {
	return results.find((r) => !r.verified)?.detail
}

/** Re-exported for tests: the workspace-path resolver (kept internal otherwise). */
export { resolveClaimPath }
