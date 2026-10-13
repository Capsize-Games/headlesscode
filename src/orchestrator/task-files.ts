/**
 * Task-file generation (issue #128 leaf).
 *
 * The task-file builders + writeTaskFiles lived in src/orchestrator/cli.ts,
 * which the cloud providers and watcher/watch.ts need — pulling the whole
 * orchestrator CLI back in and closing import cycles. This leaf depends only
 * on node builtins + split.ts types, so providers/watch can share it
 * cycle-free; src/orchestrator/cli.ts re-exports the same names.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import type { SplitIssue, WorktreeSpec } from "./split.js"

// --- Task-file generation ---
/**
 * Rules splicing happens automatically: addCustomInstructions() (vendored,
 * src/vendor/zoo-code/src/core/prompts/sections/custom-instructions.ts) reads
 * the central store's `rules/` + `rules-<mode>/` tiers (and the project's
 * `.roo/` equivalents) into the system prompt before the first turn. Task
 * files must NOT tell the model to go read a rules file itself — on a project
 * with no project-local `.roo/rules-code/` (e.g. a fresh `headlesscode init`
 * setup) that read fails outright and burns a consecutive-mistake budget
 * before real work starts. Shared by all five task-file builders below.
 */
const RULES_SPLICED_NOTE = [
	"Project and mode-specific rules (from the central shared store and this project's own",
	".roo/rules*) are already spliced into your system prompt automatically — you do not",
	"need to read any rules file yourself.",
]

/**
 * One issue's title/body keyed by issue number as a string (JSON object keys
 * are always strings). Persisted on OrchestratorGroup at dispatch time so the
 * rework/QA/continuation task files — generated LATER from state alone, when
 * the original issue objects are no longer in hand — can embed the real
 * title/body instead of telling the worker to `gh issue view <n>` (which
 * fails outright for synthetic --issues-json numbers).
 */
export type IssueBodies = Record<string, { title: string; body?: string }>

/**
 * Render each assigned issue as an inline markdown block
 * ("### Issue #<n>: <title>\n\n<body>") for a task file — the issue title/body
 * is already in hand, so nothing needs fetching at session start. An issue
 * whose body was never recorded gets an explicit note; an issue with NO entry
 * at all falls back to the OLD `gh issue view <n>` instruction for that issue
 * only (state written before bodies were persisted — never silently produce an
 * empty assignment section).
 */
function issueBodyBlocks(
	numbers: number[],
	lookup: (n: number) => { title: string; body?: string } | undefined,
): string[] {
	const blocks: string[] = []
	for (const n of numbers) {
		const entry = lookup(n)
		if (entry === undefined) {
			blocks.push(
				`### Issue #${n}`,
				"",
				`No issue body recorded — fetch it yourself: \`gh issue view ${n}\`.`,
			)
		} else {
			blocks.push(
				`### Issue #${n}: ${entry.title}`,
				"",
				entry.body && entry.body.trim() !== ""
					? entry.body
					: "(no issue body recorded — inspect the codebase and git history for context)",
			)
		}
	}
	return blocks
}

