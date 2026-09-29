import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

export const RSI_TRAINING_FIXTURE_IDS = ["completion-discipline", "regression-recovery", "tool-efficiency"] as const
export const RSI_MODEL_EVAL_FIXTURE_IDS = ["generalization"] as const

export interface VerifiedTrainingDataset {
	version: string
	dataset: Buffer
	datasetSha256: string
	evaluationCells: Buffer
	evaluationCellsSha256: string
	manifest: Buffer
	manifestSha256: string
	trainingCellIds: string[]
	evaluationCellIds: string[]
}

function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex")
}

function sourceRecord(root: string, relativePath: string): { path: string; sha256: string } {
	const content = fs.readFileSync(path.join(root, relativePath))
	return { path: relativePath, sha256: digest(content) }
}

/** Build only from evaluator-owned fixtures whose reference passes and known mutant fails. */
export function buildVerifiedTrainingDataset(repoRoot: string): VerifiedTrainingDataset {
	const fixtureRoot = path.join(repoRoot, "fixtures", "rsi-curriculum")
	const validatorPath = path.join(fixtureRoot, "validate.mjs")
	const sourceFiles = [sourceRecord(repoRoot, "fixtures/rsi-curriculum/validate.mjs")]
	const trainingCellIds: string[] = []
	const evaluationCellIds: string[] = []
	const rows: Array<{ id: string; prompt: string; completion: string }> = []
	const evaluationRows: Array<{ id: string; prompt: string; completion: string }> = []
	const fixtureDigests: Record<string, string> = {}
	for (const fixtureId of [...RSI_TRAINING_FIXTURE_IDS, ...RSI_MODEL_EVAL_FIXTURE_IDS]) {
		execFileSync(process.execPath, [validatorPath, "--fixture", fixtureId], { cwd: repoRoot, timeout: 10_000, stdio: "pipe" })
		const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, fixtureId + ".json"), "utf8")) as { id?: string; task?: string; cases?: Array<{ name?: string; input?: unknown[]; expected?: unknown }> }
		if (fixture.id !== fixtureId || typeof fixture.task !== "string" || !Array.isArray(fixture.cases) || fixture.cases.length === 0) throw new Error("registered RSI training fixture is malformed: " + fixtureId)
		const paths = [
			"fixtures/rsi-curriculum/" + fixtureId + ".json",
			"fixtures/rsi-curriculum/cases/" + fixtureId + ".mjs",
			"fixtures/rsi-curriculum/mutants/" + fixtureId + ".mjs",
		]
		for (const source of paths) sourceFiles.push(sourceRecord(repoRoot, source))
		fixtureDigests[fixtureId] = digest(fs.readFileSync(path.join(repoRoot, paths[0]!)))
		if ((RSI_TRAINING_FIXTURE_IDS as readonly string[]).includes(fixtureId)) {
			const completion = fs.readFileSync(path.join(fixtureRoot, "cases", fixtureId + ".mjs"), "utf8").trim()
			rows.push({
				id: fixtureId,
				prompt: "Implement this task as a JavaScript module exporting solve(...): " + fixture.task,
				completion,
			})
			trainingCellIds.push(fixtureId)
		} else {
			const completion = fs.readFileSync(path.join(fixtureRoot, "cases", fixtureId + ".mjs"), "utf8").trim()
			for (const item of fixture.cases) {
				const id = fixtureId + ":" + (item.name ?? "")
				evaluationCellIds.push(id)
				evaluationRows.push({
					id,
					prompt: "Implement this task as a JavaScript module exporting solve(...): " + fixture.task + "\nCase input: " + JSON.stringify(item.input) + "\nExpected behavior: " + JSON.stringify(item.expected),
					completion,
				})
			}
		}
	}
	const dataset = Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
	const datasetSha256 = digest(dataset)
	const evaluationCells = Buffer.from(evaluationRows.map((row) => JSON.stringify(row)).join("\n") + "\n")
	const evaluationCellsSha256 = digest(evaluationCells)
	const manifestValue = {
		schemaVersion: 1,
		backend: "transformers-peft-qlora-v1",
		trainingFixtureIds: [...RSI_TRAINING_FIXTURE_IDS],
		evaluationFixtureIds: [...RSI_MODEL_EVAL_FIXTURE_IDS],
		trainingCellIds,
		evaluationCellIds,
		fixtureDigests,
		sourceFiles: sourceFiles.sort((a, b) => a.path.localeCompare(b.path)),
		datasetSha256,
		evaluationCellsSha256,
		rowCount: rows.length,
		maxSteps: 8,
		seed: 1337,
	}
	const manifest = Buffer.from(JSON.stringify(manifestValue, null, 2) + "\n")
	return {
		version: digest(manifest),
		dataset,
		datasetSha256,
		evaluationCells,
		evaluationCellsSha256,
		manifest,
		manifestSha256: digest(manifest),
		trainingCellIds,
		evaluationCellIds,
	}
}
