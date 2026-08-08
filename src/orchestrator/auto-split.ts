/**
 * Auto-split for oversized issues (issue #53's follow-up): the pre-flight
 * heuristic in split.ts (topLevelSectionCount) was warn-only by design
 * because a crude "count top-level bullets" signal false-positives on issues
 * that are genuinely ONE coherent piece of work with many sequential steps —
 * exploding every bullet into its own issue would be actively worse than
 * dispatching the oversized issue as-is (it fragments one fix's sequential
 * steps across unrelated issues that make no sense in isolation).
 *
 * This module replaces "warn and let a human decide" with a SEMANTIC split:
 * an LLM reads the flagged issue and proposes the smallest number of
 * independently-shippable, coherent sub-issues that partition the work (for
 * a two-part bug report like "server query is unbounded AND client loading
 * state is misleading", that's 2 sub-issues, not one per bullet). Fails
 * OPEN: any failure (LLM error, unparseable response, model proposes fewer
 * than 2 pieces meaning "this doesn't actually decompose") leaves the
 * original issue untouched and dispatches it as-is — the same behavior as
 * before this module existed. A bad split must never be worse than no split.
 */

import type { LlmClient } from "../engine/types.js"
import type { IssueSizeWarning, SplitIssue } from "./split.js"

/** One sub-issue the model proposed as an independently-shippable slice of the original. */
export interface ProposedSubIssue {
	title: string
	body: string
}

/** Never propose fewer than this many pieces — 1 means "don't split", handled as a no-op by the caller. */
const MIN_SUBISSUES = 2

/** Never propose more than this many — a runaway response must not file dozens of issues from one call. */
const MAX_SUBISSUES = 8

const SPLIT_SYSTEM_PROMPT =
	"You split an oversized GitHub issue into a SMALL number of independently-shippable sub-issues. " +
	"HARD RULES:\n" +
	"1. Group by INDEPENDENT DELIVERABLE, not by bullet point. If the issue describes N sequential steps of " +
	"ONE fix (e.g. 'step 1: add an index, step 2: change the query, step 3: verify'), those steps belong in " +
	"ONE sub-issue together — splitting sequential steps of a single fix across issues is WRONG.\n" +
	"2. Only split along boundaries where the pieces could genuinely ship, be reviewed, and be tested " +
	"independently (e.g. a server-side fix vs. a client-side fix for the same bug are usually independent; " +
	"the individual code changes inside ONE of those fixes usually are not).\n" +
	"3. If the issue is really just one coherent piece of work with a long list of steps/details — NOT " +
	`multiple independent deliverables — return a JSON array with FEWER THAN ${MIN_SUBISSUES} elements ` +
	"(e.g. an empty array) to say so. Do not force a split that doesn't exist.\n" +
	"4. Each sub-issue's body must be self-contained: include everything from the original body relevant to " +
	"that piece (file paths, line numbers, root-cause analysis, verification steps) so implementing it doesn't " +
	"require re-reading the original issue. Do not invent details the original didn't contain.\n" +
	"5. Output ONLY a JSON array of objects with exactly two string fields, \"title\" and \"body\" — no " +
	"markdown fences, no preamble, no commentary."

function buildSplitUserPrompt(issue: SplitIssue): string {
	return (
		`Issue #${issue.number}: ${issue.title}\n\n` +
		`=== BODY BEGIN ===\n${issue.body ?? "(no body)"}\n=== BODY END ===`
	)
}

/** Extract a JSON array from a model response that may still wrap it in prose or a code fence, despite rule 5. */
function extractJsonArray(text: string): unknown {
	const trimmed = text.trim()
	try {
		return JSON.parse(trimmed)
	} catch {
		// Fall back to the first [...] span — tolerates an accidental ```json fence or a stray leading sentence.
		const match = trimmed.match(/\[[\s\S]*\]/)
		if (!match) {
			throw new Error("no JSON array found in split proposal response")
		}
		return JSON.parse(match[0])
	}
}

/**
 * Ask the model to propose a semantic split for one oversized issue. Returns
 * an empty array (not an error) when the model determines the issue is
 * genuinely one coherent piece of work — that is a valid, expected outcome,
 * not a failure. Throws only on a real failure (LLM error, garbage response)
 * so the caller can distinguish "model said don't split" from "couldn't ask."
 */