export function buildTaskFileContent(spec: WorktreeSpec, issues: SplitIssue[]): string {
	const assigned = spec.issues.map((n) => `#${n}`).join(", ")
	const issueBlocks = issueBodyBlocks(spec.issues, (n) => issues.find((i) => i.number === n))
	return [
		...RULES_SPLICED_NOTE,
		"",
		"You are working autonomously in an isolated git worktree, on your own branch, with your own",
		"isolated environment. No human is in the loop until you open a PR. Read this entire file before",
		"doing anything.",
		"",
		"## Your assignment",
		"",
		`GitHub issues assigned to this worktree: ${assigned}. The real title/body of each is inline below.`,
		"",
		...(issueBlocks.length > 0 ? issueBlocks : ["(no issue numbers recorded — inspect the worktree for context)"]),
		"",
		"## Environment",
		"",
		`Workspace root: this worktree (branch: current branch). All file/command tools are scoped to`,
		"this worktree. Commit per logical unit with the issue number in the message.",
		"",
		"## Scratch",
		"",
		"Any scratch/temporary files (probe scripts, one-off data dumps, intermediate output) go in",
		"`<workspace>/.headlesscode/scratch/` — NEVER write to `/tmp` or any other path outside this",
		"worktree. `/.headlesscode/` is gitignored, so scratch there needs no ignore rule.",
		"",
		"## Workflow",
		"",
		"1. Read each assigned issue's inline body above and the relevant source files.",
		"2. Implement the change following the project's own conventions and the rules files.",
		"3. Verify for real (run the project's tests / boot check) and capture the output.",
		"4. Commit with the issue number referenced, one logical change per commit.",
		"5. Push the branch and open a PR (ready, not draft).",
		"6. Post the closing comment below on each issue, then close it.",
		"",
		"## Required comment template",
		"",
		"Your issue-closing comment must use this exact structure (every section present; a section can",
		"be 'N/A' with a reason, but a missing section is itself a review finding):",
		"```",
		"## Issue <n> — Closing Report",
		"",
		"### Files changed",
		"<one line per file>",
		"",
		"### Baseline (before)",
		"<real output>",
		"",
		"### Baseline (after)",
		"<real output>",
		"",
		"### Boot check",
		"<real output or exact reason it didn't apply>",
		"",
		"### Residual risk / notes",
		"<anything not 100% certain>",
		"",
		"PR: <link>",
		"```",
		"",
		"## Closing out",
		"",
		"Once every assigned issue is closed with the template above:",
		"1. Finish with attempt_completion and a full summary of what you changed, the real baseline",
		"   numbers, the boot check, and the PR link(s).",
		"2. The harness records your completion automatically (exit code + .harness.done marker) —",
		"   no separate phone-home step is needed.",
		"3. Do not start on any issue not assigned to this worktree.",
		"",
		`Scope: ${assigned} only.`,
	].join("\n")
}

/**
 * Issue #49 plan-first task content: the task file for the SHORT architect-mode
 * planning session that runs INSIDE the fresh worktree before the code worker.
 * The planner must produce a compact implementation plan (written to PLAN.md at
 * the workspace root, overwriting any previous plan) and stop — never
 * implement, never edit source, never ask the human, never switch modes. The
 * spawner appends PLAN.md into ORCHESTRATOR_TASK.md so the code worker that
 * follows executes against it. Reuses the other task files' conventions (rules
 * preamble, scope line).
 */
export function buildPlanFirstTaskFileContent(
	group: { name: string; issues?: number[] },
	/** The in-hand issues (their title/body is embedded inline). Optional for
	 * backward compatibility with callers that only have persisted state. */
	issues?: SplitIssue[],
): string {
	const assigned = (group.issues ?? []).map((n) => `#${n}`).join(", ") || "this worktree"
	const issueBlocks = issueBodyBlocks(group.issues ?? [], (n) => issues?.find((i) => i.number === n))
	return [
		...RULES_SPLICED_NOTE,
		"",
		"You are the PLANNING phase of an autonomous two-phase workflow, running in an isolated git",
		"worktree on your own branch. Your ONLY job is to produce a compact, actionable implementation",
		"plan for the code session that follows. Read this entire file before doing anything.",
		"",
		"## Your assignment (planning only — DO NOT implement)",
		"",
		`Assigned issues: ${assigned}. The real title/body of each is inline below.`,
		"",
		...(issueBlocks.length > 0
			? issueBlocks
			: ["(no issue numbers recorded — read ORCHESTRATOR_TASK.md for the full task)"]),
		"",
		"1. Read `ORCHESTRATOR_TASK.md` at the workspace root — it is the FULL task the code session",
		"   must execute. Read the assigned issues' inline bodies above.",
		"2. Explore the codebase just enough to ground the plan (grep/read the files the issues touch).",
		"3. Write the plan to `PLAN.md` at the workspace root (OVERWRITE any existing PLAN.md) as a",
		"   compact markdown document: goal, concrete steps (files + functions), verification steps",
		"   (tests/boot), and any risks. A code session will execute it — make every step something",
		"   another session can act on without re-doing your exploration.",
		"4. Finish with attempt_completion summarizing where the plan was written.",
		"",
		"## Scratch",
		"",
		"Any scratch/temporary files (probe scripts, one-off data dumps, intermediate output) go in",
		"`<workspace>/.headlesscode/scratch/` — NEVER write to `/tmp` or any other path outside this",
		"worktree. `/.headlesscode/` is gitignored, so scratch there needs no ignore rule.",
		"",
		"## Constraints",
		"",
		"- DO NOT implement anything: no source edits, no commits, no pushes, no PRs.",
		"- DO NOT ask the human questions — you are headless; decide autonomously and write the plan.",
		"- DO NOT use switch_mode — this session ends with attempt_completion, period.",
		"- Keep the plan SHORT (a compact plan beats a tome; the code session re-verifies anything it",
		"  doubts before trusting it).",
		"",
		`Scope: ${assigned} only — planning phase.`,
	].join("\n")
}

