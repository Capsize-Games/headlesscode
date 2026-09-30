import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { benchmarkTasks } from "./task-spec.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
const signatures = []
for (const task of benchmarkTasks) {
	const good = git("rev-parse", `${task.fix}^{commit}`)
	const bad = git("rev-parse", `${good}^`)
	const patch = git("diff", "--unified=0", bad, good, "--", "src", "package.json")
	const lines = patch.split("\n").filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
	const signature = new Set(lines.map((line) => line.slice(1).trim()).filter((line) => line.length > 12 && !/^(\/\/|\*|\{|\}|\))/.test(line)))
	signatures.push({ id: task.id, split: task.split, fix: good, paths: git("diff", "--name-only", bad, good, "--", "src", "package.json").split("\n").filter(Boolean), lines: [...signature] })
}
const overlaps = []
for (let left = 0; left < signatures.length; left++) for (let right = left + 1; right < signatures.length; right++) {
	const a = signatures[left]
	const b = signatures[right]
	if (!a || !b) continue
	if (a.split === b.split || a.lines.length < 3 || b.lines.length < 3) continue
	const common = a.lines.filter((line) => b.lines.includes(line)).length
	const similarity = common / new Set([...a.lines, ...b.lines]).size
	if (similarity >= 0.8) overlaps.push({ left: a.id, right: b.id, jaccard: Number(similarity.toFixed(3)), sharedChangedLines: common })
}
const duplicateFixes = benchmarkTasks.length !== new Set(benchmarkTasks.map((task) => git("rev-parse", `${task.fix}^{commit}`))).size
const duplicateManualOracles = benchmarkTasks.filter((task) => task.manualPath).length !== new Set(benchmarkTasks.filter((task) => task.manualPath).map((task) => task.manualPath)).size
const result = { schemaVersion: 1, uniqueFixCommits: !duplicateFixes, uniqueManualOraclePaths: !duplicateManualOracles, crossSplitNearDuplicates: overlaps, tasks: signatures.map(({ id, split, fix, paths }) => ({ id, split, fix, changedPaths: paths })) }
await fs.writeFile(path.join(root, "fixtures/rsi-benchmark/leakage-audit.json"), `${JSON.stringify(result, null, 2)}\n`)
process.stdout.write(`Cross-split fix similarity: ${overlaps.length} near-duplicate pair(s); ${signatures.length} unique tasks.\n`)
if (duplicateFixes || duplicateManualOracles || overlaps.length) process.exitCode = 1
