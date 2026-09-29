import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const allowed = new Set(["completion-discipline", "regression-recovery", "tool-efficiency", "generalization"])
const [, , flag, fixtureId, ...extra] = process.argv
if (flag !== "--fixture" || !fixtureId || extra.length > 0 || !allowed.has(fixtureId)) {
	process.stderr.write("usage: node fixtures/rsi-curriculum/validate.mjs --fixture <registered-id>\n")
	process.exit(2)
}

const root = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(root, `${fixtureId}.json`), "utf8"))
if (fixture?.schemaVersion !== 1 || fixture.id !== fixtureId || typeof fixture.capability !== "string" || !fixture.capability || typeof fixture.description !== "string" || !fixture.description || typeof fixture.task !== "string" || !fixture.task || !Array.isArray(fixture.cases) || fixture.cases.length === 0) {
	process.stderr.write("fixture failed its schema checks\n")
	process.exit(1)
}
const reference = await import(`./cases/${fixtureId}.mjs`)
const mutant = await import(`./mutants/${fixtureId}.mjs`)
for (const item of fixture.cases) {
	assert.ok(Array.isArray(item.input), "fixture case input must be an argument list")
	assert.deepEqual(await reference.solve(...item.input), item.expected, `reference failed case ${item.name}`)
}
const mutantDetected = fixture.cases.some((item) => {
	try { return JSON.stringify(mutant.solve(...item.input)) !== JSON.stringify(item.expected) }
	catch { return true }
})
assert.ok(mutantDetected, "fixture checks must reject at least one known incorrect implementation")
process.stdout.write(`${fixtureId}:reference-pass:mutant-rejected:${fixture.cases.length}\n`)