export function writeTaskFiles(
	repo: string,
	specs: WorktreeSpec[],
	issues: SplitIssue[],
	opts: { planFirst?: boolean } = {},
): string[] {
	const dir = path.join(repo, "plans", "parallel-tasks")
	fs.mkdirSync(dir, { recursive: true })
	const written: string[] = []
	for (const spec of specs) {
		const target = path.join(dir, spec.taskFile)
		fs.writeFileSync(target, buildTaskFileContent(spec, issues), "utf-8")
		written.push(target)
		if (opts.planFirst) {
			// Issue #49: the plan-first session's task file (the spawner copies
			// it into the worktree as ORCHESTRATOR_PLAN.md and runs it BEFORE
			// the code worker). Named `<name>-plan.md` — the spawner derives it
			// from the worktree name alone, so a standalone spawner invocation
			// can fall back to a generic planner prompt when it is absent.
			const planTarget = path.join(dir, `${spec.name}-plan.md`)
			fs.writeFileSync(planTarget, buildPlanFirstTaskFileContent(spec, issues), "utf-8")
			written.push(planTarget)
		}
	}
	return written
}

/**
 * Rework-loop task content (see plans/rework-loop.md): a NEW task file for a
 * group whose review came back with a "finding" verdict. Reuses the original
 * task file's structure/conventions (rules preamble, closing-report template,
 * scope) but the assignment is the reviewer's `pending_review_findings` list
 * rather than the raw issues. The worker is expected to address EVERY finding,
 * re-verify for real, and re-close/re-comment with fresh evidence per the
 * closing-report template — same contract as the first attempt.
 */
