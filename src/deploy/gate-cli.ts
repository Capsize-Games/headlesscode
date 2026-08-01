#!/usr/bin/env tsx
/**
 * gate-cli.ts — tiny CLI wrapper around the deploy-gate decision logic
 * (src/deploy/gate.ts). scripts/deploy-gate.sh calls this to decide approval,
 * keeping the pure decision logic in TypeScript (unit-tested) and the bash
 * wrapper thin (UI + path safety + invoking the deploy script).
 *
 * Usage:
 *   node --import tsx src/deploy/gate-cli.ts \
 *     --repo <path> [--batch <name>] [--notes <file>] [--state <file>] \
 *     [--token-file <path>] [--approval-file <path>] \
 *     [--interactive] [--interactive-input <text>]
 *
 * Environment:
 *   DEPLOY_APPROVAL_TOKEN   the token to match against the token file
 *   DEPLOY_APPROVAL_FILE    fallback for --approval-file
 *
 * Output (parsed by the bash wrapper):
 *   DEPLOY_SUMMARY_BEGIN
 *   <multi-line deployment summary>
 *   DEPLOY_SUMMARY_END
 *   DEPLOY_APPROVED=yes|no
 *   DEPLOY_REASON=<reason>
 *
 * Exit code: 0 when approved, 3 when denied (the gate's "hard stop" code).
 */

import * as path from "node:path"

import { buildDeploySummary, evaluateApproval } from "./gate.js"

interface CliArgs {
	repo: string
	batch?: string
	notes?: string
	state?: string
	tokenFile?: string
	approvalFile?: string
	interactive: boolean
	interactiveInput?: string
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { repo: "", interactive: false }
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		const next = (): string | undefined => {
			const v = argv[i + 1]
			if (v === undefined || v.startsWith("--")) {
				return undefined
			}
			i++
			return v
		}
		switch (arg) {
			case "--repo":
			case "--batch":
			case "--notes":
			case "--state":
			case "--token-file":
			case "--approval-file":
			case "--interactive-input": {
				const v = next()
				if (v === undefined) {
					throw new Error(`Missing value for ${arg}`)
				}
				switch (arg) {
					case "--repo":
						args.repo = v
						break
					case "--batch":
						args.batch = v
						break
					case "--notes":
						args.notes = v
						break
					case "--state":
						args.state = v
						break
					case "--token-file":
						args.tokenFile = v
						break
					case "--approval-file":
						args.approvalFile = v
						break
					case "--interactive-input":
						args.interactiveInput = v
						break
				}
				break
			}
			case "--interactive":
				args.interactive = true
				break
			case "--help":
			case "-h":
				console.error(
					"gate-cli.ts --repo <path> [--batch <name>] [--notes <file>] [--state <file>] [--token-file <path>] [--approval-file <path>] [--interactive] [--interactive-input <text>]",
				)
				process.exit(0)
				break
			default:
				throw new Error(`Unknown argument: ${arg}`)
		}
	}
	return args
}

function main(): void {
	const args = parseArgs(process.argv.slice(2))
	if (!args.repo) {
		throw new Error("--repo <path> is required")
	}

	// Default artifact paths inside the target repo (mirror scripts/deploy-gate.sh).
	const tokenFile = args.tokenFile ?? path.join(args.repo, ".deploy-approval")
	const batch = args.batch ?? "round"
	const approvalFile =
		args.approvalFile ??
		process.env.DEPLOY_APPROVAL_FILE ??
		path.join(args.repo, ".worktrees", `.deploy-approved-${batch}`)
	const statePath = args.state ?? path.join(args.repo, ".worktrees", ".orchestrator-state.json")

	// 1. Deployment summary (what's being deployed).
	const summary = buildDeploySummary({
		repo: args.repo,
		batch,
		notesPath: args.notes,
		statePath,
	})
	process.stdout.write(`DEPLOY_SUMMARY_BEGIN\n${summary}\nDEPLOY_SUMMARY_END\n`)

	// 2. Approval decision (pure logic; file reads happen in evaluateApproval).
	const result = evaluateApproval({
		interactive: args.interactive,
		interactiveInput: args.interactiveInput,
		approvalToken: process.env.DEPLOY_APPROVAL_TOKEN,
		tokenFile,
		approvalFile,
	})

	process.stdout.write(`DEPLOY_APPROVED=${result.approved ? "yes" : "no"}\n`)
	process.stdout.write(`DEPLOY_REASON=${result.reason.replace(/\n/g, " ")}\n`)
	process.exitCode = result.approved ? 0 : 3
}

main()
