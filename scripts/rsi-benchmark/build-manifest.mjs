import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { benchmarkTasks } from "./task-spec.mjs"
import { benchmarkTreeDigest, materializeBenchmarkSnapshot } from "../../src/rsi/benchmark/runner.ts"
import { selectUniqueNamedEntries } from "../../src/rsi/benchmark/verifier-selection.mjs"
import { classifyOracleChild } from "../../src/rsi/benchmark/oracle-process.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const fixtures = path.join(root, "fixtures/rsi-benchmark")
const verifiers = path.join(fixtures, "verifiers")
const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
const manifest = { schemaVersion: 1, runnerVersion: "1.0.0", createdFromCommit: git("rev-parse", "HEAD"), tasks: [] }

await fs.mkdir(verifiers, { recursive: true })
for (const spec of benchmarkTasks) {
	const fixCommit = git("rev-parse", `${spec.fix}^{commit}`)
	const startCommit = git("rev-parse", `${fixCommit}^`)
	let verifierPaths = spec.verifierPaths
	let verifierCommit = spec.verifierCommit ?? fixCommit
	let verifierSource = "historical-regression-test"
	if (spec.manualPath) {
		verifierPaths = [spec.manualPath]
		verifierCommit = ""
		verifierSource = "supervisor-authored-behavior-probe"
	}
	if (!verifierPaths) {
		const changed = git("diff-tree", "--no-commit-id", "--name-only", "-r", verifierCommit).split("\n")
		verifierPaths = changed.filter((file) => file.startsWith("src/") && (file.includes("/__tests__/") || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)))
	}
	if (!verifierPaths?.length) throw new Error(`${spec.id} needs a supervisor-authored behavior probe or a historical regression test source`)
	const contents = await Promise.all(verifierPaths.map(async (testPath) => {
		if (testPath.startsWith("/") || testPath.split("/").some((part) => ["", ".", "..", ".git"].includes(part))) throw new Error(`unsafe verifier test path: ${testPath}`)
		return { path: testPath, source: verifierCommit ? git("show", `${verifierCommit}:${testPath}`) : await fs.readFile(path.join(root, testPath), "utf8") }
	}))
	if (spec.verifierTestName && !spec.verifierSelectionRationale) throw new Error(`${spec.id} must document why its historical regression test is selected`)
	const selectedTestSetup = spec.verifierTestName
		? `const selectedTestName = ${JSON.stringify(spec.verifierTestName)}\nconst selectedTestFile = path.resolve(root, files[0].path)\nlet selectedTestSource = await fs.readFile(selectedTestFile, "utf8")\nconst unfilteredRunner = "for (const [name, fn] of tests) {"\nassert.ok(selectedTestSource.includes(selectedTestName), "selected historical regression test is missing")\nassert.equal(selectedTestSource.split(unfilteredRunner).length - 1, 1, "expected one historical test runner")\nconst filteredRunner = \`const selectUniqueNamedEntries = ${selectUniqueNamedEntries.toString()}; const selectedTests = selectUniqueNamedEntries(tests, ${JSON.stringify(spec.verifierTestName)}); for (const [name, fn] of selectedTests) {\`\nselectedTestSource = selectedTestSource.replace(unfilteredRunner, filteredRunner)\nawait fs.writeFile(selectedTestFile, selectedTestSource, { mode: 0o600 })`
		: ""
	const verifierCompletionCount = spec.verifierTestName ? '"1 selected regression test"' : 'files.length + " test file(s)"'
