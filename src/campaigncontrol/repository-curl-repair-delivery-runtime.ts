import { execFile } from "node:child_process"
import * as os from "node:os"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const GITHUB_CLI = "/usr/bin/gh"
const GIT_CLI = "/usr/bin/git"

export type FixedDeliveryOperation =
	| "gh-repo-view"
	| "gh-list-pull-requests"
	| "gh-create-draft"
	| "git-clone-target"
	| "git-fetch-target-branch"
	| "git-fetch-candidate"
	| "git-verify-reference-origin"
	| "git-verify-reference-tip"
	| "git-verify-reference-tree"
	| "git-read-reference-alternates"
	| "git-verify-clone-origin"
	| "git-verify-clone-branch"
	| "git-read-target-revision"
	| "git-read-target-tree"
	| "git-read-source-changes"
	| "git-check-candidate-tree"
	| "git-check-candidate-ancestry"
	| "git-ls-remote-branch"
	| "git-read-origin"
	| "git-read-current-default-branch"
	| "git-push-candidate"

/** Use the validated owner bus without inherited credentials. */
export function fixedCurlDeliveryGitHubEnvironment(
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	void source
	return environmentWithOwnerSession(baseEnvironment())
}

function baseEnvironment(): NodeJS.ProcessEnv {
	return {
		PATH: "/usr/local/bin:/usr/bin:/bin",
		HOME: os.homedir(),
	}
}

function environmentWithOwnerSession(
	env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const uid = typeof process.getuid === "function" ? process.getuid() : -1
	const session = uid >= 0 ? resolveOwnerSessionBus(uid) : null
	if (session) {
		env.DBUS_SESSION_BUS_ADDRESS = session.address
		env.XDG_RUNTIME_DIR = session.runtimeDir
	}
	return env
}

import {
	resolveOwnerSessionBus,
	isPrivateOwnerDirectory,
} from "./repository-curl-repair-delivery-owner-session.js"
export { isPrivateOwnerDirectory }

export async function runGitHub(
	operation: FixedDeliveryOperation,
	args: string[],
	timeoutMs = 30_000,
): Promise<string> {
	return executeOutput(GITHUB_CLI, operation, args, timeoutMs)
}

export async function run(
	operation: FixedDeliveryOperation,
	args: string[],
	timeoutMs = 30_000,
): Promise<string> {
	return executeOutput(GIT_CLI, operation, args, timeoutMs)
}

async function executeOutput(
	command: string,
	operation: FixedDeliveryOperation,
	args: string[],
	timeoutMs: number,
): Promise<string> {
	try {
		const { stdout } = await execFileAsync(command, args, {
			timeout: timeoutMs,
			maxBuffer: 256 * 1024,
			encoding: "utf8",
			env: fixedCurlDeliveryGitHubEnvironment(),
		})
		return stdout
	} catch {
		throw new Error(`fixed Curl delivery command failed (${operation})`)
	}
}

export async function runStatus(
	operation: FixedDeliveryOperation,
	args: string[],
	timeoutMs = 30_000,
): Promise<number> {
	return statusCode(operation, GIT_CLI, args, timeoutMs)
}

async function statusCode(
	operation: FixedDeliveryOperation,
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<number> {
	try {
		await executeStatus(command, args, timeoutMs)
		return 0
	} catch (error) {
		return statusFailure(error, operation)
	}
}

async function executeStatus(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<void> {
	await execFileAsync(command, args, {
		timeout: timeoutMs,
		maxBuffer: 256 * 1024,
		encoding: "utf8",
		env: fixedCurlDeliveryGitHubEnvironment(),
	})
}

function statusFailure(
	error: unknown,
	operation: FixedDeliveryOperation,
): number {
	const code: unknown = (error as NodeJS.ErrnoException).code
	if (typeof code === "number") return code
	throw new Error(`fixed Curl delivery command unavailable (${operation})`)
}

export async function gitValue(
	operation: FixedDeliveryOperation,
	root: string,
	...args: string[]
): Promise<string> {
	return (await run(operation, ["-C", root, ...args])).trim()
}
