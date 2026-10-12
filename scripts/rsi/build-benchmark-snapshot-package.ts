import * as fs from "node:fs/promises"
import * as path from "node:path"
import { buildSnapshotPackage } from "../../src/rsi/benchmark/snapshot-package.js"
import type { BenchmarkTask } from "../../src/rsi/benchmark/types.js"

function argument(name: string): string {
	const index = process.argv.indexOf(name)
	const value = index >= 0 ? process.argv[index + 1] : undefined
	if (!value || value.startsWith("--")) throw new Error(`missing required argument ${name}`)
	return value
}

const repoRoot = path.resolve(argument("--repo"))
const manifestPath = path.resolve(argument("--manifest"))
const outputPath = path.resolve(argument("--output"))
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { tasks?: BenchmarkTask[] }
if (!Array.isArray(manifest.tasks)) throw new Error("benchmark manifest does not contain a task array")
const result = await buildSnapshotPackage(repoRoot, manifest.tasks, outputPath)
process.stdout.write(`${JSON.stringify(result)}\n`)