export function buildReworkTaskFileContent(
	group: { name: string; issues?: number[]; issueBodies?: IssueBodies },
	findings: string[],
	reworkCount: number,
	/** Persisted issue title/body captured at dispatch time (see
	 * OrchestratorGroup.issueBodies). Absent for state written before the
	 * bodies feature — falls back to the old `gh issue view <n>` instruction. */
	issueBodies?: IssueBodies,
): string {
	const assigned = (group.issues ?? []).map((n) => `#${n}`).join(", ") || "this worktree"
	const issueBlocks = issueBodyBlocks(group.issues ?? [], (n) => group.issueBodies?.[String(n)] ?? issueBodies?.[String(n)])
	const findingsList = findings.length > 0 ? findings.map((f, i) => `${i + 1}. ${f}`).join("\n") : ""
	return [
		...RULES_SPLICED_NOTE,
		"",
		"You are working autonomously in the SAME isolated git worktree as the previous attempt, on",
		"the same branch. The automated adversarial reviewer found problems with that attempt. Read",
		"this entire file before doing anything.",
		"",
		`## Rework cycle ${reworkCount} — address the review findings`,
		"",
		`Assigned issues: ${assigned}. The real title/body of each is inline below.`,
		"",
		...(issueBlocks.length > 0
			? issueBlocks
			: ["(no issue numbers recorded — inspect the worktree for context)"]),
		"",
		"## Review findings to fix (from the automated review)",
		"",
		...findingsList.split("\n"),
		...(findingsList === "" ? ["(no specific findings were recorded — re-read the previous attempt's", "diff and re-verify everything the reviewer might have flagged.)"] : []),
		"",
		"Your job: address EVERY finding above. Do not skip any. Do not claim a finding is fixed",
		"without reproducing the fix for real.",
		"",
		"## Scratch",
		"",
		"Any scratch/temporary files (probe scripts, one-off data dumps, intermediate output) go in",
		"`<workspace>/.headlesscode/scratch/` — NEVER write to `/tmp` or any other path outside this",
		"worktree. `/.headlesscode/` is gitignored, so scratch there needs no ignore rule.",
		"",
		"## Workflow",
		"",
		"1. Read each finding above and the relevant source files.",
		"2. Fix every finding, following the project's own conventions and the rules files.",
		"3. Re-verify for real (run the project's tests / boot check) and capture the output —",
		"   output in a report is a claim, not evidence, until reproduced.",
		"4. Commit with the issue number referenced, one logical change per commit.",
		"5. Push the branch and update the PR (or open a new one if needed).",
		"6. Post an UPDATED closing comment below on each issue using the required template, then",
		"   re-close it (or leave it open with the updated report if it must stay open).",
		"",
		"## Required comment template",
		"",
		"Your issue-closing comment must use this exact structure (every section present; a section can",
		"be 'N/A' with a reason, but a missing section is itself a review finding):",
		"```",
		`## Issue <n> — Closing Report (rework cycle ${reworkCount})`,
		"",
		"### Files changed",
		"<one line per file>",
		"",
		"### Baseline (before)",
		"<real output>",
		"",
		"### Baseline (after)",
		"<real output>",
		"",
		"### Boot check",
		"<real output or exact reason it didn't apply>",
		"",
		"### Residual risk / notes",
		"<anything not 100% certain>",
		"",
		"PR: <link>",
		"```",
		"",
		"## Closing out",
		"",
		"Once every finding is addressed and every assigned issue is re-closed with fresh evidence:",
		"1. Finish with attempt_completion and a full summary of what you changed, the real baseline",
		"   numbers, the boot check, and the PR link(s).",
		"2. The harness records your completion automatically (exit code + .harness.done marker) —",
		"   no separate phone-home step is needed.",
		"3. Do not start on any issue not assigned to this worktree.",
		"",
		`Scope: ${assigned} only — rework cycle ${reworkCount}.`,
	].join("\n")
}

/**
	* QA-fail rework task content (issue #52): a NEW task file for a group whose
	* QA session came back with a real "fail" verdict (review had passed). Same
	* structure/conventions as buildReworkTaskFileContent, but the assignment is
	* the QA evidence — what the QA session actually found and verified — rather
	* than the reviewer's findings list. The worker is expected to address every
	* piece of evidence, re-verify for real, and re-close with fresh evidence per
	* the closing-report template — same contract as the first attempt.
	*/
