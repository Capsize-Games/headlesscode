/**
 * Human-approval deploy gate — pure decision logic (Phase 4).
 *
 * The gate exists because deploy-production.sh pushes to production (GitHub
 * Actions triggers / direct SSH deploys to Hetzner). That must never happen
 * without an explicit human decision — NOT an automated "approved because
 * everything passed" rule. The orchestrator may only run the repo's deploy
 * script AFTER this gate returns approved.
 *
 * Two approval modes (documented in docs/phase4-deploy-gate.md):
 *
 *   - INTERACTIVE: a human answers "Approve deploy? [y/N]" on a TTY. Any
 *     explicit yes (y/yes, case-insensitive) approves; everything else
 *     (including empty input) denies.
 *   - NON-INTERACTIVE (token/file): exactly ONE of:
 *       (a) a one-time approval FILE created by a human, e.g.
 *           `touch <repo>/.worktrees/.deploy-approved-<batch>` — its mere
 *           presence is the human's explicit action (it does not exist until
 *           a human creates it);
 *       (b) an env token `DEPLOY_APPROVAL_TOKEN` that strictly matches the
 *           token stored in a file like `<repo>/.deploy-approval`.
 *     If neither is present, or the token does not match, approval is DENIED.
 *
 * Never auto-approve: with no interactive input, no approval file, and no
 * matching token, the answer is always denied.
 *
 * The decision itself lives in `decideApproval` (pure, unit-tested). The
 * I/O wrapper `evaluateApproval` reads the token/approval files and delegates
 * to it — this is what the bash wrapper (scripts/deploy-gate.sh) calls via
 * the tiny CLI (src/deploy/gate-cli.ts), keeping the logic testable without
 * a network or git.
 */

import * as fs from "node:fs"
import * as path from "node:path"

/** Everything `decideApproval` needs — resolved values, no file I/O. */
export interface ApprovalInputs {
	/** True when the caller wants interactive (TTY) approval. */
	interactive: boolean
	/** The line a human typed at the prompt (undefined when not interactive). */
	interactiveInput?: string
	/** Value of the DEPLOY_APPROVAL_TOKEN env var (undefined when unset). */
	approvalToken?: string
	/** Contents of the token file (e.g. <repo>/.deploy-approval), trimmed. */
	tokenFileContent?: string
	/** True when a human-created one-time approval file exists. */
	approvalFileExists: boolean
}

export interface ApprovalResult {
	approved: boolean
	/** Human-readable reason, safe to print to the operator. */
	reason: string
}

/** Interactive input counts as approval only for an explicit yes. */
function isExplicitYes(input: string): boolean {
	return /^\s*y(?:es)?\s*$/i.test(input)
}

/**
 * PURE decision function — unit-tested without any file system.
 *
 * Rules (fail-closed):
 *   1. Interactive + explicit yes  → approved.
 *   2. Interactive + anything else → denied (empty, "n", "maybe", …).
 *   3. Non-interactive + one-time approval FILE present → approved.
 *   4. Non-interactive + approvalToken AND tokenFileContent set AND they
 *      match exactly (trimmed) → approved.
 *   5. Everything else → denied with a reason explaining what was missing.
 *
 * Interactive mode takes precedence when both interactive and a token are
 * configured (the operator is at the keyboard — their answer is what counts).
 */
export function decideApproval(inputs: ApprovalInputs): ApprovalResult {
	if (inputs.interactive) {
		if (inputs.interactiveInput !== undefined && isExplicitYes(inputs.interactiveInput)) {
			return { approved: true, reason: "approved interactively (explicit yes at the prompt)" }
		}
		return {
			approved: false,
			reason:
				inputs.interactiveInput === undefined
					? "DENIED: interactive approval requires an explicit yes ('y'/'yes'); no answer was received"
					: `DENIED: interactive approval requires an explicit yes ('y'/'yes'); got '${inputs.interactiveInput.trim() || "(empty)"}'`,
		}
	}

	if (inputs.approvalFileExists) {
		return { approved: true, reason: "approved by a human-created one-time approval file" }
	}

	if (inputs.approvalToken !== undefined && inputs.tokenFileContent !== undefined) {
		if (inputs.approvalToken.trim() !== "" && inputs.approvalToken.trim() === inputs.tokenFileContent.trim()) {
			return { approved: true, reason: "approved: DEPLOY_APPROVAL_TOKEN matched the token file" }
		}
		if (inputs.approvalToken.trim() === "") {
			return {
				approved: false,
				reason: "DENIED: DEPLOY_APPROVAL_TOKEN is set but empty — no token to match",
			}
		}
		return {
			approved: false,
			reason: "DENIED: DEPLOY_APPROVAL_TOKEN does not match the token in the approval file",
		}
	}

	if (inputs.approvalToken !== undefined && inputs.tokenFileContent === undefined) {
		return {
			approved: false,
			reason: "DENIED: DEPLOY_APPROVAL_TOKEN is set but no token file was found to match against",
		}
	}
	if (inputs.approvalToken === undefined && inputs.tokenFileContent !== undefined) {
		return {
			approved: false,
			reason: "DENIED: a token file exists but DEPLOY_APPROVAL_TOKEN is not set",
		}
	}
	return {
		approved: false,
		reason:
			"DENIED: no interactive input, no one-time approval file, and no matching DEPLOY_APPROVAL_TOKEN — a deploy gate can never auto-approve",
	}
}

