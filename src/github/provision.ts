/**
 * Repo provisioning: installation + repo → a real local clone.
 *
 * `provisionRepo()` gets a fresh installation access token (via
 * src/github/app-auth.ts), constructs GitHub's documented authenticated clone
 * URL for App installation tokens
 * (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation:
 * `git clone https://x-access-token:TOKEN@github.com/owner/repo.git`), clones
 * into `targetDir`, then REWRITES the remote to a plain token-free
 * `https://github.com/owner/repo.git` so the token never lingers in
 * `.git/config`. The resulting path is exactly what the rest of headlesscode
 * expects as a `--workspace` value — no downstream changes needed.
 *
 * The token never touches disk beyond the transient clone URL (and even that
 * is scrubbed immediately after): it is never written to the cloned repo's
 * config, never logged, never persisted.
 */

import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { promisify } from "node:util"

const execFileP = promisify(execFile)

export interface ProvisionOptions {
	installationId: number | string
	owner: string
	repo: string
	/** Local directory to clone into. Created if missing; must be empty if it exists. */
	targetDir: string
	/** The function that supplies a fresh installation access token. */
	getToken: () => Promise<string>
	/** Optional explicit git binary (tests). Defaults to "git" on PATH. */
	gitBin?: string
}

export class ProvisionError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "ProvisionError"
	}
}

function isDirEmpty(dir: string): boolean {
	return fs.readdirSync(dir).length === 0
}

/**
 * Clone <owner>/<repo> into <targetDir> using a fresh installation token, then
 * strip the token out of the clone's remote URL. Returns the absolute local
 * path, ready for use as a `--workspace` value.
 */
export async function provisionRepo(options: ProvisionOptions): Promise<string> {
	const { installationId, owner, repo, targetDir, getToken, gitBin = "git" } = options
	if (!owner || !repo) {
		throw new ProvisionError("provisionRepo: owner and repo are required")
	}
	if (!targetDir) {
		throw new ProvisionError("provisionRepo: targetDir is required")
	}

	const target = path.resolve(targetDir)

	// Refuse to silently overwrite: the target must be missing, or an existing
	// EMPTY directory (a stray empty dir is fine to clone into).
	if (fs.existsSync(target)) {
		if (!fs.statSync(target).isDirectory()) {
			throw new ProvisionError(`provisionRepo: target exists and is not a directory: ${target}`)
		}
		if (!isDirEmpty(target)) {
			throw new ProvisionError(`provisionRepo: target directory is not empty: ${target}`)
		}
	} else {
		fs.mkdirSync(target, { recursive: true })
	}

	const token = await getToken()
	if (!token) {
		throw new ProvisionError("provisionRepo: no installation token provided")
	}

	// GitHub's documented pattern for App installation tokens:
	//   git clone https://x-access-token:<token>@github.com/<owner>/<repo>.git
	const authenticatedUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
	const cleanUrl = `https://github.com/${owner}/${repo}.git`

	try {
		await execFileP(gitBin, ["clone", "--quiet", authenticatedUrl, target], { timeout: 120_000 })
	} catch (err) {
		throw new ProvisionError(
			`provisionRepo: git clone failed for ${owner}/${repo}: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		)
	}

	// Security: rewrite the remote to a plain URL immediately, so the token
	// does not linger in <target>/.git/config for the life of the clone.
	try {
		await execFileP(gitBin, ["-C", target, "remote", "set-url", "origin", cleanUrl], { timeout: 30_000 })
	} catch (err) {
		throw new ProvisionError(
			`provisionRepo: clone succeeded but failed to strip the token from the remote URL: ${
				err instanceof Error ? err.message : String(err)
			}`,
			{ cause: err },
		)
	}

	return target
}

/** Read the clone's origin URL (exported so the security test can assert on
 * the ACTUAL .git/config contents, not on our own assumptions). */
export async function readOriginUrl(repoDir: string, gitBin = "git"): Promise<string> {
	const { stdout } = await execFileP(gitBin, ["-C", repoDir, "remote", "get-url", "origin"])
	return stdout.trim()
}
