/**
 * Repo push-back: push a local branch to GitHub using the installation token.
 *
 * `pushBranch()` is the write half of repo provisioning: it gets a fresh
 * installation access token (same `getToken` shape as `provisionRepo` in
 * src/github/provision.ts), pushes the local HEAD to an explicitly NAMED
 * branch on <owner>/<repo>, and strips the token out of the repo's origin URL
 * before returning.
 *
 * Token discipline matches provision.ts exactly: the token only ever appears
 * inside a transient `https://x-access-token:<token>@github.com/...` URL. The
 * push is done via `git remote set-url origin <auth-url>` → `git push origin
 * HEAD:<branch>` → `git remote set-url origin <original>` in a `finally`, so
 * the token never persists in `.git/config` past this call — even when the
 * push itself fails. The ORIGINAL origin URL is captured first and restored
 * verbatim (for a provisioned repo that is the token-free
 * `https://github.com/<owner>/<repo>.git`, but whatever it was, it ends up
 * exactly as it started).
 *
 * Never pushes to a repo's default branch: the refspec is always the explicit
 * `HEAD:<branchName>` — there is no code path that pushes to an implicit
 * upstream/default branch. The CLI layer additionally refuses
 * `--branch == --base` (see src/github/cli.ts).
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileP = promisify(execFile)

export interface PushOptions {
	installationId: number | string
	owner: string
	repo: string
	/** Local repo path to push from (already has the work committed). */
	localDir: string
	/** Branch name to push to on the remote (created if it doesn't exist). */
	branchName: string
	/** The function that supplies a fresh installation access token. */
	getToken: () => Promise<string>
	/** Optional explicit git binary (tests). Defaults to "git" on PATH. */
	gitBin?: string
}

export class PushError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "PushError"
	}
}

/**
 * Push the current HEAD of <localDir> to <branchName> on <owner>/<repo>,
 * using a fresh installation token, then restore the origin URL to its
 * original token-free form. The token never persists past this call.
 */
export async function pushBranch(options: PushOptions): Promise<void> {
	const { owner, repo, localDir, branchName, getToken, gitBin = "git" } = options
	if (!owner || !repo) {
		throw new PushError("pushBranch: owner and repo are required")
	}
	if (!localDir) {
		throw new PushError("pushBranch: localDir is required")
	}
	if (!branchName) {
		throw new PushError("pushBranch: branchName is required")
	}

	const token = await getToken()
	if (!token) {
		throw new PushError("pushBranch: no installation token provided")
	}

	// GitHub's documented pattern for App installation tokens (same as
	// provision.ts): git push https://x-access-token:<token>@github.com/<owner>/<repo>.git
	const authenticatedUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`

	// Capture the CURRENT origin URL BEFORE touching anything. Whatever it is
	// (a provisioned repo's token-free clean URL, or anything else), it gets
	// restored verbatim after the push — so this call is a no-op on the
	// remote config except for the transient authenticated window inside it.
	let originalUrl: string
	try {
		const { stdout } = await execFileP(gitBin, ["-C", localDir, "remote", "get-url", "origin"], { timeout: 30_000 })
		originalUrl = stdout.trim()
	} catch (err) {
		throw new PushError(
			`pushBranch: cannot read the 'origin' remote URL in ${localDir}: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		)
	}

	try {
		await execFileP(gitBin, ["-C", localDir, "remote", "set-url", "origin", authenticatedUrl], { timeout: 30_000 })
		// Always an EXPLICIT named-branch refspec: `git push origin HEAD:<name>`
		// creates/updates exactly <name> on the remote and never touches the
		// repo's default branch (no bare `git push`, no upstream inference).
		await execFileP(gitBin, ["-C", localDir, "push", "origin", `HEAD:${branchName}`], { timeout: 120_000 })
	} catch (err) {
		throw new PushError(
			`pushBranch: git push ${owner}/${repo} failed for branch '${branchName}': ${
				err instanceof Error ? err.message : String(err)
			}`,
			{ cause: err },
		)
	} finally {
		// Security: strip the token out of .git/config IMMEDIATELY — including
		// on failure. If the restore itself fails, that is the one error we
		// cannot paper over (the token may be on disk), so it REPLACES any
		// push error.
		try {
			await execFileP(gitBin, ["-C", localDir, "remote", "set-url", "origin", originalUrl], { timeout: 30_000 })
		} catch (err) {
			throw new PushError(
				`pushBranch: failed to strip the token from the origin URL in ${localDir}/.git/config: ${
					err instanceof Error ? err.message : String(err)
				}`,
				{ cause: err },
			)
		}
	}
}
