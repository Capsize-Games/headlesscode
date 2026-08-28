import { execFileSync } from "node:child_process"
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
 * even once real work exists to review, a "clean"/"pass" verdict is only as
 * trustworthy as the verification the session actually did. Cross-checks
 * the review/QA session's OWN event-log transcript (never re-derived from
 * its summary prose, which is exactly what was fabricated) for at least one
 * REAL, non-error `execute_command` result — the one tool that actually
 * proves something was run and checked, as opposed to read_file/list_files
 * (which only prove something was looked at). A session that declares
 * "clean"/"pass" without ever running a single successful command has
 * nothing behind that verdict but its own prose, the exact gap that let
 * the fabricated 2026-08-28 review through even with a structured,
 * required-format verdict line.
 *
 * Deliberately narrow like hasRealWorktreeChanges: this checks that SOME
 * real verification activity happened at all, not that specific claimed
 * numbers (e.g. "8691 insertions") match specific tool outputs — matching
 * every claim in free-form prose against the transcript has no realistic
 * false-positive ceiling (the exact trap parseReviewResult/parseQaResult's
 * own docs already warn against for heuristic text matching). Absent or
 * unreadable event log → false (same fail-closed posture as an empty
 * diff): a verdict this codebase cannot verify at all is never trusted.
 */
export function hasRealVerificationActivity(workspaceRoot: string, reportPath: string | undefined): boolean {
	if (!reportPath) {
		return false
	}
	const sessionId = path.basename(reportPath, ".md")
	const eventsPath = eventsFilePath(workspaceRoot, sessionId)
	let raw: string
	try {
		raw = fs.readFileSync(eventsPath, "utf-8")
	} catch {
		return false
	}
	for (const line of raw.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) {
			continue
		}
		let record: { type?: unknown; tool?: unknown; isError?: unknown }
		try {
			record = JSON.parse(trimmed)
		} catch {
			continue
		}
		if (record.type === "tool_result" && record.tool === "execute_command" && record.isError === false) {
			return true
		}
	}
	return false
}
