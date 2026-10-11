import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { parseRsiArgs } from "../config.js"
import { networkRules, rsiMutationGuestEnvironment } from "../openshell.js"
import type { CandidateRecord, RsiConfig } from "../types.js"
import { RSI_MUSE_OPENROUTER_MODEL, RSI_OPENROUTER_MODEL } from "../inference-broker.js"
import { resolveModelForMode } from "../../config/mode-models.js"

const parsed = parseRsiArgs(["--repo", process.cwd(), "--max-iterations", "3", "--timeout-ms", "5000"])
if (!parsed.config || parsed.error) throw new Error(parsed.error ?? "could not create test RSI config")
const config = parsed.config as RsiConfig
config.roles = { worker: { provider: "openrouter", model: RSI_OPENROUTER_MODEL } }
const candidate = { id: "broker-test", model: RSI_OPENROUTER_MODEL } as CandidateRecord
const broker = { guestBaseUrl: "http://host.openshell.internal:43123", capability: "opaque-attempt-capability", port: 43123, maxPromptBytes: 8_192 }

test("OpenRouter guest gets only its job capability and the single broker network endpoint", () => {
	const env = (() => {
		const previousPromptBudget = process.env.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES
		process.env.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES = "1"
		try { return rsiMutationGuestEnvironment(config, candidate, broker) }
		finally {
			if (previousPromptBudget === undefined) delete process.env.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES
			else process.env.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES = previousPromptBudget
		}
	})()
	assert.equal(env.HEADLESSCODE_CODE_MODE_BACKEND, "openrouter")
	assert.equal(env.HEADLESSCODE_CODE_MODE_MODEL, RSI_OPENROUTER_MODEL)
	assert.equal(env.OPENROUTER_MODEL, RSI_OPENROUTER_MODEL)
	assert.equal(env.OPENROUTER_BASE_URL, broker.guestBaseUrl)
	assert.equal(env.HEADLESSCODE_RSI_INFERENCE_CAPABILITY, broker.capability)
	assert.equal(env.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES, String(broker.maxPromptBytes))
	assert.equal(Object.keys(env).some((key) => /(?:API_KEY|SECRET|TOKEN)$/i.test(key)), false, "host provider credentials must not enter guest env")
	const rules = networkRules("mutation", broker)
	assert.deepEqual(Object.keys(rules), ["rsi_openrouter_broker"])
	assert.deepEqual((rules.rsi_openrouter_broker as { endpoints: unknown[] }).endpoints, [{ host: "host.openshell.internal", port: 43123, protocol: "tcp" }])
})

test("OpenRouter guest model resolution honors the explicit Muse and historical DeepSeek profiles", () => {
	const scratch = path.join(process.cwd(), ".headlesscode", "scratch")
	fs.mkdirSync(scratch, { recursive: true, mode: 0o700 })
	const root = fs.mkdtempSync(path.join(scratch, "rsi-openrouter-model-resolution-"))
	const previousDataDir = process.env.HEADLESSCODE_DATA_DIR
	const dataDir = path.join(root, "project-store")
	const workspaceRoot = path.join(root, "synthetic-workspace")
	fs.mkdirSync(workspaceRoot, { mode: 0o700 })
	process.env.HEADLESSCODE_DATA_DIR = dataDir
	try {
		const museConfig = {
			...config,
			roles: { worker: { provider: "openrouter" as const, model: RSI_MUSE_OPENROUTER_MODEL, openRouterProfile: "muse-spark-contributor" as const } },
		}
		const museEnv = rsiMutationGuestEnvironment(museConfig, { ...candidate, model: RSI_MUSE_OPENROUTER_MODEL }, broker)
		assert.equal(resolveModelForMode({ workspaceRoot, mode: "code", env: museEnv }), RSI_MUSE_OPENROUTER_MODEL)
		assert.equal(museEnv.HEADLESSCODE_CODE_MODE_MODEL, museEnv.OPENROUTER_MODEL)
		assert.equal(Object.keys(museEnv).some((key) => /(?:API_KEY|SECRET|TOKEN)$/i.test(key)), false)

		const deepseekEnv = rsiMutationGuestEnvironment(config, candidate, broker)
		assert.equal(deepseekEnv.OPENROUTER_MODEL, RSI_OPENROUTER_MODEL)
		assert.equal(resolveModelForMode({ workspaceRoot, mode: "code", env: deepseekEnv }), RSI_OPENROUTER_MODEL)
		const ollamaEnv = rsiMutationGuestEnvironment({ ...config, roles: { worker: { provider: "ollama", model: "local-model" } } }, candidate)
		assert.equal(Object.hasOwn(ollamaEnv, "HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES"), false, "local inference keeps its existing environment path")
	} finally {
		if (previousDataDir === undefined) delete process.env.HEADLESSCODE_DATA_DIR
		else process.env.HEADLESSCODE_DATA_DIR = previousDataDir
		fs.rmSync(root, { recursive: true, force: true })
	}
})

test("OpenRouter mutation guest refuses missing broker, wrong model, and malformed endpoint", () => {
	assert.throws(() => rsiMutationGuestEnvironment(config, candidate), /requires a host broker/)
	assert.throws(() => rsiMutationGuestEnvironment({ ...config, roles: { worker: { provider: "openrouter", model: "deepseek/other" } } }, candidate, broker), /profile\/model identity is not admitted/)
	assert.throws(() => rsiMutationGuestEnvironment(config, candidate, { ...broker, guestBaseUrl: "https://openrouter.ai" }), /endpoint is malformed/)
	assert.throws(() => rsiMutationGuestEnvironment(config, candidate, { ...broker, maxPromptBytes: 0 }), /prompt byte budget is malformed/)
	assert.throws(() => rsiMutationGuestEnvironment(config, candidate, { ...broker, maxPromptBytes: Number.NaN }), /prompt byte budget is malformed/)
	const legacyBroker = { guestBaseUrl: broker.guestBaseUrl, capability: broker.capability, port: broker.port } as Parameters<typeof rsiMutationGuestEnvironment>[2]
	assert.throws(() => rsiMutationGuestEnvironment(config, candidate, legacyBroker), /prompt byte budget is malformed/)
})

test("Muse mutation guest requires the explicit profile and receives only its broker capability", () => {
	const museCandidate = { ...candidate, model: RSI_MUSE_OPENROUTER_MODEL }
	const museConfig: RsiConfig = { ...config, roles: { worker: { provider: "openrouter", model: RSI_MUSE_OPENROUTER_MODEL, openRouterProfile: "muse-spark-contributor" } } }
	const env = rsiMutationGuestEnvironment(museConfig, museCandidate, broker)
	assert.equal(env.HEADLESSCODE_CODE_MODE_MODEL, RSI_MUSE_OPENROUTER_MODEL)
	assert.equal(env.OPENROUTER_BASE_URL, broker.guestBaseUrl)
	assert.equal(env.HEADLESSCODE_RSI_INFERENCE_CAPABILITY, broker.capability)
	assert.equal(env.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES, String(broker.maxPromptBytes))
	assert.equal(Object.keys(env).some((key) => /(?:API_KEY|SECRET|TOKEN)$/i.test(key)), false)
	assert.throws(() => rsiMutationGuestEnvironment({ ...museConfig, roles: { worker: { provider: "openrouter", model: RSI_MUSE_OPENROUTER_MODEL } } }, museCandidate, broker), /explicit profile identity/)
})
