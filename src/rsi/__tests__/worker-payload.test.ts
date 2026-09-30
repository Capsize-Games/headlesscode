import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import type { FleetJobPayload } from "../postgres-queue.js"
import { verifyWorkerHarnessPayload } from "../worker.js"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-rsi-worker-harness-payload-"))
try {
	execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root })
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root })
	execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root })
	fs.mkdirSync(path.join(root, "src", "engine"), { recursive: true })
	fs.writeFileSync(path.join(root, "src", "cli.ts"), "export {}\n")
	fs.writeFileSync(path.join(root, "src", "engine", "agent.ts"), "export const agent = true\n")
	execFileSync("git", ["add", "."], { cwd: root })
	execFileSync("git", ["commit", "--quiet", "-m", "sanitized snapshot"], { cwd: root })
	const parentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
	const tree = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], { cwd: root, encoding: "buffer" }) as Buffer
	const snapshotTreeDigest = createHash("sha256").update(tree).digest("hex")
	const payload = {
		schemaVersion: 1,
		snapshotSha256: "0".repeat(64),
		snapshotBytes: 1,
		snapshotCommit: parentCommit,
		task: "task",
		model: "model",
		maxIterations: 1,
		timeoutMs: 10_000,
		protectedPaths: [],
		candidate: { id: "candidate", generation: 1, parent: "parent", baseCommit: parentCommit },
		workerHarness: {
			runMode: "self-hosted",
			mode: "self-hosted",
			parentCommit,
			snapshotTreeDigest,
			runtime: {
				imageName: "headlesscode-openshell-rsi:release",
				imageDigest: "sha256:" + "a".repeat(64),
				harnessCommit: "b".repeat(40),
				dependencyLockDigest: "c".repeat(64),
			},
			executedCliPath: "/workspace/src/cli.ts",
		},
	} as unknown as FleetJobPayload
	assert.doesNotThrow(() => verifyWorkerHarnessPayload(payload, root))
	assert.throws(() => verifyWorkerHarnessPayload({ ...payload, candidate: { ...payload.candidate, baseCommit: "d".repeat(40) } }, root), /does not match its generation\/mode/)
	assert.throws(() => verifyWorkerHarnessPayload({ ...payload, candidate: { id: "candidate", parent: "parent", baseCommit: parentCommit } }, root), /does not match its generation\/mode/)
	assert.throws(() => verifyWorkerHarnessPayload({ ...payload, candidate: { ...payload.candidate, generation: -1 } }, root), /does not match its generation\/mode/)
} finally {
	fs.rmSync(root, { recursive: true, force: true })
}

console.log("RSI worker harness payload identity assertions passed")