export function buildQaReworkTaskFileContent(
	group: { name: string; issues?: number[]; issueBodies?: IssueBodies },
	evidence: string,
	reworkCount: number,
	reportPath?: string,
	/** Persisted issue title/body captured at dispatch time (see
	 * OrchestratorGroup.issueBodies). Absent for state written before the
	 * bodies feature — falls back to the old `gh issue view <n>` instruction. */
	issueBodies?: IssueBodies,
): string {
	const assigned = (group.issues ?? []).map((n) => `#${n}`).join(", ") || "this worktree"
	const issueBlocks = issueBodyBlocks(group.issues ?? [], (n) => group.issueBodies?.[String(n)] ?? issueBodies?.[String(n)])
	// Issue #34-style: point at the QA session's COMPLETE final report so the
	// full reasoning is one file-read away (evidence is only a 4000-char slice).
	const reportLines = reportPath
		? [
				"",
				`The full QA session report is at: \`${reportPath}\` — read it for the complete`,
				"reasoning behind every finding before you start.",
		  ]
		: []
	return [
		...RULES_SPLICED_NOTE,
		"",
		"You are working autonomously in the SAME isolated git worktree as the previous attempt, on",
		"the same branch. Review passed, but the automated QA session found real problems with the",
		"attempt — treat them as NEW WORK. Read this entire file before doing anything.",
		"",
		`## Rework cycle ${reworkCount} — address the QA findings`,
		"",
		`Assigned issues: ${assigned}. The real title/body of each is inline below.`,
		"",
		...(issueBlocks.length > 0
			? issueBlocks
			: ["(no issue numbers recorded — inspect the worktree for context)"]),
		"",
		"## QA findings to fix (from the automated QA)",
		"",
		...(evidence === ""
			? [
					"(the QA report recorded no extractable evidence — re-run the QA checklist against the",
					"worktree yourself and fix whatever fails.)",
			  ]
			: [evidence]),
		...reportLines,
		"",
		"Your job: address EVERY finding above. Do not skip any. Do not claim a finding is fixed",
		"without reproducing the fix for real.",
		"",
		"## Scratch",
		"",
		"Any scratch/temporary files (probe scripts, one-off data dumps, intermediate output) go in",
		"`<workspace>/.headlesscode/scratch/` — NEVER write to `/tmp` or any other path outside this",
		"worktree. `/.headlesscode/` is gitignored, so scratch there needs no ignore rule.",
		"",
		"## Workflow",
		"",
		"1. Read each finding above and the relevant source files.",
		"2. Fix every finding, following the project's own conventions and the rules files.",
		"3. Re-verify for real (run the project's tests / boot check) and capture the output —",
		"   output in a report is a claim, not evidence, until reproduced.",
		"4. Commit with the issue number referenced, one logical change per commit.",
		"5. Push the branch and update the PR (or open a new one if needed).",
		"6. Post an UPDATED closing comment below on each issue using the required template, then",
		"   re-close it (or leave it open with the updated report if it must stay open).",
		"",
		"## Required comment template",
		"",
		"Your issue-closing comment must use this exact structure (every section present; a section can",
		"be 'N/A' with a reason, but a missing section is itself a review finding):",
		"```",
		`## Issue <n> — Closing Report (rework cycle ${reworkCount})`,
		"",
		"### Files changed",
		"<one line per file>",
		"",
		"### Baseline (before)",
		"<real output>",
		"",
		"### Baseline (after)",
		"<real output>",
		"",
		"### Boot check",
		"<real output or exact reason it didn't apply>",
		"",
		"### Residual risk / notes",
		"<anything not 100% certain>",
		"",
		"PR: <link>",
		"```",
		"",
		"## Closing out",
		"",
		"Once every finding is addressed and every assigned issue is re-closed with fresh evidence:",
		"1. Finish with attempt_completion and a full summary of what you changed, the real baseline",
		"   numbers, the boot check, and the PR link(s).",
		"2. The harness records your completion automatically (exit code + .harness.done marker) —",
		"   no separate phone-home step is needed.",
		"3. Do not start on any issue not assigned to this worktree.",
		"",
		`Scope: ${assigned} only — rework cycle ${reworkCount}.`,
	].join("\n")
}

/**
	* Continuation task content (plans/issues/02-orchestrate-iteration-plumbing.md,
	* Part 2): a NEW task file for a group whose worker exited because it hit the
	* iteration cap. The worktree is untouched and resumable — the partial edits
	* are on disk — so the next session picks up where the last left off. Reuses
	* the original task file's conventions (rules preamble, closing-report
	* template, scope) but the assignment is "keep going" rather than the raw
	* issues.
	*/
