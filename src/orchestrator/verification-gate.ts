import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { eventsFilePath } from "../engine/events.js"

// Bookkeeping artifacts the harness itself writes into a worktree — never
// real work, must not count as "the group changed something".
export const HARNESS_ARTIFACT_RE =
	/^(\.harness\.|harness\.log$|qa\.log$|review\.log$|\.env$|ORCHESTRATOR_TASK\.md$|\.headlesscode\/)/

/**
 * Deterministic, un-hallucinate-able gate: does this worktree actually
 * contain any real change at all? Run directly by the orchestrator's own
 * git commands — never asked of an LLM — before either runReviewStep or
 * runQaStep ever trusts a "clean"/"pass" verdict.
 *
 * Verified live 2026-08-28 (joeos issue #26): a review session fabricated
 * an ENTIRE false completion — invented commit counts, invented diff
 * stats ("8691 insertions... across 47 files"), invented passing test
 * output, even a fabricated GitHub PR link — and declared VERDICT: CLEAN
 * via the structured, supposedly-authoritative verdict line, for a
 * worktree that in reality had ZERO commits and ZERO changes. No amount
 * of parser hardening closes this: the fabrication was coherent,
 * well-formatted prose: the model's own summary is not a source of
 * truth about what really happened. This checks the actual filesystem/
 * git state instead, which the model cannot talk its way around.
 *
 * Checks BOTH: (1) committed changes vs the tracked upstream (mirrors
 * exactly what worker/review/QA sessions are themselves told to check
 * via `git diff origin/master...HEAD`), and (2) uncommitted working-tree
 * changes — a worker's write_to_file calls land in the real working tree
 * with nothing forcing it to also commit them, so a committed-only check
 * could false-negative on real, uncommitted work. Ignores the harness's
 * own bookkeeping files (harness.log, .env, etc.) via HARNESS_ARTIFACT_RE
 * — those exist in every worktree regardless of whether real work
 * happened and must never count as "changed something".
 */
export function hasRealWorktreeChanges(wtPath: string): boolean {
	let upstream = "origin/master"
	try {
		const tracked = execFileSync(
			"git",
			["-C", wtPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
			{ encoding: "utf-8", timeout: 5000 },
		).trim()
		if (tracked) {
			upstream = tracked
		}
	} catch {
		// No tracked upstream configured — fall back to origin/master.
	}
	try {
		const diffStat = execFileSync("git", ["-C", wtPath, "diff", `${upstream}...HEAD`, "--stat"], {
			encoding: "utf-8",
			timeout: 10_000,
		}).trim()
		if (diffStat.length > 0) {
			return true
		}
	} catch {
		// A failed diff isn't proof of "no changes" — fall through to the
		// working-tree check below rather than assume real work happened.
	}
	try {
		const status = execFileSync("git", ["-C", wtPath, "status", "--porcelain"], {
			encoding: "utf-8",
			timeout: 10_000,
		})
		for (const line of status.split("\n")) {
			const filePath = line.slice(3).trim()
			if (filePath && !HARNESS_ARTIFACT_RE.test(filePath)) {
				return true
			}
		}
	} catch {
		// Can't determine either way — err toward NOT trusting an
		// unverifiable "clean" (return false, same as "no changes found").
	}
	return false
}

/**
 * Tier 2 of the same 2026-08-28 incident's fix (see hasRealWorktreeChanges):
 * A "clean"/"pass" verdict is checked against the review/QA session's own
 * event transcript, never its summary prose. With an operator command policy,
 * every required command must have a matching, correlated successful result.
 * With no policy, compatibility mode establishes only that some command
 * activity succeeded; it is explicitly labeled legacy-command-activity-only,
 * not independent verification. Missing logs or incomplete correlations fail
 * closed. The ordinary local event feed is writable by the session and is not
 * a signed external-verifier result.
 */
export type VerificationActivity = "required-commands-passed" | "legacy-command-activity-only" | "unverified"

export function parseRequiredCommandIdentities(value = process.env.HEADLESSCODE_REQUIRED_VERIFICATION_COMMANDS_SHA256): string[] | undefined {
	if (value === undefined || value.trim() === "") return undefined
	const identities = value.split(",").map((item) => item.trim().toLowerCase())
	if (identities.some((identity) => !/^[a-f0-9]{64}$/.test(identity))) {
		throw new Error("HEADLESSCODE_REQUIRED_VERIFICATION_COMMANDS_SHA256 must be a comma-separated list of SHA-256 command identities")
	}
	return [...new Set(identities)]
}

export function commandIdentity(command: string): string {
	return createHash("sha256").update(command, "utf8").digest("hex")
}

export function assessVerificationActivity(
	workspaceRoot: string,
	reportPath: string | undefined,
	requiredCommandIdentities = parseRequiredCommandIdentities(),
): VerificationActivity {
	if (!reportPath) {
		return "unverified"
	}
	const sessionId = path.basename(reportPath, ".md")
	const eventsPath = eventsFilePath(workspaceRoot, sessionId)
	let raw: string
	try {
		raw = fs.readFileSync(eventsPath, "utf-8")
	} catch {
		return "unverified"
	}
	const calls = new Map<string, { commandIdentity: string; order: number }>()
	const results: Array<{ callId: string; commandIdentity: string; successful: boolean; order: number }> = []
	let order = 0
	for (const line of raw.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) {
			continue
		}
		let record: { type?: unknown; tool?: unknown; isError?: unknown; callId?: unknown; commandIdentity?: unknown }
		try {
			record = JSON.parse(trimmed)
		} catch {
			continue
		}
		order++
		if (record.tool !== "execute_command" || typeof record.callId !== "string" || !/^[a-f0-9]{64}$/.test(String(record.commandIdentity))) continue
		if (record.type === "tool_call") {
			if (!calls.has(record.callId)) calls.set(record.callId, { commandIdentity: String(record.commandIdentity), order })
		} else if (record.type === "tool_result") {
			results.push({ callId: record.callId, commandIdentity: String(record.commandIdentity), successful: record.isError === false, order })
		}
	}
	const passed = new Set<string>()
	for (const result of results) {
		const call = calls.get(result.callId)
		if (call && call.order < result.order && call.commandIdentity === result.commandIdentity && result.successful) passed.add(result.commandIdentity)
	}
	if (requiredCommandIdentities !== undefined) {
		return requiredCommandIdentities.length > 0 && requiredCommandIdentities.every((identity) => passed.has(identity))
			? "required-commands-passed"
			: "unverified"
	}
	return passed.size > 0 ? "legacy-command-activity-only" : "unverified"
}

/** Compatibility gate; callers should use assessVerificationActivity when the evidence mode matters. */
export function hasRealVerificationActivity(workspaceRoot: string, reportPath: string | undefined): boolean {
	return assessVerificationActivity(workspaceRoot, reportPath) !== "unverified"
}
