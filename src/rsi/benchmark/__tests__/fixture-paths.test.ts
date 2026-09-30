import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { loadBenchmark } from "../runner.js"

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-fixture-paths-"))
try {
	const copiedFixtures = path.join(tempRoot, "fixtures")
	await fs.cp(path.resolve("fixtures/rsi-benchmark/smoke"), copiedFixtures, { recursive: true })
	const manifest = JSON.parse(await fs.readFile(path.join(copiedFixtures, "manifest.json"), "utf8")) as { tasks: Array<{ verifierPath: string }> }
	const verifierParent = path.dirname(manifest.tasks[0]!.verifierPath)
	const externalVerifiers = path.join(tempRoot, "external-verifiers")
	await fs.rename(path.join(copiedFixtures, verifierParent), externalVerifiers)
	await fs.symlink(externalVerifiers, path.join(copiedFixtures, verifierParent), "dir")
	await assert.rejects(loadBenchmark(copiedFixtures), /fixture path contains a symlink/)
	console.log("Fixture manifest paths reject symlinked parent escapes")
} finally {
	await fs.rm(tempRoot, { recursive: true, force: true })
}