export function buildContinuationTaskFileContent(
	group: { name: string; issues?: number[]; issueBodies?: IssueBodies },
	continuationCount: number,
	/** Persisted issue title/body captured at dispatch time (see
	 * OrchestratorGroup.issueBodies). Absent for state written before the
	 * bodies feature — falls back to the old `gh issue view <n>` instruction. */
	issueBodies?: IssueBodies,
	/** The previous session's own condensed summary of its history (see
	 * src/engine/handoff.ts) — file reads, command outputs, decisions made —
	 * so this cycle doesn't have to re-derive them from scratch. Absent when
	 * the previous session's handoff write failed/didn't run (older state,
	 * or a very short session); the git-status-inspection instruction below
	 * is the fallback either way, not a redundant step. */
	handoffSummary?: string,
): string {
	const assigned = (group.issues ?? []).map((n) => `#${n}`).join(", ") || "this worktree"
	const issueBlocks = issueBodyBlocks(group.issues ?? [], (n) => group.issueBodies?.[String(n)] ?? issueBodies?.[String(n)])
	return [
		...RULES_SPLICED_NOTE,
		"",
		"You are working autonomously in the SAME isolated git worktree as the previous session(s), on",
		"the same branch. The previous session was cut short — either it hit the harness's iteration cap, or",
		"it hit a transient LLM-provider failure (a hard-pinned model with no fallback provider had a bad",
		"moment; not a fault in your task or the code). Neither is a review verdict — its partial work is",
		"still on disk: uncommitted edits, commits, notes — pick up exactly where it left off. Read this",
		"entire file before doing anything.",
		"",
		`## Continuation cycle ${continuationCount} — complete the task`,
		"",
		`Assigned issues: ${assigned}. The real title/body of each is inline below.`,
		"",
		...(issueBlocks.length > 0
			? issueBlocks
			: ["(no issue numbers recorded — inspect the worktree for context)"]),
		"",
		"## What the previous session already learned — do not re-derive this",
		"",
		...(handoffSummary
			? [
					"The previous session summarized its own history before it ran out of iterations. Trust it and",
					"build on it — re-reading files or re-running commands it already covered wastes iterations you",
					"need for finishing the actual task. It CAN be wrong (compression loses detail, and the session's",
					"own notes may be incomplete) — if something below conflicts with what you observe on disk, what",
					"you observe wins, but don't re-verify things it reports with confidence just to be safe.",
					"",
					"```",
					handoffSummary.trim(),
					"```",
				]
			: [
					"(No handoff summary available for this cycle — the previous session's write either failed or",
					"never ran. Fall back to inspecting the worktree yourself, below.)",
				]),
		"",
		"## What the previous session did",
		"",
		"- Inspect the worktree's git status, recent commits, and uncommitted changes to see exactly",
		"  how far the previous session got — this is a real-state CHECK, not your primary source of",
		"  context; the summary above should already tell you most of this.",
		"- Do NOT restart from scratch: continue the existing work toward the issues above.",
		"- If the previous session left a partial fix, finish it and verify it for real.",
		"",
		"## Scratch",
		"",
		"Any scratch/temporary files (probe scripts, one-off data dumps, intermediate output) go in",
		"`<workspace>/.headlesscode/scratch/` — NEVER write to `/tmp` or any other path outside this",
		"worktree. `/.headlesscode/` is gitignored, so scratch there needs no ignore rule.",
		"",
		"## Workflow",
		"",
		"1. Read each assigned issue's inline body above and the relevant source files.",
		"2. Continue the implementation following the project's own conventions and the rules files.",
		"3. Verify for real (run the project's tests / boot check) and capture the output —",
		"   output in a report is a claim, not evidence, until reproduced.",
		"4. Commit with the issue number referenced, one logical change per commit.",
		"5. Push the branch and open a PR (ready, not draft).",
		"6. Post the closing comment below on each issue using the required template, then close it.",
		"",
		"## Required comment template",
		"",
		"Your issue-closing comment must use this exact structure (every section present; a section can",
		"be 'N/A' with a reason, but a missing section is itself a review finding):",
		"```",
		`## Issue <n> — Closing Report (continuation cycle ${continuationCount})`,
		"",
		"### Files changed",
		"<one line per file>",
		"",
		"### Baseline (before)",
		"<real output>",
		"",
		"### Baseline (after)",
		"<real output>",
		"",
		"### Boot check",
		"<real output or exact reason it didn't apply>",
		"",
		"### Residual risk / notes",
		"<anything not 100% certain>",
		"",
		"PR: <link>",
		"```",
		"",
		"## Closing out",
		"",
		"Once every assigned issue is closed with the template above:",
		"1. Finish with attempt_completion and a full summary of what you changed, the real baseline",
		"   numbers, the boot check, and the PR link(s).",
		"2. The harness records your completion automatically (exit code + .harness.done marker) —",
		"   no separate phone-home step is needed.",
		"3. Do not start on any issue not assigned to this worktree.",
		"",
		`Scope: ${assigned} only — continuation cycle ${continuationCount}.`,
	].join("\n")
}
