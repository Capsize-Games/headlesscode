import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { generateCurriculumProposals, promoteArchivedCurriculumTask, promoteValidatedCurriculumTask, validateCurriculumProposals, validateCurriculumTask } from "../curriculum.js"
import { readArchive, writeArchive } from "../archive.js"
import type { CandidateRecord, CurriculumTask, RsiArchive } from "../types.js"

const baseCommit = "a".repeat(40)
const digest = createHash("sha256").update("fixture output").digest("hex")
const sourceCandidate: CandidateRecord = {
	id: "failed-curriculum-source", generation: 0, parent: "baseline", branch: "failed", worktree: "/tmp/failed", baseCommit,
	status: "failed", model: "local", mutation: "fixture", createdAt: "now", updatedAt: "now", commits: [], changedFiles: [],
	protectedPathViolations: [], failure: "Max iterations (10) reached without task completion",
}
const emptyArchive: RsiArchive = {
	schemaVersion: 2, updatedAt: "now", runs: [], activeRuns: [], candidates: [sourceCandidate], modelCandidates: [],
	combinations: [], jobs: [], trajectoryRefs: [], curriculumTasks: [],
}
const proposal = generate()

function generate(): CurriculumTask {
	const task = (awaitProposals())[0]
	assert.ok(task)
	return task
}

function awaitProposals(): CurriculumTask[] {
	// The generator is synchronous; keep this helper named to make fixture setup explicit.
	return generateCurriculumProposals(emptyArchive, "2026-09-28T00:00:00.000Z")
}

test("registered executable fixtures pass their reference cases and reject known mutants", async () => {
	const ids = ["completion-discipline", "regression-recovery", "tool-efficiency", "generalization"]
	for (const id of ids) {
		const manifest = JSON.parse(await fs.readFile(path.join(process.cwd(), "fixtures", "rsi-curriculum", `${id}.json`), "utf8")) as { id: string; task: string; capability: string; description: string }
		assert.equal(manifest.id, id)
		assert.ok(manifest.task.length > 0 && manifest.capability.length > 0 && manifest.description.length > 0)
		const command = `node fixtures/rsi-curriculum/validate.mjs --fixture ${id}`
		const output = execFileSync("node", ["fixtures/rsi-curriculum/validate.mjs", "--fixture", id], { cwd: process.cwd(), encoding: "utf8" })
		assert.match(output, new RegExp(`^${id}:reference-pass:mutant-rejected:`))
		assert.ok(!command.includes("$") && !command.includes(";") && !command.includes("|"), "registered fixture command has no shell operators")
	}
	assert.throws(() => execFileSync("node", ["fixtures/rsi-curriculum/validate.mjs", "--fixture", "missing"], { cwd: process.cwd(), stdio: "pipe" }))
	const mapped = generateCurriculumProposals({
		...emptyArchive,
		candidates: [
			sourceCandidate,
			{ ...sourceCandidate, id: "regression-source", failure: undefined, fitness: { ...sourceCandidate.fitness, hardGates: { regressionPass: false } } } as CandidateRecord,
			{ ...sourceCandidate, id: "timeout-source", failure: undefined, result: { ok: false, timedOut: true } } as CandidateRecord,
			{ ...sourceCandidate, id: "evaluation-source", failure: undefined, result: { ok: false } } as CandidateRecord,
		],
	})
	for (const task of mapped) {
		const manifest = JSON.parse(await fs.readFile(path.join(process.cwd(), "fixtures", "rsi-curriculum", `${task.fixtureId}.json`), "utf8")) as { task: string; capability: string; description: string }
		assert.equal(task.task, manifest.task)
		assert.equal(task.capability, manifest.capability)
		assert.equal(task.fixtureDescription, manifest.description)
	}
})

test("two successful matching clean replays validate a registered fixture", async () => {
	let calls = 0
	const [validated] = await validateCurriculumProposals([proposal], baseCommit, async (_task, _attempt, key) => {
		calls += 1
		assert.match(key, /^curriculum:curriculum-iteration-cap:replay:[12]$/)
		return { ok: true, exitCode: 0, outputSha256: digest }
	}, "2026-09-28T00:00:00.000Z")
	assert.equal(calls, 2)
	assert.equal(validated?.validated, true)
	assert.equal(validated?.validation?.reproducible, true)
	assert.equal(validated?.validation?.baseCommit, baseCommit)
	assert.match(validated?.validation?.reason ?? "", /rejected a known mutant/)
})

