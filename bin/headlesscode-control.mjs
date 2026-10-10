#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
let current = root
let tsxCli
while (true) {
	const candidate = path.join(current, "node_modules", "tsx", "dist", "cli.mjs")
	if (fs.existsSync(candidate)) { tsxCli = candidate; break }
	const parent = path.dirname(current)
	if (parent === current) break
	current = parent
}
if (!tsxCli) {
	process.stderr.write("headlesscode-control: cannot find the tsx runtime; install this package's dependencies and retry.\n")
	process.exit(1)
}
const result = spawnSync(process.execPath, [tsxCli, path.join(root, "src", "control", "cli.ts"), ...process.argv.slice(2)], {
	stdio: "inherit",
	env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "tsconfig.json") },
})
if (result.error) {
	process.stderr.write(`headlesscode-control: failed to launch: ${result.error.message}\n`)
	process.exit(1)
}
process.exit(result.status ?? 1)
