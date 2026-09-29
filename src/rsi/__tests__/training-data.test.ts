import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { buildVerifiedTrainingDataset } from "../training-data.js"

test("verified QLoRA data and paired cells are deterministic and fixture-backed", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsi-verified-model-data-"))
	try {
		execFileSync("git", ["init", "-q", root])
		fs.cpSync(path.join(process.cwd(), "fixtures", "rsi-curriculum"), path.join(root, "fixtures", "rsi-curriculum"), { recursive: true })
		const first = buildVerifiedTrainingDataset(root)
		const again = buildVerifiedTrainingDataset(root)
		assert.equal(first.version, again.version)
		assert.equal(first.datasetSha256, again.datasetSha256)
		assert.equal(first.evaluationCellsSha256, again.evaluationCellsSha256)
		assert.equal(first.trainingCellIds.length, 3)
		assert.equal(first.evaluationCellIds.length, 3)
		assert.match(first.manifest.toString("utf8"), /"seed": 1337/)
		assert.match(first.manifest.toString("utf8"), /"maxSteps": 8/)
		assert.equal(JSON.parse(first.dataset.toString("utf8").trim().split("\n")[0]!).completion.startsWith("export function solve"), true)
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
})

test("verified dataset builder refuses a missing evaluator-owned fixture", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsi-missing-model-data-"))
	try {
		execFileSync("git", ["init", "-q", root])
		fs.cpSync(path.join(process.cwd(), "fixtures", "rsi-curriculum"), path.join(root, "fixtures", "rsi-curriculum"), { recursive: true })
		fs.rmSync(path.join(root, "fixtures", "rsi-curriculum", "generalization.json"))
		assert.throws(() => buildVerifiedTrainingDataset(root))
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
})

test("paired evaluation artifact extraction is path-safe and allowlisted", () => {
	execFileSync("python3", [path.join(process.cwd(), "scripts", "rsi-training", "test_adapter_archive.py")], { stdio: "pipe" })
})