export interface EvaluateApprovalOptions {
	interactive: boolean
	interactiveInput?: string
	approvalToken?: string
	/** Path to the token file (e.g. <repo>/.deploy-approval). */
	tokenFile?: string
	/** Path to the one-time approval file (e.g. <repo>/.worktrees/.deploy-approved-<batch>). */
	approvalFile?: string
}

/** Read token/approval files (if any) and delegate to the pure decision. */
export function evaluateApproval(options: EvaluateApprovalOptions): ApprovalResult {
	let tokenFileContent: string | undefined
	if (options.tokenFile) {
		try {
			tokenFileContent = fs.readFileSync(options.tokenFile, "utf-8").trim()
		} catch {
			tokenFileContent = undefined // missing file = no token to match
		}
	}

	let approvalFileExists = false
	if (options.approvalFile) {
		try {
			approvalFileExists = fs.statSync(options.approvalFile).isFile()
		} catch {
			approvalFileExists = false
		}
	}

	return decideApproval({
		interactive: options.interactive,
		interactiveInput: options.interactiveInput,
		approvalToken: options.approvalToken,
		tokenFileContent,
		approvalFileExists,
	})
}

// ─── Deployment summary (what would be deployed) ────────────────────────────

export interface DeploySummaryOptions {
	/** Target repo root (shown in the summary header). */
	repo: string
	/** Batch id (default: derived from the state file or "unnamed"). */
	batch?: string
	/** Optional deployment notes file; shown verbatim when present. */
	notesPath?: string
	/** Orchestrator state file (`.worktrees/.orchestrator-state.json`). */
	statePath?: string
}

/**
 * Build the human-readable deployment summary printed by the gate BEFORE
 * asking for approval. Sources, in priority order:
 *   1. A provided/generated notes file (verbatim).
 *   2. The orchestrator state file's batch + per-group summary.
 *   3. A generic line (nothing to summarize).
 */
export function buildDeploySummary(options: DeploySummaryOptions): string {
	const lines: string[] = []
	lines.push(`Target repo: ${options.repo}`)

	if (options.notesPath) {
		try {
			const notes = fs.readFileSync(options.notesPath, "utf-8").trim()
			if (notes) {
				lines.push("")
				lines.push(notes)
				return lines.join("\n")
			}
		} catch {
			lines.push(`(notes file not readable: ${options.notesPath})`)
		}
	}

	if (options.statePath) {
		try {
			const raw = fs.readFileSync(options.statePath, "utf-8")
			const state = JSON.parse(raw) as {
				batch?: string
				groups?: Array<{
					name?: string
					status?: string
					issues?: number[]
					review_verdict?: string
					qa?: { verdict?: string }
				}>
			}
			const batch = options.batch ?? state.batch ?? "unnamed"
			lines.push(`Batch: ${batch}`)
			const groups = Array.isArray(state.groups) ? state.groups : []
			if (groups.length === 0) {
				lines.push("(no groups recorded in the orchestrator state file)")
			} else {
				lines.push(`Groups (${groups.length}):`)
				for (const g of groups) {
					const issues = Array.isArray(g.issues) && g.issues.length > 0 ? ` issues ${g.issues.join(",")}` : ""
					const review = g.review_verdict ? ` review=${g.review_verdict}` : ""
					const qa = g.qa?.verdict ? ` qa=${g.qa.verdict}` : ""
					lines.push(`  - ${g.name ?? "(unnamed)"}: status=${g.status ?? "?"}${issues}${review}${qa}`)
				}
			}
			return lines.join("\n")
		} catch {
			// fall through to generic
		}
	}

	lines.push(options.batch ? `Batch: ${options.batch}` : "Batch: (not provided)")
	lines.push("(no deployment notes and no orchestrator state file available — nothing to summarize)")
	return lines.join("\n")
}

/**
 * Default paths for the gate artifacts inside a target repo.
 *   - token file:  <repo>/.deploy-approval
 *   - approval:    <repo>/.worktrees/.deploy-approved-<batch>
 */
export function defaultTokenFile(repo: string): string {
	return path.join(repo, ".deploy-approval")
}

export function defaultApprovalFile(repo: string, batch: string): string {
	return path.join(repo, ".worktrees", `.deploy-approved-${batch}`)
}
