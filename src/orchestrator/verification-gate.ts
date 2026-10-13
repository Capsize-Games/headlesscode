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
	return worktreeChangedFiles(wtPath).length > 0
}

function upstreamRef(wtPath: string): string {
	try {
		const tracked = execFileSync(
			"git",
			["-C", wtPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
			{ encoding: "utf-8", timeout: 5000 },
		).trim()
		if (tracked) {
			return tracked
		}
	} catch {
		// No tracked upstream configured — fall back to origin/master.
	}
	return "origin/master"
}

function committedChangedFiles(wtPath: string, upstream: string): string[] {
	try {
		const names = execFileSync(
			"git",
			["-C", wtPath, "diff", `${upstream}...HEAD`, "--name-only"],
			{ encoding: "utf-8", timeout: 10_000 },
		)
		return names.split("\n").map((n) => n.trim()).filter((n) => n !== "")
	} catch {
		// A failed diff isn't proof of "no changes" — the caller still
		// checks the working tree rather than assume real work happened.
		return []
	}
}

function porcelainStatus(wtPath: string): string {
	// -uall: list untracked files individually. The default collapses a
	// new directory to "dir/", which downstream file filters (testable
	// sources for the Tier 3 review gates) would silently drop.
	const args = ["-C", wtPath, "status", "--porcelain", "-uall"]
	return execFileSync("git", args, { encoding: "utf-8", timeout: 10_000 })
}

function uncommittedChangedFiles(wtPath: string): string[] {
	try {
		const status = porcelainStatus(wtPath)
		const files: string[] = []
		for (const line of status.split("\n")) {
			const filePath = line.slice(3).trim()
			if (filePath && !HARNESS_ARTIFACT_RE.test(filePath)) {
				files.push(filePath)
			}
		}
		return files
	} catch {
		// Can't determine — the caller errs toward NOT trusting an
		// unverifiable "clean" (same as "no changes found").
		return []
	}
}

/**
 * Workspace-relative paths changed in this worktree: committed changes vs
 * the tracked upstream plus uncommitted working-tree changes, minus the
 * harness's own bookkeeping files. hasRealWorktreeChanges is exactly
 * "this list is non-empty"; the Tier 3 review gates (#137) scope test
 * selection to this list.
 */
export function worktreeChangedFiles(wtPath: string): string[] {
	const upstream = upstreamRef(wtPath)
	const seen = new Set<string>()
	const committed = committedChangedFiles(wtPath, upstream)
	const uncommitted = uncommittedChangedFiles(wtPath)
	for (const file of [...committed, ...uncommitted]) {
		if (!HARNESS_ARTIFACT_RE.test(file)) {
			seen.add(file)
		}
	}
	return [...seen].sort()
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
	const identities = value.split(",").map((item) => item.trim())
	if (identities.some((identity) => !/^[a-f0-9]{64}$/.test(identity))) {
		throw new Error("HEADLESSCODE_REQUIRED_VERIFICATION_COMMANDS_SHA256 must be a comma-separated list of SHA-256 command identities")
	}
	if (new Set(identities).size !== identities.length) throw new Error("required verification command identities must be unique")
	return identities
}

export function commandIdentity(command: string): string {
	return createHash("sha256").update(command, "utf8").digest("hex")
}

export function assessVerificationActivity(
	workspaceRoot: string,
	reportPath: string | undefined,
	requiredCommandIdentities = parseRequiredCommandIdentities(),
): VerificationActivity {
	if (requiredCommandIdentities !== undefined && (requiredCommandIdentities.some((identity) => !/^[a-f0-9]{64}$/.test(identity)) || new Set(requiredCommandIdentities).size !== requiredCommandIdentities.length)) {
		throw new Error("required command identities must be unique lowercase SHA-256 digests")
	}
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
	const calls = new Map<string, { commandIdentity: string; order: number; count: number }>()
	const results: Array<{ callId: string; commandIdentity: string; successful: boolean; order: number }> = []
	const legacySuccessfulResults = new Set<string>()
	let malformedCorrelation = false
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
		if (record.tool !== "execute_command") continue
		if (record.type === "tool_result" && record.isError === false) legacySuccessfulResults.add(typeof record.commandIdentity === "string" ? record.commandIdentity : `legacy:${order}`)
		if (!/^[a-f0-9]{64}$/.test(String(record.commandIdentity))) {
			if (requiredCommandIdentities !== undefined && (record.type === "tool_call" || record.type === "tool_result")) malformedCorrelation = true
			continue
		}
		if (typeof record.callId !== "string" || !record.callId) {
			if (requiredCommandIdentities !== undefined && (record.type === "tool_call" || record.type === "tool_result")) malformedCorrelation = true
			continue
		}
		if (record.type === "tool_call") {
			const previous = calls.get(record.callId)
			if (previous) {
				previous.count++
				malformedCorrelation = true
			} else calls.set(record.callId, { commandIdentity: String(record.commandIdentity), order, count: 1 })
		} else if (record.type === "tool_result") {
			results.push({ callId: record.callId, commandIdentity: String(record.commandIdentity), successful: record.isError === false, order })
		}
	}
	const passed = new Set<string>()
	const resultIds = new Set<string>()
	for (const result of results) {
		const call = calls.get(result.callId)
		if (resultIds.has(result.callId)) malformedCorrelation = true
		resultIds.add(result.callId)
		if (!call || call.count !== 1 || call.order >= result.order || call.commandIdentity !== result.commandIdentity) {
			if (requiredCommandIdentities?.includes(result.commandIdentity) || (call && requiredCommandIdentities?.includes(call.commandIdentity))) malformedCorrelation = true
			continue
		}
		if (result.successful) passed.add(result.commandIdentity)
	}
	if (requiredCommandIdentities !== undefined) {
		return !malformedCorrelation && requiredCommandIdentities.length > 0 && requiredCommandIdentities.every((identity) => passed.has(identity))
			? "required-commands-passed"
			: "unverified"
	}
	return passed.size > 0 || legacySuccessfulResults.size > 0 ? "legacy-command-activity-only" : "unverified"
}

/** Compatibility gate; callers should use assessVerificationActivity when the evidence mode matters. */
export function hasRealVerificationActivity(workspaceRoot: string, reportPath: string | undefined): boolean {
	return assessVerificationActivity(workspaceRoot, reportPath) !== "unverified"
}
