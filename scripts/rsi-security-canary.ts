import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { runOpenShellBenchmarkVerifier, resolveRsiEvaluatorRuntimeIdentity } from "../src/rsi/openshell.js"
import { evaluatorImageReference } from "../src/rsi/evaluator-runtime.js"
import { parseRsiArgs } from "../src/rsi/config.js"
import type { CandidateRecord } from "../src/rsi/types.js"

if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
	process.stdout.write("Usage: npm run rsi:security-canary\nRuns a disposable CPU-only OpenShell isolation probe without model inference.\nConfigure the operator gateway before running; reports are saved under .headlesscode/scratch.\n")
	process.exit(0)
}
if (process.argv.length > 2) throw new Error("rsi:security-canary accepts only --help or no arguments")

const scratchRoot = path.resolve(".headlesscode/scratch")
await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 })
process.env.TMPDIR = scratchRoot
const runRoot = await fs.mkdtemp(path.join(scratchRoot, "rsi-security-canary-"))
const repoRoot = path.join(runRoot, "candidate")
const archiveDir = path.join(repoRoot, ".headlesscode", "rsi-archive")
const hostCanary = path.join(runRoot, "host-canary.txt")
const controlCanary = path.join(runRoot, "host-control-canary.txt")
const reportPath = path.join(scratchRoot, `rsi-security-canary-report-${Date.now()}-${randomUUID().slice(0, 8)}.json`)

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
const git = (args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()
let report: Record<string, unknown> = {
	schemaVersion: 1,
	qualification: "synthetic-openshell-candidate-isolation",
	providerTeardownCompleted: false,
	modelInference: "none",
	runtimeProfile: {
		evaluatorImageReference: null,
		evaluatorImageSource: "not resolved",
		evaluatorPolicySha256: null,
		gatewayAlias: process.env.OPENSHELL_GATEWAY ?? null,
		gatewayIdentitySource: process.env.OPENSHELL_GATEWAY ? "configured provider gateway alias; remote endpoint identity is not exposed" : "not exposed",
		controlProfileIdentity: null,
		controlIdentitySource: "no emergency-control profile is configured by the RSI canary provider path",
	},
}

async function main(): Promise<void> {
	const evaluatorRuntime = await resolveRsiEvaluatorRuntimeIdentity()
	Object.assign(report.runtimeProfile as Record<string, unknown>, {
		evaluatorImageReference: evaluatorImageReference(evaluatorRuntime.imageDigest),
		evaluatorImageSource: evaluatorRuntime.identitySource,
		evaluatorPolicySha256: evaluatorRuntime.policySha256,
	})
	await fs.mkdir(path.join(repoRoot, "src", "rsi"), { recursive: true })
	await fs.mkdir(path.join(repoRoot, "scripts", "eval-suite"), { recursive: true })
	await fs.mkdir(archiveDir, { recursive: true, mode: 0o700 })
	const evaluatorPath = path.join(repoRoot, "src", "rsi", "evaluator-canary.ts")
	const scoringPath = path.join(repoRoot, "scripts", "eval-suite", "score-canary.ts")
	const archiveCanary = path.join(archiveDir, "archive-canary.json")
	const hostMarker = `synthetic-host-canary-${randomUUID()}\n`
	const controlMarker = `synthetic-control-canary-${randomUUID()}\n`
	await Promise.all([
		fs.writeFile(path.join(repoRoot, "README.md"), "Disposable RSI isolation canary fixture.\n"),
		fs.writeFile(path.join(repoRoot, "src", "answer.js"), "export const answer = 42\n"),
		fs.writeFile(evaluatorPath, "export const evaluatorCanary = 'synthetic-only'\n"),
		fs.writeFile(scoringPath, "export const scoringCanary = 'synthetic-only'\n"),
		fs.writeFile(archiveCanary, "synthetic-only archive canary\n", { mode: 0o600 }),
		fs.writeFile(hostCanary, hostMarker, { mode: 0o600 }),
		fs.writeFile(controlCanary, controlMarker, { mode: 0o600 }),
	])
	execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repoRoot })
	execFileSync("git", ["config", "user.name", "HeadlessCode security canary"], { cwd: repoRoot })
	execFileSync("git", ["config", "user.email", "security-canary@invalid.example"], { cwd: repoRoot })
	execFileSync("git", ["add", "README.md", "src", "scripts"], { cwd: repoRoot })
	execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "synthetic isolation canary"], { cwd: repoRoot })
	const commit = git(["rev-parse", "HEAD"])
	const parsed = parseRsiArgs(["--repo", repoRoot, "--archive-dir", archiveDir, "--worktree-dir", path.join(repoRoot, ".worktrees", "canary")])
	if (!parsed.config) throw new Error(parsed.error ?? "could not construct disposable RSI canary configuration")
	const candidate: CandidateRecord = {
		id: `security-canary-${randomUUID().slice(0, 8)}`,
		generation: 0,
		parent: "synthetic-base",
		branch: "main",
		worktree: repoRoot,
		baseCommit: commit,
		status: "evaluating",
		model: "no-model-used",
		mutation: "synthetic OS isolation qualification",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		commits: [],
		changedFiles: [],
		protectedPathViolations: [],
	}
	const probePaths = [hostCanary, path.join(repoRoot, ".git", "config"), controlCanary, evaluatorPath, scoringPath, archiveCanary]
	const protectedFileDigests = new Map(await Promise.all(probePaths.map(async (file) => [file, sha256(await fs.readFile(file))] as const)))
	const probeScript = `import fs from 'node:fs';\n` +
		`const paths = ${JSON.stringify(probePaths)};\n` +
		`const errorCode = (error) => typeof error?.code === 'string' ? error.code : (error?.name ?? 'unknown');\n` +
		`const results = paths.map((file) => { let readError = null, writeError = null; try { fs.readFileSync(file); } catch (error) { readError = errorCode(error); } try { fs.appendFileSync(file, 'tampered-by-disposable-canary\\n'); } catch (error) { writeError = errorCode(error); } return { path: file, readDenied: readError !== null, readError, writeDenied: writeError !== null, writeError }; });\n` +
		`let workspaceWritable = false; try { fs.writeFileSync('/workspace/.rsi-security-canary', 'workspace-only\\n', { flag: 'wx' }); workspaceWritable = true; } catch {}\n` +
		`const protectedSnapshotOmitted = { evaluator: !fs.existsSync('/workspace/src/rsi/evaluator-canary.ts'), scoring: !fs.existsSync('/workspace/scripts/eval-suite/score-canary.ts'), archive: !fs.existsSync('/workspace/.headlesscode/rsi-archive/archive-canary.json') };\n` +
		`console.log('HEADLESSCODE_RSI_CONTAINMENT_PROBE:' + JSON.stringify({ workspaceWritable, results, protectedSnapshotOmitted }));\n`
	const result = await runOpenShellBenchmarkVerifier(candidate, parsed.config, Buffer.from(probeScript), "security-canary", undefined, evaluatorRuntime.imageDigest, evaluatorRuntime.policySha256)
	report.providerTeardownCompleted = true
	const marker = /(?:^|\n)HEADLESSCODE_RSI_CONTAINMENT_PROBE:(\{[^\n]+\})(?:\n|$)/.exec(result.stdout + result.stderr)
	if (!marker) throw new Error("OpenShell guest did not return a containment probe report")
	const probe = JSON.parse(marker[1]!) as { workspaceWritable: boolean; results: Array<{ path: string; readDenied: boolean; readError: string | null; writeDenied: boolean; writeError: string | null }>; protectedSnapshotOmitted: Record<string, boolean> }
	const protectedCanariesUnchanged = await Promise.all([...protectedFileDigests].map(async ([file, digest]) => sha256(await fs.readFile(file)) === digest))
	let remainingSnapshots: string[] = []
	try {
		remainingSnapshots = await fs.readdir(path.join(repoRoot, ".worktrees"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	const guestSnapshotsRemoved = remainingSnapshots.length === 0
	const exactProbePaths = probe.results.length === probePaths.length && probe.results.every((entry, index) => entry.path === probePaths[index])
	const strictDeniedResults = probe.results.every((entry) =>
		entry.readDenied === true && typeof entry.readError === "string" &&
		entry.writeDenied === true && typeof entry.writeError === "string")
	const exactSnapshotOmissions = Object.keys(probe.protectedSnapshotOmitted).sort().join(",") === "archive,evaluator,scoring" &&
		probe.protectedSnapshotOmitted.archive === true && probe.protectedSnapshotOmitted.evaluator === true && probe.protectedSnapshotOmitted.scoring === true
	report = {
		...report,
		guestExitCode: result.exitCode,
		guestDurationMs: result.durationMs,
		workspaceWritable: probe.workspaceWritable,
		protectedPaths: probe.results,
		probePathsMatchExpected: exactProbePaths,
		protectedCanariesUnchanged: protectedCanariesUnchanged.every(Boolean),
		protectedSnapshotOmitted: probe.protectedSnapshotOmitted,
		protectedSnapshotOmissionsMatchExpected: exactSnapshotOmissions,
		guestSnapshotsRemoved,
	}
	const passed = result.exitCode === 0 && probe.workspaceWritable === true && report.protectedCanariesUnchanged === true &&
		exactProbePaths && strictDeniedResults && exactSnapshotOmissions && guestSnapshotsRemoved
	Object.assign(report, { passed, reportPath })
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
	if (!passed) process.exitCode = 1
}

try {
	await main()
} catch (error) {
	Object.assign(report, { passed: false, failure: error instanceof Error ? error.message : String(error), reportPath })
	process.stderr.write(`${JSON.stringify(report, null, 2)}\n`)
	process.exitCode = 1
} finally {
	await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
	if (report.providerTeardownCompleted === true) await fs.rm(runRoot, { recursive: true, force: true })
	else process.stderr.write(`Unverified teardown: synthetic fixture retained at ${runRoot}\n`)
}
