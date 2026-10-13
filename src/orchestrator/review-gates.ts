import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

import { getCodeIntelCache, type CodeIntel } from "../codeintel/program.js"
import {
	directTestMatch,
	isTestFile,
	reverseDependencyTests,
	selectTestsForChangedFiles,
} from "../tools/test-selection.js"
import { worktreeChangedFiles } from "./verification-gate.js"

export interface GateCommandResult {
	status: number
	output: string
}

export type GateRunner = (
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
) => GateCommandResult

export interface ReviewGateResult {
	ok: boolean
	summary: string
	output: string
}

export interface ReviewGateDeps {
	run?: GateRunner
	loadIntel?: () => CodeIntel
}

const GATE_TIMEOUT_MS = 300_000
const GATE_OUTPUT_CAP = 1500

function defaultGateRunner(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
): GateCommandResult {
	try {
		const output = execFileSync(command, args, {
			cwd,
			encoding: "utf-8",
			timeout: timeoutMs,
			maxBuffer: 8 * 1024 * 1024,
		})
		return { status: 0, output }
	} catch (error) {
		return execFailure(error)
	}
}

function execStatus(error: object): number {
	if ("status" in error && typeof error.status === "number") {
		return error.status
	}
	return 1
}

function execOutput(error: object): string {
	const out = "stdout" in error ? String(error.stdout ?? "") : ""
	const errOut = "stderr" in error ? String(error.stderr ?? "") : ""
	return `${out}\n${errOut}`.trim() || String(error)
}

function execFailure(error: unknown): GateCommandResult {
	if (typeof error !== "object" || error === null) {
		return { status: 1, output: String(error) }
	}
	const timedOut = "code" in error && error.code === "ETIMEDOUT"
	const output = execOutput(error)
	return {
		status: execStatus(error),
		output: timedOut ? `TIMEOUT: ${output}` : output,
	}
}

function truncateOutput(output: string): string {
	const trimmed = output.trim()
	if (trimmed.length <= GATE_OUTPUT_CAP) return trimmed
	return `${trimmed.slice(-GATE_OUTPUT_CAP)}\n… (truncated, tail kept)`
}

/** Changed files the type/test gates apply to: test files themselves plus
 * sources with a direct-test convention (TS/JS). Docs, config, and scripts
 * outside the convention get checkers only. */
function gateTestableFiles(changed: string[]): string[] {
	return changed.filter((f) => isTestFile(f) || directTestMatch(f) !== undefined)
}

function directCovered(root: string, rel: string): boolean {
	if (isTestFile(rel)) return true
	const direct = directTestMatch(rel)
	if (direct === undefined) return false
	try {
		return fs.statSync(path.join(root, direct)).isFile()
	} catch {
		return false
	}
}

/**
 * Tier 3 of the review verification gates (#137): deterministically run the
 * quality gates for the worktree diff — tsc, the tests selected for the
 * touched files, and both ratchet checkers — BEFORE the LLM review session.
 * Fails closed: red output, timeouts, missing tests for a touched source
 * file, and runner errors all report ok=false so the caller can downgrade
 * (Tier 1 precedent: skip the session, record an automatic finding).
 */
interface GatePlan {
	wtPath: string
	testable: string[]
	tests: string[]
	intel: CodeIntel | undefined
}

interface GateRun {
	ctx: GateContext
	failures: string[]
	outputs: string[]
}

interface GateContext {
	run: GateRunner
	wtPath: string
}

function gatePlan(wtPath: string, deps: ReviewGateDeps): GatePlan {
	const testable = gateTestableFiles(worktreeChangedFiles(wtPath))
	const needsIntel = testable.some((f) => !directCovered(wtPath, f))
	const loadIntel = deps.loadIntel ?? (() => getCodeIntelCache(wtPath).get())
	const intel = needsIntel ? loadIntel() : undefined
	const selection = selectTestsForChangedFiles(intel, wtPath, testable)
	return { wtPath, testable, tests: selection.tests, intel }
}

function testCovered(plan: GatePlan, rel: string): boolean {
	if (isTestFile(rel)) return true
	const direct = directTestMatch(rel)
	if (direct !== undefined && plan.tests.includes(direct)) return true
	if (plan.intel === undefined) return false
	const abs = path.resolve(plan.wtPath, rel.split(path.sep).join("/"))
	return reverseDependencyTests(plan.intel, plan.wtPath, abs).length > 0
}

function runGate(
	ctx: GateContext,
	label: string,
	args: string[],
	state: Pick<GateRun, "failures" | "outputs">,
): void {
	let result: GateCommandResult
	try {
		result = ctx.run(process.execPath, args, ctx.wtPath, GATE_TIMEOUT_MS)
	} catch (error) {
		result = { status: 1, output: `gate runner threw: ${String(error)}` }
	}
	const head = `### ${label}\nexit=${result.status}`
	state.outputs.push(`${head}\n${truncateOutput(result.output)}`)
	if (result.status !== 0) {
		state.failures.push(`${label} failed (exit ${result.status})`)
	}
}

function runTypeAndTests(
	plan: GatePlan,
	ctx: GateContext,
	state: GateRun,
): void {
	if (plan.testable.length === 0) {
		state.outputs.push("tsc/tests skipped: no testable files")
		return
	}
	const tsc = ["node_modules/typescript/bin/tsc", "--noEmit"]
	runGate(ctx, "tsc --noEmit", tsc, state)
	for (const test of plan.tests) {
		const args = ["scripts/run-tests.mjs", "--filter", test]
		runGate(ctx, `tests ${test}`, args, state)
	}
}

function runCheckerGates(ctx: GateContext, state: GateRun): void {
	runGate(ctx, "check-standards", ["scripts/check-code-standards.mjs"], state)
	runGate(ctx, "check-architecture",
		["node_modules/tsx/dist/cli.mjs", "scripts/check-architecture.mjs"], state)
}

function gateSummary(plan: GatePlan, failures: string[]): string {
	if (failures.length === 0) {
		return `review gates green (${plan.tests.length} test file(s)`
			+ ` for ${plan.testable.length} touched file(s))`
	}
	return failures.join("\n")
}

export function runReviewGates(
	wtPath: string,
	deps: ReviewGateDeps = {},
): ReviewGateResult {
	const ctx = { run: deps.run ?? defaultGateRunner, wtPath }
	const plan = gatePlan(wtPath, deps)
	const failures = plan.testable
		.filter((f) => !testCovered(plan, f))
		.map((f) => `no test covers changed file ${f}`)
	const state: GateRun = { ctx, failures, outputs: [] }
	runTypeAndTests(plan, ctx, state)
	runCheckerGates(ctx, state)
	return {
		ok: failures.length === 0,
		summary: gateSummary(plan, failures),
		output: state.outputs.join("\n\n"),
	}
}
