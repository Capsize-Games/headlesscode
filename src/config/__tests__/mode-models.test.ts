/**
 * Unit tests for src/config/mode-models.ts — per-mode model assignment via the
 * CENTRAL project store's `mode-models.json` (src/project-store.ts). The store
 * is redirected to a temp dir via $HEADLESSCODE_DATA_DIR so no test ever
 * touches the real home directory. Plain assert-based (no test framework, no
 * network) matching the repo test style. Run via `npm test` ->
 * `tsx src/config/__tests__/mode-models.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	loadModeModelsFile,
	modeModelsFilePath,
	resolveModelForMode,
	resolveReasoningEffortForMode,
	validateModeModelsBody,
	DEFAULT_KEY,
} from "../mode-models.js"

let storeTmp: string

async function tmpRepo(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-mode-models-"))
}

async function writeConfig(repo: string, content: string): Promise<void> {
	// Write at the CENTRAL config location (modeModelsFilePath) — the legacy
	// `.headlesscode/` migration path is covered by src/project-store.test.ts.
	const file = modeModelsFilePath(repo)
	await fs.mkdir(path.dirname(file), { recursive: true })
	await fs.writeFile(file, content, "utf-8")
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

// ─── extraKeys (Phase 3 condensation model assignment) ───────────────────────

async function testExtraKeyBeatsDefault(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeConfig(repo, JSON.stringify({ _default: "default-model", _condensation: "cheap-model" }))
		const resolved = resolveModelForMode({
			workspaceRoot: repo,
			mode: "code",
			extraKeys: ["_condensation"],
			env: { OPENROUTER_MODEL: "from-env" },
		})
		assert.equal(resolved, "cheap-model", "the extra key (_condensation) must beat _default + env")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testExtraKeyBeatsModeEntry(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// The canonical P0.2 file sets BOTH the session model for `code` AND
		// a cheaper `_condensation` model. The whole point of `_condensation`
		// is to override the session model on the condensation call, so it
		// must win even when the mode entry is present — otherwise the key
		// is silently dead (condensation keeps running on the full-price
		// session model).
		await writeConfig(
			repo,
			JSON.stringify({ code: "mode-specific", _default: "default-model", _condensation: "cheap-model" }),
		)
		const resolved = resolveModelForMode({
			workspaceRoot: repo,
			mode: "code",
			extraKeys: ["_condensation"],
			env: { OPENROUTER_MODEL: "from-env" },
		})
		assert.equal(resolved, "cheap-model", "the extra key (_condensation) must beat the mode's own entry")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testExtraKeyFallsThroughToDefaultWhenAbsent(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeConfig(repo, JSON.stringify({ _default: "default-model" }))
		const resolved = resolveModelForMode({
			workspaceRoot: repo,
			mode: "code",
			extraKeys: ["_condensation"],
			env: {},
		})
		assert.equal(resolved, "default-model", "no _condensation key -> _default applies (unchanged behavior)")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testExtraKeyWithoutExtraKeysRequestedIgnored(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeConfig(repo, JSON.stringify({ _default: "default-model", _condensation: "cheap-model" }))
		// Callers that don't pass extraKeys must never accidentally pick up
		// _condensation — it's only consulted when explicitly requested.
		const resolved = resolveModelForMode({
			workspaceRoot: repo,
			mode: "code",
			env: {},
		})
		assert.equal(resolved, "default-model", "_condensation must be ignored unless extraKeys requests it")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── _reasoning_effort (issue #30 graded reasoning dial) ─────────────────────

async function testReasoningEffortKeyBeatsEnv(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeConfig(repo, JSON.stringify({ _reasoning_effort: "high" }))
		const resolved = resolveReasoningEffortForMode({
			workspaceRoot: repo,
			env: { HEADLESSCODE_REASONING_EFFORT: "medium" },
		})
		assert.equal(resolved, "high", "the _reasoning_effort config key must beat the env var")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testReasoningEffortEnvUsedWhenKeyAbsent(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeConfig(repo, JSON.stringify({ code: "deepseek/deepseek-v4-flash" }))
		const resolved = resolveReasoningEffortForMode({
			workspaceRoot: repo,
			env: { HEADLESSCODE_REASONING_EFFORT: "xhigh" },
		})
		assert.equal(resolved, "xhigh", "env is used when the file has no _reasoning_effort key")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testReasoningEffortNothingConfiguredReturnsUndefined(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const resolved = resolveReasoningEffortForMode({ workspaceRoot: repo, env: {} })
		assert.equal(resolved, undefined, "no key, no env -> undefined (endpoint default applies)")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testReasoningEffortModeEntriesNotConsulted(): Promise<void> {
	// A mode slug entry (e.g. "code") must NEVER leak into the effort — only
	// the `_reasoning_effort` key is read. Mirrors how `_condensation` is only
	// consulted when explicitly requested.
	const repo = await tmpRepo()
	try {
		await writeConfig(repo, JSON.stringify({ code: "deepseek/deepseek-v4-flash", _default: "other" }))
		const resolved = resolveReasoningEffortForMode({ workspaceRoot: repo, env: {} })
		assert.equal(resolved, undefined, "mode entries are model ids, not reasoning efforts")
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
	["extraKeys: _condensation beats _default + env", testExtraKeyBeatsDefault],
	["extraKeys: falls through to _default when absent", testExtraKeyFallsThroughToDefaultWhenAbsent],
	["extraKeys: ignored unless explicitly requested", testExtraKeyWithoutExtraKeysRequestedIgnored],
	["_reasoning_effort key beats env", testReasoningEffortKeyBeatsEnv],
	["_reasoning_effort: env used when key absent", testReasoningEffortEnvUsedWhenKeyAbsent],
	["_reasoning_effort: nothing configured -> undefined", testReasoningEffortNothingConfiguredReturnsUndefined],
	["_reasoning_effort: mode entries are never consulted", testReasoningEffortModeEntriesNotConsulted],
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
	// Redirect the central store to a temp dir for the whole run.
	storeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-mode-models-store-"))
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
	console.log(`\nAll ${tests.length} mode-models tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