export async function proposeSemanticSplit(
	issue: SplitIssue,
	llmClient: LlmClient,
	model: string,
): Promise<ProposedSubIssue[]> {
	const response = await llmClient.createChatCompletion({
		model,
		messages: [
			{ role: "system", content: SPLIT_SYSTEM_PROMPT },
			{ role: "user", content: buildSplitUserPrompt(issue) },
		],
	})
	const text = response.message.content
	if (typeof text !== "string" || text.trim() === "") {
		throw new Error("split proposal returned an empty message")
	}
	const parsed = extractJsonArray(text)
	if (!Array.isArray(parsed)) {
		throw new Error("split proposal response was not a JSON array")
	}
	const proposals: ProposedSubIssue[] = []
	for (const entry of parsed) {
		if (
			entry &&
			typeof entry === "object" &&
			typeof (entry as { title?: unknown }).title === "string" &&
			typeof (entry as { body?: unknown }).body === "string"
		) {
			proposals.push({ title: (entry as { title: string }).title, body: (entry as { body: string }).body })
		}
	}
	if (proposals.length < MIN_SUBISSUES) {
		return [] // model said (or effectively said, via malformed entries): don't split.
	}
	return proposals.slice(0, MAX_SUBISSUES)
}

/** One flagged issue's outcome, for a human-readable dispatch-time report. */
export interface AutoSplitOutcome {
	number: number
	title: string
	outcome: "split" | "kept-as-is" | "failed"
	/** Present when outcome is "split": the newly filed sub-issues. */
	created?: Array<{ number: number; title: string; url: string }>
	/** Present when outcome is "failed": why the split attempt didn't happen. */
	reason?: string
}

/**
 * For every issue flagged by the pre-flight size check, attempt a semantic
 * split and file the result as real GitHub issues, replacing the oversized
 * issue in the returned list. Fails open per-issue: any single issue's
 * failure (LLM error, filing error) falls back to keeping that issue
 * unchanged and dispatching it as-is — one bad split must never abort the
 * whole round or leave OTHER issues un-split.
 *
 * `proposeSplit`/`createIssue`/`closeParent` are injected (not hardcoded to
 * OpenRouter/gh) so this is unit-testable without network access — the real
 * orchestrate command wires them to proposeSemanticSplit/createGhIssue/a
 * `gh issue close --comment` call.
 */
export async function autoSplitOversizedIssues(
	issues: SplitIssue[],
	warnings: IssueSizeWarning[],
	deps: {
		proposeSplit: (issue: SplitIssue) => Promise<ProposedSubIssue[]>
		createIssue: (issue: SplitIssue) => { number: number; url: string }
		closeParent: (issueNumber: number, comment: string) => void
	},
): Promise<{ issues: SplitIssue[]; outcomes: AutoSplitOutcome[] }> {
	const flagged = new Set(warnings.map((w) => w.number))
	const outcomes: AutoSplitOutcome[] = []
	const next: SplitIssue[] = []

	for (const issue of issues) {
		if (!flagged.has(issue.number)) {
			next.push(issue)
			continue
		}
		let proposals: ProposedSubIssue[]
		try {
			proposals = await deps.proposeSplit(issue)
		} catch (err) {
			outcomes.push({
				number: issue.number,
				title: issue.title,
				outcome: "failed",
				reason: err instanceof Error ? err.message : String(err),
			})
			next.push(issue)
			continue
		}
		if (proposals.length < MIN_SUBISSUES) {
			outcomes.push({ number: issue.number, title: issue.title, outcome: "kept-as-is" })
			next.push(issue)
			continue
		}
		try {
			const created: Array<{ number: number; title: string; url: string }> = []
			for (const p of proposals) {
				const real = deps.createIssue({ number: -1, title: p.title, body: `${p.body}\n\n---\nSplit from #${issue.number}.` })
				created.push({ number: real.number, title: p.title, url: real.url })
				next.push({ number: real.number, title: p.title, body: p.body })
			}
			deps.closeParent(
				issue.number,
				`Auto-split into ${created.length} sub-issue(s) by headlesscode's pre-flight size check (issue #53) — ` +
					`the body read like independent pieces of work, so each is dispatched separately instead of risking an ` +
					`iteration-cap/budget burn on one worker:\n\n` +
					created.map((c) => `- #${c.number}: ${c.title}`).join("\n"),
			)
			outcomes.push({ number: issue.number, title: issue.title, outcome: "split", created })
		} catch (err) {
			outcomes.push({
				number: issue.number,
				title: issue.title,
				outcome: "failed",
				reason: err instanceof Error ? err.message : String(err),
			})
			next.push(issue)
		}
	}
	return { issues: next, outcomes }
}
