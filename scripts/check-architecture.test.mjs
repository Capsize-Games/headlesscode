// Self-test for scripts/check-architecture.mjs: fixture workspace with a
// known import cycle, a duplicated block, an over-complex function, deep
// nesting, too many params, and stray console/process calls; asserts each
// rule fires, then exercises the baseline ratchet. Exit 1 on mismatch.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function fail(message) {
	console.error(`FAIL architecture-selftest: ${message}`)
	process.exit(1)
}

function run(args) {
	try {
		const out = execFileSync("node_modules/.bin/tsx", ["scripts/check-architecture.mjs", ...args], {
			cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
		})
		return { status: 0, out }
	} catch (error) {
		return { status: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` }
	}
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "headlesscode-arch-"))
try {
	fs.writeFileSync(path.join(dir, "tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["*.ts"]}')
	fs.writeFileSync(path.join(dir, "a.ts"), 'import { b } from "./b"\nexport function a(): number {\n\treturn b() + 1\n}\n')
	fs.writeFileSync(path.join(dir, "b.ts"), 'import { a } from "./a"\nexport function b(): number {\n\treturn a() + 1\n}\n')
	const block = Array.from({ length: 12 }, (_, i) => `const shared${i} = compute(${i}) + offset`).join("\n")
	fs.writeFileSync(path.join(dir, "c.ts"), `export function first(): number {\n\tconst offset = 1\n\t${block.split("\n").join("\n\t")}\n\treturn shared11\n}\n`)
	fs.writeFileSync(path.join(dir, "d.ts"), `export function second(): number {\n\tconst offset = 2\n\t${block.split("\n").join("\n\t")}\n\treturn shared11\n}\n`)
	const branches = Array.from({ length: 11 }, (_, i) => `\tif (a === ${i}) {\n\t\tvalue += ${i}\n\t}`).join("\n")
	const messy = `export function tangled(a: number, b: number, c: number, d: number, e: number, f: number): number {\n\tlet value = 0\n${branches}\n\tif (value > 0) {\n\t\tif (value > 1) {\n\t\t\tif (value > 2) {\n\t\t\t\tif (value > 3) {\n\t\t\t\t\tif (value > 4) {\n\t\t\t\t\t\tconsole.log(value)\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n\tif (value < 0) {\n\t\tprocess.exit(1)\n\t}\n\treturn value\n}\n`
	fs.writeFileSync(path.join(dir, "messy.ts"), messy)
	fs.writeFileSync(path.join(dir, "cli.ts"), "console.log(process.argv)\nif (!process.argv[2]) {\n\tprocess.exit(1)\n}\n")
	fs.writeFileSync(path.join(dir, "ok.test.ts"), "console.log('trace')\n")
	const report = run([dir, "--workspace", dir, "--no-baseline"])
	if (report.status !== 1) fail(`fixture exited ${report.status}, want 1`)
	if (/cli\.ts.*(console|process-exit)|ok\.test\.ts.*console/.test(report.out)) fail("entry/test console exemptions misfired")
	for (const rule of ["cycle", "clone", "complexity", "nesting", "params", "console", "process-exit"]) {
		if (!report.out.includes(rule)) fail(`rule ${rule} did not fire`)
	}
	const baseline = path.join(dir, "baseline.json")
	if (run([dir, "--workspace", dir, "--baseline", baseline, "--write-baseline"]).status !== 0) fail("baseline write failed")
	if (run([dir, "--workspace", dir, "--baseline", baseline]).status !== 0) fail("ratchet clean run failed")
	fs.appendFileSync(path.join(dir, "messy.ts"), "console.log(tangled(1, 2, 3, 4, 5, 6))\n")
	const fresh = run([dir, "--workspace", dir, "--baseline", baseline])
	if (fresh.status !== 1 || !fresh.out.includes("NEW findings")) fail("new finding did not fail the ratchet")
	const diamond = fs.mkdtempSync(path.join(os.tmpdir(), "headlesscode-diamond-"))
	try {
		fs.writeFileSync(path.join(diamond, "tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["*.ts"]}')
		fs.writeFileSync(path.join(diamond, "s.ts"), 'import "./a"\nimport "./b"\nexport const s = 1\n')
		fs.writeFileSync(path.join(diamond, "a.ts"), 'import "./t"\nexport const a = 1\n')
		fs.writeFileSync(path.join(diamond, "b.ts"), 'import "./t"\nexport const b = 1\n')
		fs.writeFileSync(path.join(diamond, "t.ts"), 'import "./s"\nexport const t = 1\n')
		const cycles = run([diamond, "--workspace", diamond, "--no-baseline"]).out.split("\n").filter((l) => l.startsWith("cycle")).sort()
		const want = ["cycle a.ts -> t.ts -> s.ts -> a.ts", "cycle t.ts -> s.ts -> b.ts -> t.ts"].sort()
		if (JSON.stringify(cycles) !== JSON.stringify(want)) fail(`diamond cycles ${JSON.stringify(cycles)}, want ${JSON.stringify(want)}`)
	} finally {
		fs.rmSync(diamond, { recursive: true, force: true })
	}
} finally {
	fs.rmSync(dir, { recursive: true, force: true })
}
console.log("  ok   architecture-selftest: rules fire, ratchet write/clean/fail")
