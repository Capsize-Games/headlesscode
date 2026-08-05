/**
 * Tests proving per-mode model assignment (mode-model-assignment) actually
 * reaches session construction: a configured `.headlesscode/mode-models.json`
 * entry changes the model a session is built with, resolved through the same
 * precedence chain the CLIs use. Plain assert-based (no framework, no network,
 * no API key), matching the repo test style. Run via `npm test` ->
 * `tsx src/orchestrator/__tests__/model-resolution.test.ts`.
 *
 * We exercise `resolveModelForMode` directly plus the orchestrator's
 * per-role resolution contract via `parseOrchestrateArgs` + the exported
 * rework `handleReviewVerdict` (which forwards the worker's resolved model
 * into the rework spawn command).
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { resolveModelForMode } from "../../config/mode-models.js"
import { handleReviewVerdict, parseOrchestrateArgs } from "../cli.js"
import type { OrchestratorGroup } from "../state.js"
import type { ReviewResult } from "../reviewer.js"

async function tmpRepo(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-model-res-"))
}

async function writeModeModels(repo: string, file: Record<string, string>): Promise<void> {
	await fs.mkdir(path.join(repo, ".headlesscode"), { recursive: true })
	await fs.writeFile(path.join(repo, ".headlesscode", "mode-models.json"), JSON.stringify(file, null, 2) + "\n", "utf-8")
}

// ─── A configured mapping reaches session construction (the core contract) ──

async function testConfiguredMappingChangesResolvedModel(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// The exact shape from the spec: per-mode entries + an optional _default.
		await writeModeModels(repo, {
			code: "deepseek/deepseek-chat",
			"deepseek-reviewer": "deepseek/deepseek-reasoner",
			_default: "deepseek/deepseek-chat",
		})
		// What src/cli.ts's single-session path does: mode = options.mode
		// (default "code"), explicitModel = options.model (undefined here).
		const code = resolveModelForMode({ workspaceRoot: repo, mode: "code", explicitModel: undefined, env: {} })
		assert.equal(code, "deepseek/deepseek-chat", "the configured 'code' entry wins over no env and no flag")

		const reviewer = resolveModelForMode({
			workspaceRoot: repo,
			mode: "deepseek-reviewer",
			explicitModel: undefined,
			env: {},
		})
		assert.equal(reviewer, "deepseek/deepseek-reasoner", "each mode resolves its OWN configured model")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testOrchestratorRolesResolveTheirOwnModels(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// A reviewer-only mapping: workers fall through to env, the reviewer
		// uses its own entry.
		await writeModeModels(repo, {
			"deepseek-reviewer": "deepseek/deepseek-reasoner",
		})
		const worker = resolveModelForMode({ workspaceRoot: repo, mode: "code", explicitModel: undefined, env: { OPENROUTER_MODEL: "env-model" } })
		const reviewer = resolveModelForMode({
			workspaceRoot: repo,
			mode: "deepseek-reviewer",
			explicitModel: undefined,
			env: { OPENROUTER_MODEL: "env-model" },
		})
		const qa = resolveModelForMode({ workspaceRoot: repo, mode: "qa-agent", explicitModel: undefined, env: { OPENROUTER_MODEL: "env-model" } })
		assert.equal(worker, "env-model", "workers (mode code) fall through to env when unmapped")
		assert.equal(reviewer, "deepseek/deepseek-reasoner", "reviewer uses its own mapped model, not the worker's env")
		assert.equal(qa, "env-model", "QA (unmapped) falls through to env like workers")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testExplicitModelFlagIsBlanketOverride(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeModeModels(repo, { code: "from-file", "deepseek-reviewer": "reviewer-file", _default: "default-file" })
		// One explicit --model flag beats every role's own entry (rule 1).
		const worker = resolveModelForMode({ workspaceRoot: repo, mode: "code", explicitModel: "from-flag", env: {} })
		const reviewer = resolveModelForMode({
			workspaceRoot: repo,
			mode: "deepseek-reviewer",
			explicitModel: "from-flag",
			env: {},
		})
		const qa = resolveModelForMode({ workspaceRoot: repo, mode: "qa-agent", explicitModel: "from-flag", env: {} })
		assert.equal(worker, "from-flag")
		assert.equal(reviewer, "from-flag")
		assert.equal(qa, "from-flag", "the blanket override applies to every role")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── The rework spawn forwards the worker's resolved model ──────────────────

async function testReworkSpawnCarriesResolvedWorkerModel(): Promise<void> {
	const group: OrchestratorGroup = {
		name: "w1",
		worktree: ".worktrees/w1",
		status: "done",
		spawned: new Date().toISOString(),
		reworkCount: 0,
		issues: [27],
	}
	const result: ReviewResult = { verdict: "finding", findings: ["x"], summary: "REOPENED" }
	// handleReviewVerdict receives the RESOLVED worker model (what the
	// orchestrator now passes instead of the raw --model flag).
	const decision = handleReviewVerdict(group, result, "/tmp/repo", 3, "code", "deepseek/deepseek-chat")
	assert.ok(decision.spawnCommand?.includes('--model "deepseek/deepseek-chat"'), "rework spawn carries the resolved worker model")

	// No model resolved (no flag, no config) -> no --model arg, the worker's
	// own default applies — same as the pre-feature behavior.
	const noModel = handleReviewVerdict(group, result, "/tmp/repo", 3, "code", undefined)
	assert.ok(!noModel.spawnCommand?.includes("--model"), "undefined model adds no --model arg")
}

// ─── parseOrchestrateArgs defaults feed the per-role resolution ─────────────

async function testParseArgsDefaultsFeedRoleModes(): Promise<void> {
	const parsed = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1"])
	assert.equal(parsed.error, undefined)
	assert.equal(parsed.options.mode, "code")
	assert.equal(parsed.options.reviewMode, "deepseek-reviewer")
	assert.equal(parsed.options.qaMode, "qa-agent")
	// The three defaults are exactly the three mode slugs the orchestrator
	// resolves per-role models for.
	assert.equal(parsed.options.model, undefined, "no --model flag -> each role resolves its own")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["a configured mapping changes which model a session resolves to", testConfiguredMappingChangesResolvedModel],
	["orchestrator roles (worker/reviewer/QA) resolve their own models", testOrchestratorRolesResolveTheirOwnModels],
	["one explicit --model flag is a blanket override for every role", testExplicitModelFlagIsBlanketOverride],
	["the rework spawn carries the resolved worker model", testReworkSpawnCarriesResolvedWorkerModel],
	["parseOrchestrateArgs defaults feed the per-role resolution modes", testParseArgsDefaultsFeedRoleModes],
]

async function main(): Promise<void> {
	// Redirect the central store so resolveModelForMode's legacy-file migration
	// stays inside the sandbox and never touches the real home store.
	const storeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "hc-modelres-store-"))
	process.env.HEADLESSCODE_DATA_DIR = storeTmp
	let failed = 0
	try {
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
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fs.rm(storeTmp, { recursive: true, force: true })
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} model-resolution tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
