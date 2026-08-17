// End-to-end regression guard for the Part A fix in src/project-store.ts:
// resolveProjectDataDir() must NOT stamp a project.json into the store when
// the workspace root resolves under the OS temp dir — even with NO
// $HEADLESSCODE_DATA_DIR override in effect. Production code paths never
// create real workspaces under os.tmpdir() (only test files mkdtemp there),
// so this is the reliable "ephemeral test/scratch" signal.
//
// Rather than a static grep (which would be load-bearing and break the
// moment any test legitimately touches the store), this exercises the REAL
// guard end-to-end: a child tsx process with HEADLESSCODE_DATA_DIR deleted
// from its env calls resolveProjectDataDir() on a throwaway /tmp workspace
// and prints the resolved central dir; the parent asserts no project.json
// appeared there, then cleans the (possibly created) empty dir up. Run via
// `npm test` (extra entry in scripts/run-tests.mjs's EXTRA_FILES, same as
// scripts/check-page-script.mjs).

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..")

/** Same ancestor walk-up tsx resolution as scripts/run-tests.mjs. */
function resolveTsxBin(dir) {
	let current = dir
	while (true) {
		const candidate = path.join(current, "node_modules", ".bin", "tsx")
		if (fs.existsSync(candidate)) {
			return candidate
		}
		const parent = path.dirname(current)
		if (parent === current) {
			throw new Error(`check-tmpdir-project-store: could not find node_modules/.bin/tsx walking up from ${dir}`)
		}
		current = parent
	}
}

function main() {
	const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "hc-check-tmpguard-"))
	const ws = path.join(tmpBase, "workspace")
	fs.mkdirSync(ws)
	const scratchDir = path.join(repoRoot, ".headlesscode", "scratch")
	fs.mkdirSync(scratchDir, { recursive: true })
	const helper = path.join(scratchDir, `check-tmpdir-project-store-helper-${process.pid}.ts`)
	// The helper resolves the central dir for the /tmp workspace and prints it;
	// relative import from <root>/.headlesscode/scratch/ up to <root>/src/.
	fs.writeFileSync(
		helper,
		[
			'import { resolveProjectDataDir } from "../../src/project-store.js"',
			"const ws = process.argv[2]",
			"process.stdout.write(resolveProjectDataDir(ws))",
			"",
		].join("\n"),
		"utf-8",
	)
	try {
		// Child process with the override GONE from its env — the whole point:
		// this must be safe even when someone runs a test file directly.
		const env = { ...process.env }
		delete env.HEADLESSCODE_DATA_DIR
		const out = execFileSync(resolveTsxBin(repoRoot), [helper, ws], {
			cwd: repoRoot,
			encoding: "utf-8",
			env,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim()
		const dir = path.resolve(out)
		const metaPath = path.join(dir, "project.json")
		if (fs.existsSync(metaPath)) {
			console.error(`FAIL check-tmpdir-project-store: ${metaPath} exists — a /tmp workspace wrote into the real store`)
			process.exit(1)
		}
		// The dir itself may have been created (callers still need somewhere to
		// write permissions.json etc.) — remove it so the guard test never adds
		// even an empty dir to the real store. Only touch a 16-hex project-key
		// dir under a `projects/` parent.
		const parent = path.basename(path.dirname(dir))
		const base = path.basename(dir)
		if (parent === "projects" && /^[0-9a-f]{16}$/.test(base)) {
			fs.rmSync(dir, { recursive: true, force: true })
		}
		console.log("  ok   check-tmpdir-project-store: /tmp workspace left no project.json in the real store")
	} catch (error) {
		const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : ""
		console.error("FAIL check-tmpdir-project-store: guard exercise crashed")
		console.error(stderr || (error instanceof Error ? error.message : String(error)))
		process.exit(1)
	} finally {
		fs.rmSync(helper, { force: true })
		fs.rmSync(tmpBase, { recursive: true, force: true })
	}
}

main()