test("unknown fixture, modified command, missing files, failed and non-reproducible runs stay unvalidated", async () => {
	let calls = 0
	const runReplay = async (): Promise<{ ok: boolean; exitCode: number | null; outputSha256: string }> => {
		calls += 1
		return { ok: true, exitCode: 0, outputSha256: digest }
	}
	const [wrongCommand] = await validateCurriculumProposals([{ ...proposal, groundTruthCommand: "npm test" }], baseCommit, runReplay)
	assert.equal(wrongCommand?.validated, false)
	assert.match(wrongCommand?.validation?.reason ?? "", /exact registered fixture and command/)
	const [wrongTask] = await validateCurriculumProposals([{ ...proposal, task: "invented task with unrelated fixture" }], baseCommit, runReplay)
	assert.equal(wrongTask?.validated, false)
	assert.match(wrongTask?.validation?.reason ?? "", /exact registered fixture and command/)
	assert.equal(calls, 0, "a prompt mismatch must not enqueue or execute the registered command")
	const [missingFixture] = await validateCurriculumProposals([{ ...proposal, fixtureId: "missing" }], baseCommit, runReplay)
	assert.equal(missingFixture?.validated, false)
	assert.equal(calls, 0, "unregistered fixture input must not be executed")
	const [failed] = await validateCurriculumProposals([proposal], baseCommit, async () => ({ ok: false, exitCode: 1, outputSha256: digest, failure: "reference check failed" }))
	assert.equal(failed?.validated, false)
	assert.match(failed?.validation?.reason ?? "", /reference check failed/)
	let replay = 0
	const [different] = await validateCurriculumProposals([proposal], baseCommit, async () => ({ ok: true, exitCode: 0, outputSha256: replay++ === 0 ? digest : "b".repeat(64) }))
	assert.equal(different?.validated, false)
	assert.match(different?.validation?.reason ?? "", /same output digest/)
	const [badBase] = await validateCurriculumProposals([proposal], "HEAD", runReplay)
	assert.equal(badBase?.validated, false)
})

test("malformed proposal and provenance shapes fail closed without throwing", () => {
	assert.equal(validateCurriculumTask(undefined as unknown as CurriculumTask), false)
	assert.equal(validateCurriculumTask({ ...proposal, provenance: undefined } as unknown as CurriculumTask), false)
	assert.equal(validateCurriculumTask({ ...proposal, provenance: { ...proposal.provenance, sourceCandidateIds: undefined } } as unknown as CurriculumTask), false)
	assert.equal(validateCurriculumTask({ ...proposal, provenance: { ...proposal.provenance, sourceCandidateIds: [null] } } as unknown as CurriculumTask), false)
})

test("missing fixture files fail the executable command", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-missing-fixture-"))
	try {
		const source = path.join(process.cwd(), "fixtures", "rsi-curriculum")
		const destination = path.join(root, "fixtures", "rsi-curriculum")
		await fs.cp(source, destination, { recursive: true })
		await fs.rm(path.join(destination, "completion-discipline.json"))
		assert.throws(() => execFileSync("node", ["fixtures/rsi-curriculum/validate.mjs", "--fixture", "completion-discipline"], { cwd: root, stdio: "pipe" }))
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("promotion requires validation and is persisted to archive and report only when explicit", async () => {
	const [validated] = await validateCurriculumProposals([proposal], baseCommit, async () => ({ ok: true, exitCode: 0, outputSha256: digest }))
	assert.ok(validated)
	assert.throws(() => promoteValidatedCurriculumTask(proposal), /valid reproducible fixture evidence/)
	assert.throws(() => promoteValidatedCurriculumTask({ ...validated, validation: { ...validated.validation!, command: "node malicious.mjs" } }), /valid reproducible fixture evidence/)
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-curriculum-promotion-"))
	try {
		const reportPath = path.join(root, "run.md")
		await fs.writeFile(reportPath, "# Run report\n", "utf8")
		const archive: RsiArchive = {
			...emptyArchive,
			curriculumTasks: [validated],
			runs: [{
				runId: "curriculum-test", startedAt: "now", model: "local", baseRef: "HEAD", baseCommit,
				generations: 1, candidates: [], reports: [reportPath], curriculumTasks: [validated],
			}],
		}
		await writeArchive(root, archive)
		const cli = path.join(process.cwd(), "node_modules", ".bin", "tsx")
		const output = execFileSync(cli, ["src/rsi/promote-curriculum.ts", "--archive-dir", root, "--task-id", validated.id], { cwd: process.cwd(), encoding: "utf8" })
		assert.match(output, /curriculum-iteration-cap promoted at/)
		const persisted = await readArchive(root)
		assert.equal(typeof persisted.curriculumTasks[0]?.promotedAt, "string")
		assert.equal(persisted.runs[0]?.curriculumTasks?.[0]?.promotedAt, persisted.curriculumTasks[0]?.promotedAt)
		assert.match(await fs.readFile(reportPath, "utf8"), /explicitly promoted/)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("promotion surfaces report write failure and leaves archive unpromoted", async () => {
	const [validated] = await validateCurriculumProposals([proposal], baseCommit, async () => ({ ok: true, exitCode: 0, outputSha256: digest }))
	assert.ok(validated)
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-curriculum-report-failure-"))
	try {
		const reportPath = path.join(root, "report-is-a-directory")
		await fs.mkdir(reportPath)
		const archive: RsiArchive = {
			...emptyArchive,
			curriculumTasks: [validated],
			runs: [{ runId: "curriculum-report-failure", startedAt: "now", model: "local", baseRef: "HEAD", baseCommit, generations: 1, candidates: [], reports: [reportPath], curriculumTasks: [validated] }],
		}
		await writeArchive(root, archive)
		await assert.rejects(promoteArchivedCurriculumTask(root, validated.id), /EISDIR|illegal operation on a directory/)
		const persisted = await readArchive(root)
		assert.equal(persisted.curriculumTasks[0]?.promotedAt, undefined)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
