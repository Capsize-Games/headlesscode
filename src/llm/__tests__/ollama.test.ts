import assert from "node:assert/strict"
import { OllamaClient } from "../ollama.js"
import type { LlmRequest } from "../../engine/types.js"

async function main(): Promise<void> {
	const originalFetch = globalThis.fetch
	let capturedInit: RequestInit | undefined
	globalThis.fetch = async (_input, init) => {
		capturedInit = init
		return new Response(JSON.stringify({ message: { role: "assistant", content: "ok" } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})
	}
	try {
		const client = new OllamaClient({ baseUrl: "http://host.openshell.internal:11434", defaultModel: "local" })
		const request: LlmRequest = { model: "local", messages: [{ role: "user", content: "hello" }] }
		const response = await client.createChatCompletion(request)
		assert.equal(response.message.content, "ok")
		assert.equal(capturedInit?.dispatcher, undefined, "OpenShell host traffic must use the runtime network path without a custom undici Agent")
	} finally {
		globalThis.fetch = originalFetch
	}

	let localInit: RequestInit | undefined
	const localClient = new OllamaClient({
		baseUrl: "http://127.0.0.1:11434",
		defaultModel: "local",
		fetchImpl: async (_input, init) => {
			localInit = init
			return new Response(JSON.stringify({ message: { role: "assistant", content: "ok" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		},
	})
	await localClient.createChatCompletion({ model: "local", messages: [{ role: "user", content: "hello" }] })
	assert.ok(localInit?.dispatcher, "direct local Ollama calls retain the configurable undici Agent")
	console.log("All 2 Ollama transport assertions passed")
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
