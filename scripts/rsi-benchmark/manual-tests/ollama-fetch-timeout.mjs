import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
import * as path from "node:path"

const { OllamaClient } = await import(pathToFileURL(path.join(process.cwd(), "src/llm/ollama.ts")))
const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434", defaultModel: "benchmark", timeoutMs: 500_000 })
const dispatcher = client.dispatcher
assert.ok(dispatcher, "direct Ollama requests should use a configurable undici dispatcher")
const optionsSymbol = Object.getOwnPropertySymbols(dispatcher).find((symbol) => symbol.toString() === "Symbol(options)")
assert.ok(optionsSymbol, "dispatcher should expose its effective transport options")
const options = dispatcher[optionsSymbol]
assert.equal(options.headersTimeout, 560_000, "header timeout should exceed the configured request timeout")
assert.equal(options.bodyTimeout, 560_000, "body timeout should exceed the configured request timeout")
console.log("Ollama transport timeout behavior passed")