const verifierCode = `import assert from "node:assert/strict"\nimport { spawnSync } from "node:child_process"\nimport * as fs from "node:fs/promises"\nimport * as os from "node:os"\nimport * as path from "node:path"\nconst root = path.resolve(process.argv[2] ?? "")\nconst taskId = process.argv[3]\nconst requestedChildTimeoutMs = process.argv[4] === undefined ? 110000 : Number(process.argv[4])\nassert.ok(Number.isSafeInteger(requestedChildTimeoutMs) && requestedChildTimeoutMs > 0 && requestedChildTimeoutMs <= 110000, "invalid verifier child timeout")\nconst files = ${JSON.stringify(contents)}\nfor (const file of files) { const target = path.resolve(root, file.path); assert.ok(target.startsWith(root + path.sep)); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await fs.writeFile(target, file.source, { mode: 0o600 }) }\n${selectedTestSetup}\nconst testEnv = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HEADLESSCODE_OPENROUTER_API_KEY: "rsi-benchmark-dummy-key", HEADLESSCODE_BENCHMARK_TSX: process.env.HEADLESSCODE_BENCHMARK_TSX ?? "/opt/headlesscode/node_modules/tsx/dist/cli.mjs" }\nconst classifyVerifierChild = ${classifyOracleChild.toString()}\nfor (const file of files) { const target = path.resolve(root, file.path); const result = spawnSync(process.execPath, [testEnv.HEADLESSCODE_BENCHMARK_TSX, target], { cwd: root, encoding: "utf8", timeout: requestedChildTimeoutMs, maxBuffer: 4 * 1024 * 1024, env: testEnv }); const output = "" + (result.stdout ?? "") + (result.stderr ?? ""); const kind = classifyVerifierChild(result); if (kind === "infrastructure-failure") { process.stderr.write("RSI_BENCHMARK_VERIFIER_INFRA_FAILURE:" + (result.error?.code ?? result.signal ?? "missing-exit-status") + "\\n" + output); process.exit(125) } if (kind === "test-failure") { process.stderr.write(output); process.exit(result.status ?? 1) } }\nprocess.stdout.write("historical independent regression checks passed: " + taskId + " (" + ${verifierCompletionCount} + ")\\n")\n`
	const verifierPath = `verifiers/${spec.id}.mjs`
	const verifierBuffer = Buffer.from(verifierCode)
	if (verifierBuffer.byteLength > 1024 * 1024) throw new Error(`verifier too large for ${spec.id}`)
	await fs.writeFile(path.join(fixtures, verifierPath), verifierBuffer)
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), `rsi-benchmark-build-${spec.id}-`))
	const good = `${temp}-good`; const bad = `${temp}-bad`
	try {
		await fs.rmdir(temp)
		await materializeBenchmarkSnapshot({ id: spec.id, startCommit }, root, bad)
		await materializeBenchmarkSnapshot({ id: spec.id, startCommit: fixCommit }, root, good)
		const startDigest = await benchmarkTreeDigest(bad)
		const knownGoodDigest = await benchmarkTreeDigest(good)
		manifest.tasks.push({
			id: spec.id, family: spec.family, split: spec.split, task: spec.task, startCommit, startDigest,
			verifierPath, verifierDigest: sha256(verifierBuffer), knownGoodCommit: fixCommit, knownGoodDigest,
			knownBadCommit: startCommit, knownBadDigest: startDigest,
			seed: parseInt(sha256(spec.id).slice(0, 8), 16),
			ceilings: { timeoutMs: 180000, maxCalls: 30, maxOutputTokensPerCall: 2048, maxPatchBytes: 262144 },
			provenance: { fixCommit, startCommit, subject: git("show", "-s", "--format=%s", fixCommit), verifierSource, ...(verifierCommit ? { verifierCommit } : {}), verifierPaths, ...(spec.verifierTestName ? { verifierTestName: spec.verifierTestName, verifierSelectionRationale: spec.verifierSelectionRationale } : {}) },
		})
	} finally {
		await fs.rm(temp, { recursive: true, force: true }); await fs.rm(good, { recursive: true, force: true }); await fs.rm(bad, { recursive: true, force: true })
	}
}
await fs.writeFile(path.join(fixtures, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`wrote ${manifest.tasks.length} repository tasks\n`)
