// Self-test for scripts/check-code-standards.mjs: builds fixture files with
// known violations in a temp dir, asserts each rule fires, and exercises the
// baseline ratchet (write -> clean -> new violation fails). Exit 1 on mismatch.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function fail(message) {
	console.error(`FAIL standards-selftest: ${message}`)
	process.exit(1)
}

function run(args) {
	try {
		const out = execFileSync("node", ["scripts/check-code-standards.mjs", ...args], {
			cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
		})
		return { status: 0, out }
	} catch (error) {
		return { status: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` }
	}
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "headlesscode-standards-"))
try {
	fs.writeFileSync(path.join(dir, "good.ts"), 'export function add(a: number, b: number): number {\n\treturn a + b\n}\n')
	const longLine = `// ${"x".repeat(90)}\n`
	const bigFn = `export function untyped(a, b) {\n${"\tconst x = a + b\n".repeat(22)}\treturn x\n}\n`
	const bad = `export class One {\n\tvalue: any\n}\n\nexport class Two {}\n${bigFn}${longLine}// eslint-disable-next-line no-console\n`
	fs.writeFileSync(path.join(dir, "bad.ts"), bad)
	const report = run([dir, "--no-baseline"])
	if (report.status !== 1) fail(`bad fixture exited ${report.status}, want 1`)
	for (const rule of ["one-class", "no-any", "function-lines", "explicit-return-type", "line-length", "no-suppress"]) {
		if (!report.out.includes(rule)) fail(`rule ${rule} did not fire`)
	}
	const clean = run([path.join(dir, "good.ts"), "--no-baseline"])
	if (clean.status !== 0) fail(`good fixture failed:\n${clean.out}`)
	const baseline = path.join(dir, "baseline.json")
	const written = run([dir, "--baseline", baseline, "--write-baseline"])
	if (written.status !== 0) fail("baseline write failed")
	const subset = run([dir, "--baseline", baseline])
	if (subset.status !== 0) fail(`ratchet clean run failed:\n${subset.out}`)
	const badPath = path.join(dir, "bad.ts")
	fs.writeFileSync(badPath, `// shift anchor\n// shift anchor\n${fs.readFileSync(badPath, "utf8")}`)
	const shifted = run([dir, "--baseline", baseline])
	if (shifted.status !== 0) fail(`line shift above violations failed the ratchet:\n${shifted.out}`)
	fs.appendFileSync(badPath, "export const late: any = 1\n")
	const fresh = run([dir, "--baseline", baseline])
	if (fresh.status !== 1 || !fresh.out.includes("NEW violations")) fail("new violation did not fail the ratchet")
} finally {
	fs.rmSync(dir, { recursive: true, force: true })
}
console.log("  ok   standards-selftest: rules fire, clean passes, ratchet write/clean/fail")
