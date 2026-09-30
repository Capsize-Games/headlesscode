import assert from "node:assert/strict"
import test from "node:test"
import { parseRsiArgs } from "../config.js"
import { networkRules, rsiMutationGuestEnvironment } from "../openshell.js"
import type { CandidateRecord, RsiConfig } from "../types.js"
import { RSI_OPENROUTER_MODEL } from "../inference-broker.js"

const parsed = parseRsiArgs(["--repo", process.cwd(), "--max-iterations", "3", "--timeout-ms", "5000"])
if (!parsed.config || parsed.error) throw new Error(parsed.error ?? "could not create test RSI config")
const config = parsed.config as RsiConfig
config.roles = { worker: { provider: "openrouter", model: RSI_OPENROUTER_MODEL } }
const candidate = { id: "broker-test", model: RSI_OPENROUTER_MODEL } as CandidateRecord
const broker = { guestBaseUrl: "http://host.openshell.internal:43123", capability: "opaque-attempt-capability", port: 43123 }

test("OpenRouter guest gets only its job capability and the single broker network endpoint", () => {
	const env = rsiMutationGuestEnvironment(config, candidate, broker)
	assert.equal(env.HEADLESSCODE_CODE_MODE_BACKEND, "openrouter")
	assert.equal(env.HEADLESSCODE_CODE_MODE_MODEL, RSI_OPENROUTER_MODEL)
	assert.equal(env.OPENROUTER_BASE_URL, broker.guestBaseUrl)
	assert.equal(env.HEADLESSCODE_RSI_INFERENCE_CAPABILITY, broker.capability)
	assert.equal(Object.keys(env).some((key) => /(?:API_KEY|SECRET|TOKEN)$/i.test(key)), false, "host provider credentials must not enter guest env")
	const rules = networkRules("mutation", broker)
	assert.deepEqual(Object.keys(rules), ["rsi_openrouter_broker"])
	assert.deepEqual((rules.rsi_openrouter_broker as { endpoints: unknown[] }).endpoints, [{ host: "host.openshell.internal", port: 43123, protocol: "tcp" }])
})

test("OpenRouter mutation guest refuses missing broker, wrong model, and malformed endpoint", () => {
	assert.throws(() => rsiMutationGuestEnvironment(config, candidate), /requires a host broker/)
	assert.throws(() => rsiMutationGuestEnvironment({ ...config, roles: { worker: { provider: "openrouter", model: "deepseek/other" } } }, candidate, broker), /pinned model/)
	assert.throws(() => rsiMutationGuestEnvironment(config, candidate, { ...broker, guestBaseUrl: "https://openrouter.ai" }), /endpoint is malformed/)
})
