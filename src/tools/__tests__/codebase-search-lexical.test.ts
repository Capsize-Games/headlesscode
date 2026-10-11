import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { createHeadlessExecutor } from "../executor.js"
import { buildIndex, indexFilePath } from "../../codesearch/index.js"

async function fixture(check: (root: string, outside: string, executor: ReturnType<typeof createHeadlessExecutor>, calls: () => number) => Promise<void>) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hc-lexical-"))
	const root = path.join(directory, "repo"); const outside = path.join(directory, "outside")
	await fs.mkdir(root); await fs.mkdir(outside)
	const oldStore = process.env.HEADLESSCODE_DATA_DIR; const oldFetch = globalThis.fetch
	process.env.HEADLESSCODE_DATA_DIR = path.join(directory, "store")
	let calls = 0
	globalThis.fetch = async () => { calls++; throw new Error("Lexical qualification forbids network and embeddings") }
	const executor = createHeadlessExecutor(root)
	try {
		execFileSync("git", ["init", "--quiet"], { cwd: root })
		await fs.mkdir(path.join(root, "src/llm"), { recursive: true })
		await fs.mkdir(path.join(root, "src/other"), { recursive: true })
		await fs.writeFile(path.join(root, "src/llm/client.ts"), "export function request() { return 'known_fixture' }\n")
		await fs.writeFile(path.join(root, "src/other/second.ts"), "export function request() { return 'outside_prefix' }\n")
		await check(root, outside, executor, () => calls)
		assert.equal(calls, 0)
	} finally {
		await executor.dispose(); globalThis.fetch = oldFetch
		if (oldStore === undefined) delete process.env.HEADLESSCODE_DATA_DIR; else process.env.HEADLESSCODE_DATA_DIR = oldStore
		await fs.rm(directory, { recursive: true, force: true })
	}
}

test("an unindexed workspace finds source text without an embedding request", () => fixture(async (_root, _outside, executor) => {
	const result = await executor.execute("codebase_search", { query: "request" })
	assert.equal(result.isError, false, result.content)
	assert.match(result.content, /lexical/i)
	assert.match(result.content, /src\/llm\/client\.ts/)
	assert.match(result.content, /src\/other\/second\.ts/)
}))
test("directory scope includes descendants but excludes adjacent source", () => fixture(async (_root, _outside, executor) => {
	const result = await executor.execute("codebase_search", { query: "REQUEST", path: "src/llm" })
	assert.equal(result.isError, false, result.content)
	assert.match(result.content, /client\.ts/); assert.doesNotMatch(result.content, /second\.ts|outside_prefix/)
}))
test("a file scope and a literal metacharacter query are supported", () => fixture(async (_root, _outside, executor) => {
	const result = await executor.execute("codebase_search", { query: "request()", path: "src/llm/client.ts" })
	assert.equal(result.isError, false, result.content)
	assert.match(result.content, /known_fixture/); assert.doesNotMatch(result.content, /second\.ts/)
}))
test("traversal and external symlink scopes are refused", () => fixture(async (root, outside, executor) => {
	await fs.writeFile(path.join(outside, "external.ts"), "const request = 'OUTSIDE_SECRET_SENTINEL'\n")
	await fs.symlink(outside, path.join(root, "external"))
	for (const scope of ["../outside", "external"]) {
		const result = await executor.execute("codebase_search", { query: "request", path: scope })
		assert.equal(result.isError, true, result.content)
	}
}))
test("generated, ignored, credential and outside symlink contents never appear", () => fixture(async (root, outside, executor) => {
	for (const name of ["node_modules", "dist", "private"]) {
		await fs.mkdir(path.join(root, name)); await fs.writeFile(path.join(root, name, "hidden.ts"), "const request = 'SECRET_SENTINEL'\n")
	}
	await fs.writeFile(path.join(root, ".gitignore"), "private/\n")
	await fs.writeFile(path.join(root, ".env"), "request=SECRET_SENTINEL\n")
	await fs.writeFile(path.join(outside, "hidden.ts"), "const request = 'SECRET_SENTINEL'\n")
	await fs.symlink(path.join(outside, "hidden.ts"), path.join(root, "src/llm/link.ts"))
	const result = await executor.execute("codebase_search", { query: "request" })
	assert.equal(result.isError, false, result.content); assert.doesNotMatch(result.content, /SECRET_SENTINEL/)
}))
test("large source files and many matching lines yield bounded output", () => fixture(async (root, _outside, executor) => {
	await fs.writeFile(path.join(root, "src/huge.ts"), "x".repeat(2_000_000) + "request HUGE_SENTINEL\n")
	await fs.writeFile(path.join(root, "src/many.ts"), "request MATCH\n".repeat(1000))
	const result = await executor.execute("codebase_search", { query: "request" })
	assert.equal(result.isError, false, result.content)
	assert.doesNotMatch(result.content, /HUGE_SENTINEL/)
	assert.ok(result.content.length < 16_000, `unbounded output: ${result.content.length}`)
}))
test("source symlinks cannot expose an excluded credential or generated file", () => fixture(async (root, _outside, executor) => {
	await fs.mkdir(path.join(root, "dist"))
	await fs.writeFile(path.join(root, "credentials.json"), "request ALIAS_SECRET_SENTINEL\n")
	await fs.writeFile(path.join(root, "dist/generated.ts"), "request ALIAS_SECRET_SENTINEL\n")
	await fs.symlink(path.join(root, "credentials.json"), path.join(root, "src/alias.ts"))
	await fs.symlink(path.join(root, "dist/generated.ts"), path.join(root, "src/generated-alias.ts"))
	const result = await executor.execute("codebase_search", { query: "request" })
	assert.equal(result.isError, false, result.content); assert.doesNotMatch(result.content, /ALIAS_SECRET_SENTINEL/)
}))
test("an existing unusable index is an error instead of lexical fallback", () => fixture(async (root, _outside, executor) => {
	const file = indexFilePath(root); await fs.mkdir(file, { recursive: true })
	const result = await executor.execute("codebase_search", { query: "request" })
	assert.equal(result.isError, true, result.content); assert.doesNotMatch(result.content, /Lexical search/i)
}))
test("existing incompatible index metadata retains the semantic backend check", () => fixture(async (root, _outside, executor) => {
	const previous = process.env.HEADLESSCODE_EMBEDDING_BACKEND
	process.env.HEADLESSCODE_EMBEDDING_BACKEND = "openrouter"
	try {
		await buildIndex({ model: "fixture", embedBatch: async (texts) => ({ embeddings: texts.map(() => [1, 0]), promptTokens: 0, totalTokens: 0 }) }, root, undefined, "ollama")
		const result = await executor.execute("codebase_search", { query: "request" })
		assert.equal(result.isError, true, result.content); assert.match(result.content, /different-dimension|backend/)
	} finally { if (previous === undefined) delete process.env.HEADLESSCODE_EMBEDDING_BACKEND; else process.env.HEADLESSCODE_EMBEDDING_BACKEND = previous }
}))
