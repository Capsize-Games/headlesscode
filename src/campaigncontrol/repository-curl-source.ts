import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID, createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { CURL_PRIVATE_SOURCE_REVISION, CURL_CANDIDATE_TREE_SHA, CURL_PROFILE_ID,
	CURL_FIXED_ADVISORY } from "./repository-curl-evaluator.js"
import type { VettedAdvisorySnapshot } from "./repository-worker.js"

const execFileAsync = promisify(execFile)

export async function createPinnedWorktree(repoRoot: string): Promise<string> {
	const realRepo = await fs.promises.realpath(repoRoot)
	const worktreeRoot = path.join(realRepo, ".worktrees")
	await validateWorktreeRoots(realRepo, worktreeRoot)
	const id = randomUUID()
	const name = `curl-campaign-${id}`
	const worktree = path.join(worktreeRoot, name)
	await gitText(realRepo, ["-C", realRepo, "worktree", "add", "-b",
		`headlesscode/${name}`, worktree, CURL_PRIVATE_SOURCE_REVISION])
	return worktree
}

async function validateWorktreeRoots(
	repository: string,
	worktreeRoot: string,
): Promise<void> {
	const repoStat = await fs.promises.lstat(repository)
	if (!repoStat.isDirectory() || repoStat.isSymbolicLink()) {
		throw new Error("fixed private Curl source is unavailable")
	}
	await fs.promises.mkdir(worktreeRoot, { recursive: true, mode: 0o700 })
	const rootStat = await fs.promises.lstat(worktreeRoot)
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
		(rootStat.mode & 0o077) !== 0 || !ownedByCurrentUser(rootStat.uid)) {
		throw new Error("Curl private worktree root must be owner-only")
	}
}

function ownedByCurrentUser(uid: number): boolean {
	return typeof process.getuid !== "function" || uid === process.getuid()
}

export async function removeOwnedWorktree(repoRoot: string,
	worktree: string): Promise<void> {
	const root = path.resolve(repoRoot)
	const candidate = path.resolve(worktree)
	if (path.dirname(candidate) !== path.join(root,
		".worktrees") || !path.basename(candidate).startsWith("curl-campaign-")) {
		throw new Error("refusing to remove an unowned Curl worktree")
	}
	await gitText(root, ["-C", root, "worktree", "remove", "--force", candidate])
	await gitText(root, ["-C", root, "branch", "-D",
		`headlesscode/${path.basename(candidate)}`])
}

export async function removeTaskFile(worktree: string,
	expectedSha256: string): Promise<void> {
	const target = path.join(worktree, "ORCHESTRATOR_TASK.md")
	const info = await fs.promises.lstat(target)
	if (!info.isFile() || info.isSymbolicLink() ||
		sha256(await fs.promises.readFile(target)) !== expectedSha256) {
		throw new Error("Curl worker task file identity changed")
	}
	await fs.promises.unlink(target)
}

export async function gitText(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, timeout: 30_000,
		maxBuffer: 64 * 1024 })
	if (typeof stdout !== "string" ||
		stdout.length > 4096) throw new
			Error("fixed Curl Git operation returned an invalid response")
	return stdout.trim()
}

export function validateAdvisory(value: VettedAdvisorySnapshot): void {
	assertFixedAdvisoryIdentity(value)
	assertAdvisoryMetadataBounds(value)
	assertAdvisoryProfile(value)
}

function assertFixedAdvisoryIdentity(value: VettedAdvisorySnapshot): void {
	if (!value || value.advisoryId !== CURL_FIXED_ADVISORY ||
		value.sourceUrl !==
			`https://security-tracker.debian.org/tracker/${CURL_FIXED_ADVISORY}`) {
		throw new
			Error("vetted Debian advisory metadata is outside the fixed Curl profile")
	}
}

function assertAdvisoryMetadataBounds(value: VettedAdvisorySnapshot): void {
	if (!/^[a-f0-9]{64}$/.test(value.snapshotSha256) ||
		typeof value.summary !== "string" ||
		value.summary.length > 1200 || typeof value.affectedRange !== "string" ||
		value.affectedRange.length > 400 || value.fixedVersion !== null) {
		throw new
			Error("vetted Debian advisory metadata is outside the fixed Curl profile")
	}
}

function assertAdvisoryProfile(value: VettedAdvisorySnapshot): void {
	if (!Array.isArray(value.verificationCheckIds) ||
		value.verificationCheckIds.length !== 1 ||
		value.verificationCheckIds[0] !== CURL_PROFILE_ID) {
		throw new
			Error("vetted Debian advisory metadata is outside the fixed Curl profile")
	}
}

export function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex")
}
