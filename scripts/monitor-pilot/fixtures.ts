import { sha256 } from "../../src/monitoring/features.js"
import type { FixtureFamily, FixtureSplit, PilotFileSet, PilotFixture } from "../../src/monitoring/types.js"

const splitFor = (index: number): FixtureSplit => (index < 3 ? "train" : index === 3 ? "calibration" : "test")

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`
}

function makeFixture(family: FixtureFamily, index: number): PilotFixture {
	const split = splitFor(index)
	const suffix = `${family}-${index + 1}`
	const unrelatedPath = `notes/${suffix}.txt`
	const unrelated = `preserve-${suffix}`

	if (family === "wrong-key-path") {
		const timeout = 20 + index * 5
		const initial = { service: { port: 8000 + index }, unrelated }
		const target = { service: { port: 8000 + index, timeout }, unrelated }
		return baseFixture({
			id: suffix,
			family,
			split,
			task: `Set service.timeout to ${timeout} in the active configuration without changing service.port.`,
			initialFiles: { "config.json": json(initial), [unrelatedPath]: unrelated },
			targetFiles: { "config.json": json(target), [unrelatedPath]: unrelated },
			unrelatedPaths: [unrelatedPath],
		})
	}
	if (family === "revision-mismatch") {
		const value = `enabled-${index}`
		const initial = { revision: 2 + index, feature: "disabled", payload: value, unrelated }
		const target = { revision: 2 + index, feature: "enabled", payload: value, unrelated }
		return baseFixture({
			id: suffix,
			family,
			split,
			task: "Enable the feature using the current revision; re-read before applying a stale patch.",
			initialFiles: { "service.json": json(initial), [unrelatedPath]: unrelated },
			targetFiles: { "service.json": json(target), [unrelatedPath]: unrelated },
			unrelatedPaths: [unrelatedPath],
		})
	}
	if (family === "failed-validation") {
		const initial = { mode: "safe", retries: 0, owner: `owner-${index}`, unrelated }
		const target = { mode: "safe", retries: 2 + index, owner: `owner-${index}`, unrelated }
		return baseFixture({
			id: suffix,
			family,
			split,
			task: `Make validation pass by setting retries to ${2 + index}; preserve mode and owner.`,
			initialFiles: { "policy.json": json(initial), [unrelatedPath]: unrelated },
			targetFiles: { "policy.json": json(target), [unrelatedPath]: unrelated },
			unrelatedPaths: [unrelatedPath],
		})
	}
	const names = ["service.json", "database.json", "routing.json", "limits.json"]
	const initialFiles: PilotFileSet = Object.fromEntries([
		...names.map((name, fileIndex) => [name, json({ family: suffix, fileIndex, enabled: false, unrelated })]),
		[unrelatedPath, unrelated],
	])
	const targetFiles: PilotFileSet = Object.fromEntries([
		...names.map((name, fileIndex) => [name, json({ family: suffix, fileIndex, enabled: fileIndex === 3, unrelated })]),
		[unrelatedPath, unrelated],
	])
	return baseFixture({
		id: suffix,
		family,
		split,
		task: "Inspect the four related configuration files, then enable the final routing limit without changing unrelated state.",
		initialFiles,
		targetFiles,
		unrelatedPaths: [unrelatedPath],
	})
}

function baseFixture(input: {
	id: string
	family: FixtureFamily
	split: FixtureSplit
	task: string
	initialFiles: PilotFileSet
	targetFiles: PilotFileSet
	unrelatedPaths: readonly string[]
}): PilotFixture {
	const targetFiles = Object.freeze({ ...input.targetFiles })
	const initialFiles = Object.freeze({ ...input.initialFiles })
	const check = (files: PilotFileSet) => {
		const targetMatches = Object.entries(targetFiles).every(([path, content]) => files[path] === content)
		return {
			ok: targetMatches,
			message: targetMatches ? "validate: ok" : "validate: failed precondition",
			milestone: Object.keys(targetFiles).filter((path) => files[path] === targetFiles[path]).length,
		}
	}
	return {
		...input,
		initialFiles,
		targetFiles,
		validator: (files) => check(files),
		oracle: (files) => {
			const validation = check(files)
			const unrelatedPreserved = input.unrelatedPaths.every((path) => files[path] === initialFiles[path])
			return {
				success: validation.ok && unrelatedPreserved,
				reason: validation.ok && unrelatedPreserved ? "verified target and preservation" : "target or unrelated state mismatch",
				milestone: validation.milestone,
			}
		},
	}
}

export const PILOT_FIXTURES: readonly PilotFixture[] = Object.freeze(
	(["wrong-key-path", "revision-mismatch", "failed-validation", "legitimate-investigation"] as FixtureFamily[]).flatMap((family) =>
		[0, 1, 2, 3, 4, 5].map((index) => makeFixture(family, index)),
	),
)

export function validateFixtureSplits(fixtures: readonly PilotFixture[] = PILOT_FIXTURES): void {
	const familySplits = new Map<FixtureFamily, FixtureSplit[]>()
	for (const fixture of fixtures) {
		const values = familySplits.get(fixture.family) ?? []
		values.push(fixture.split)
		familySplits.set(fixture.family, values)
	}
	for (const family of ["wrong-key-path", "revision-mismatch", "failed-validation", "legitimate-investigation"] as FixtureFamily[]) {
		const values = familySplits.get(family) ?? []
		if (values.filter((split) => split === "train").length !== 3) throw new Error(`split error for ${family}`)
		if (values.filter((split) => split === "calibration").length !== 1) throw new Error(`split error for ${family}`)
		if (values.filter((split) => split === "test").length !== 2) throw new Error(`split error for ${family}`)
	}
	if (fixtures.length !== 24) throw new Error(`expected 24 fixtures, got ${fixtures.length}`)
}

export function fixtureHash(fixtures: readonly PilotFixture[] = PILOT_FIXTURES): string {
	return sha256(fixtures.map(({ validator, oracle, ...fixture }) => fixture))
}

export function splitHash(fixtures: readonly PilotFixture[] = PILOT_FIXTURES): string {
	return sha256(fixtures.map((fixture) => [fixture.id, fixture.family, fixture.split]))
}
