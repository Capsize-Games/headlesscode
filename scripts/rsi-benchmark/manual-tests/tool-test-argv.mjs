import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

const root = process.cwd()
const { runOneTestFile } = await import(pathToFileURL(path.join(root, "src/tools/run-tests.ts")))
assert.equal(typeof runOneTestFile, "function", "the test runner exposes its argv boundary for behavioral testing")
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-argv-boundary-"))
const bin = path.join(temporary, "bin")
const capture = path.join(temporary, "argv.json")
const priorPath = process.env.PATH
try {
	await fs.mkdir(bin)
	const shim = path.join(bin, "npx")
	await fs.writeFile(shim, "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.RSI_ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)))\n", { mode: 0o755 })
	process.env.PATH = `${bin}${path.delimiter}${priorPath ?? ""}`
	process.env.RSI_ARGV_CAPTURE = capture
	const hostilePath = "spec $(touch PWNED).test.ts`echo PWNED2`"
	const result = await runOneTestFile(temporary, hostilePath, 5)
	assert.equal(result.exitCode, 0, result.output)
	assert.equal(result.timedOut, false)
	assert.deepEqual(JSON.parse(await fs.readFile(capture, "utf8")), ["--no-install", "tsx", hostilePath], "hostile path must arrive as one literal argv element")
	await assert.rejects(fs.access(path.join(temporary, "PWNED")))
	assert.doesNotMatch(result.output, /PWNED2/)
	console.log("run_tests passes hostile path as literal argv")
} finally {
	if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath
	delete process.env.RSI_ARGV_CAPTURE
	await fs.rm(temporary, { recursive: true, force: true })
}
