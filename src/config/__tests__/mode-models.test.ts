/**
 * Unit tests for src/config/mode-models.ts — per-mode model assignment via
 * `<workspaceRoot>/.headlesscode/mode-models.json`. Plain assert-based (no
 * test framework, no network) matching the repo test style. Run via `npm test`
 * -> `tsx src/config/__tests__/mode-models.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { loadModeModelsFile, resolveModelForMode, validateModeModelsBody, DEFAULT_KEY } from "../mode-models.js"

async function tmpRepo(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-mode-models-"))
}

async function writeConfig(repo: string, content: string): Promise<void> {
	await fs.mkdir(path.join(repo, ".headlesscode"), { recursive: true })
	await fs.writeFile(path.join(repo, ".headlesscode", "mode-models.json"), content, "utf-8")
}

// ─── Precedence ──────────────────────────────────────────────────────────────

async function testExplicitModelAlwaysWins(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeConfig(repo, JSON.stringify({ code: "from-file", _default: "from-default" }))
		const resolved = resolveModelForMode({
			workspaceRoot: repo,
			mode: "code",
			explicitModel: "from-flag",
			env: { OPENROUTER_MODEL: "from-env" },
		})
		assert.equal(resolved, "from-flag", "an explicit --model flag beats every other source")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testModeSpecificBeatsDefault(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeConfig(repo, JSON.stringify({ code: "mode-specific", _default: "mode-default" }))
		const resolved = resolveModelForMode({
			workspaceRoot: repo,
			mode: "code",
			env: { OPENROUTER_MODEL: "from-env" },
		})
		assert.equal(resolved, "mode-specific", "the mode's own entry beats the _default key")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testDefaultBeatsEnv(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeConfig(repo, JSON.stringify({ _default: "mode-default" }))
		const resolved = resolveModelForMode({
			workspaceRoot: repo,
			mode: "deepseek-reviewer",
			env: { OPENROUTER_MODEL: "from-env" },
		})
		assert.equal(resolved, "mode-default", "the _default key beats OPENROUTER_MODEL")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testEnvBeatsUndefined(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const resolved = resolveModelForMode({
			workspaceRoot: repo,
			mode: "code",
			env: { OPENROUTER_MODEL: "from-env" },
		})
		assert.equal(resolved, "from-env", "OPENROUTER_MODEL is used when no config entry applies")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testNothingConfiguredReturnsUndefined(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const resolved = resolveModelForMode({
			workspaceRoot: repo,
			mode: "code",
			env: {},
		})
		assert.equal(resolved, undefined, "no explicit flag, no file, no env -> undefined (caller's default applies)")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Missing file = zero-config ──────────────────────────────────────────────

async function testMissingFileFallsThroughToEnv(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const resolved = resolveModelForMode({
			workspaceRoot: repo,
			mode: "code",
			env: { OPENROUTER_MODEL: "env-model" },
		})
		assert.equal(resolved, "env-model", "a missing file is not an error — env fallback still applies")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testMissingFileWithNoEnvReturnsUndefined(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const resolved = resolveModelForMode({ workspaceRoot: repo, mode: "code", env: {} })
		assert.equal(resolved, undefined)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Malformed file fails loudly ─────────────────────────────────────────────

async function testMalformedJsonThrowsClearly(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeConfig(repo, "{ not valid json")
		await assert.rejects(
			Promise.resolve().then(() => resolveModelForMode({ workspaceRoot: repo, mode: "code", env: {} })),
			/invalid JSON/i,
			"broken JSON must throw, never silently fall back",
		)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testNonStringValueThrowsClearly(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeConfig(repo, JSON.stringify({ code: 42 }))
		await assert.rejects(
			Promise.resolve().then(() => resolveModelForMode({ workspaceRoot: repo, mode: "code", env: {} })),
			/must be a string model id/i,
			"a non-string value must throw with a clear message",
		)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testNonObjectFileThrowsClearly(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeConfig(repo, JSON.stringify(["code", "deepseek/deepseek-chat"]))
		await assert.rejects(
			Promise.resolve().then(() => loadModeModelsFile(repo)),
			/must be a JSON object/i,
		)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Body validation (dashboard save path) ───────────────────────────────────

async function testValidateBodyAcceptsValidObject(): Promise<void> {
	const body = { code: "deepseek/deepseek-chat", [DEFAULT_KEY]: "deepseek/deepseek-chat" }
	validateModeModelsBody(body)
}

async function testValidateBodyRejectsNonObject(): Promise<void> {
	assert.throws(() => validateModeModelsBody(["code"]), /must be a JSON object/i)
	assert.throws(() => validateModeModelsBody("deepseek/deepseek-chat"), /must be a JSON object/i)
	assert.throws(() => validateModeModelsBody(null), /must be a JSON object/i)
}

async function testValidateBodyRejectsNonStringValue(): Promise<void> {
	assert.throws(() => validateModeModelsBody({ code: 42 }), /must be a string model id/i)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["explicit --model flag beats the config file + env", testExplicitModelAlwaysWins],
	["mode-specific entry beats _default", testModeSpecificBeatsDefault],
	["_default beats OPENROUTER_MODEL", testDefaultBeatsEnv],
	["OPENROUTER_MODEL used when no config entry applies", testEnvBeatsUndefined],
	["nothing configured -> undefined (caller default applies)", testNothingConfiguredReturnsUndefined],
	["missing file falls through to env (zero-config)", testMissingFileFallsThroughToEnv],
	["missing file with no env -> undefined", testMissingFileWithNoEnvReturnsUndefined],
	["malformed JSON throws clearly", testMalformedJsonThrowsClearly],
	["non-string value throws clearly", testNonStringValueThrowsClearly],
	["non-object file throws clearly", testNonObjectFileThrowsClearly],
	["body validation accepts a valid object", testValidateBodyAcceptsValidObject],
	["body validation rejects non-object bodies", testValidateBodyRejectsNonObject],
	["body validation rejects non-string values", testValidateBodyRejectsNonStringValue],
]

async function main(): Promise<void> {
	let failed = 0
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
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} mode-models tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
