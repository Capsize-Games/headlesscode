/**
 * Regression guard for the SHIPPED stack-rules content in `shared/stacks/`.
 *
 * The central stack-rules tier is a shipped set (see docs/stack-rules.md):
 * the canonical copy lives in the repo at `shared/stacks/<stack>/rules.md`
 * and is installed into the runtime's central store by scripts/install-cli.sh
 * (and seeded in the Docker image at entrypoint). This test pins that
 * contract so a content PR can't land a missing or empty rules.md, or a
 * directory whose name isn't a canonical stack.
 *
 * Unlike src/engine/__tests__/stacks.test.ts, this reads the REPO's shipped
 * tree directly (no HOME sandboxing — it never touches the central store).
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/stack-rules-content.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { STACK_NAMES } from "./engine/stacks.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SHIPPED_DIR = path.join(repoRoot, "shared", "stacks")

function listShippedStacks(): string[] {
	if (!fs.existsSync(SHIPPED_DIR)) {
		return []
	}
	return fs
		.readdirSync(SHIPPED_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
}

/** Every shipped stack dir is a canonical stack with a non-empty rules.md. */
function testShippedDirsAreCanonicalAndNonEmpty(): void {
	const stacks = listShippedStacks()
	assert.ok(stacks.length > 0, `expected at least one shipped stack dir under shared/stacks/ (got none)`)
	for (const stack of stacks) {
		assert.ok(
			(STACK_NAMES as readonly string[]).includes(stack),
			`shared/stacks/${stack} is not a canonical stack name (${STACK_NAMES.join(", ")})`,
		)
		const file = path.join(SHIPPED_DIR, stack, "rules.md")
		assert.ok(fs.existsSync(file), `missing shipped rules.md for stack "${stack}"`)
		const content = fs.readFileSync(file, "utf-8").trim()
		assert.ok(content.length > 0, `shipped rules.md for stack "${stack}" is empty`)
	}
}

/** The stacks shipped in this round (javascript + python) are present and non-empty. */
function testRoundStacksShipped(): void {
	for (const stack of ["javascript", "python"]) {
		const file = path.join(SHIPPED_DIR, stack, "rules.md")
		assert.ok(fs.existsSync(file), `expected shipped rules.md for "${stack}"`)
		assert.ok(fs.readFileSync(file, "utf-8").trim().length > 0, `expected non-empty rules.md for "${stack}"`)
	}
}

const tests: Array<[string, () => void]> = [
	["shipped stack dirs are canonical stacks with non-empty rules.md", testShippedDirsAreCanonicalAndNonEmpty],
	["javascript + python content shipped", testRoundStacksShipped],
]

function main(): void {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? err.stack : err)
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} stack-rules-content tests passed`)
}

main()
