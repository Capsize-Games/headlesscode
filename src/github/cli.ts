/**
 * GitHub App CLI subcommands — `headlesscode provision` and
 * `headlesscode push-pr`.
 *
 *   npx tsx src/cli.ts provision --installation-id <id> --owner <o> --repo <r> --target <dir>
 *   npx tsx src/cli.ts push-pr --installation-id <id> --owner <o> --repo <r> \
 *     --local-dir <path> --branch <name> --title <title> --body <text> [--base <branch>]
 *
 * `provision` is the read half: gets a fresh installation access token (from
 * GITHUB_APP_ID + the App private key), clones the repo into --target, strips
 * the token from the remote URL, and prints the resulting local path — ready
 * to be used as a `--workspace` value. Also `--list-repos <installation-id>`.
 *
 * `push-pr` is the write half: pushes a local branch to the repo with the
 * same installation token (token scrubbed from .git/config immediately), then
 * opens a PR from it — never to the repo's default branch, never auto-merged.
 *
 * Thin dispatch to src/github/ — no logic duplicated here. Exit codes match
 * the project convention: 0 success, 1 runtime failure, 2 usage/config error.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { createAppAuthClient } from "./app-auth.js"
import { listInstallationRepos } from "./installations.js"
import { getRepoDefaultBranch, openPullRequest } from "./pr.js"
import { provisionRepo } from "./provision.js"
import { pushBranch } from "./push.js"

const PROVISION_USAGE = `headlesscode provision — GitHub App repo provisioning

Usage:
  headlesscode provision --installation-id <id> --owner <o> --repo <r> --target <dir>
      Clone <owner>/<repo> into <dir> using a GitHub App installation access
      token, strip the token from the clone's remote URL, and print the
      resulting local path (usable as a --workspace value).
  headlesscode provision --list-repos <installation-id>
      List the repositories this installation can access
      ({owner, name, fullName, defaultBranch} lines) — the primitive a
      future "choose a project" UI would call.

Options:
  --installation-id <id>  GitHub App installation ID (required for clone; also
                          the argument to --list-repos)
  --owner <o>             Repo owner (required for clone)
  --repo <r>              Repo name (required for clone)
  --target <dir>          Local directory to clone into (created if missing;
                          must be empty if it exists)
  --list-repos <id>       List repos accessible to installation <id> instead of cloning
  --help                  Show this help and exit

Environment:
  GITHUB_APP_ID                   GitHub App numeric ID (required; see docs/github-app-setup.md)
  GITHUB_APP_PRIVATE_KEY          The App's private key PEM text (required; never logged)
  GITHUB_APP_PRIVATE_KEY_PATH     Alternative: path to a .pem private key file
  GITHUB_API_BASE_URL             API base URL override (tests/mocks)
`

interface ProvisionCliOptions {
	installationId?: string
	owner?: string
	repo?: string
	target?: string
	listRepos?: string
	help: boolean
}

export function parseProvisionArgs(argv: string[]): { options: ProvisionCliOptions; error?: string } {
	const options: ProvisionCliOptions = { help: false }
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		const eq = arg.indexOf("=")
		const flag = eq === -1 ? arg : arg.slice(0, eq)
		const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
		const next = (): string | undefined => {
			if (inlineValue !== undefined) {
				return inlineValue
			}
			const v = argv[i + 1]
			if (v === undefined || v.startsWith("--")) {
				return undefined
			}
			i++
			return v
		}

		switch (flag) {
			case "--installation-id":
			case "--owner":
			case "--repo":
			case "--target":
			case "--list-repos": {
				const value = next()
				if (value === undefined) {
					return { options, error: `Missing value for ${flag}` }
				}
				if (flag === "--installation-id") {
					options.installationId = value
				} else if (flag === "--owner") {
					options.owner = value
				} else if (flag === "--repo") {
					options.repo = value
				} else if (flag === "--target") {
					options.target = value
				} else {
					options.listRepos = value
				}
				break
			}
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown provision argument: ${arg}` }
		}
	}
	return { options }
}

/** Load App credentials from env ($GITHUB_APP_ID + private key or key path). */
function appCredentialsFromEnv(): { appId: string; privateKey: string } {
	const appId = process.env.GITHUB_APP_ID
	if (!appId) {
		throw new Error("GITHUB_APP_ID is not set (see docs/github-app-setup.md)")
	}
	const inline = process.env.GITHUB_APP_PRIVATE_KEY
	if (inline) {
		return { appId, privateKey: inline }
	}
	const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH
	if (!keyPath) {
		throw new Error(
			"no App private key: set GITHUB_APP_PRIVATE_KEY (PEM text) or GITHUB_APP_PRIVATE_KEY_PATH (.pem file path)",
		)
	}
	try {
		return { appId, privateKey: fs.readFileSync(path.resolve(keyPath), "utf-8") }
	} catch (err) {
		throw new Error(`cannot read GITHUB_APP_PRIVATE_KEY_PATH '${keyPath}': ${err instanceof Error ? err.message : String(err)}`)
	}
}

/** Shared client builder for both sub-modes (keeps env + DI in one place). */
export function buildProvisionClient(): ReturnType<typeof createAppAuthClient> {
	const { appId, privateKey } = appCredentialsFromEnv()
	return createAppAuthClient({
		appId,
		privateKey,
		...(process.env.GITHUB_API_BASE_URL ? { baseUrl: process.env.GITHUB_API_BASE_URL } : {}),
	})
}

export async function provisionMain(argv: string[]): Promise<number> {
	const { options, error } = parseProvisionArgs(argv)
	if (error) {
		process.stderr.write(`headlesscode provision: ${error}\n\n${PROVISION_USAGE}`)
		return 2
	}
	if (options.help) {
		process.stdout.write(PROVISION_USAGE)
		return 0
	}
	if (options.listRepos) {
		let client
		try {
			client = buildProvisionClient()
		} catch (err) {
			process.stderr.write(`headlesscode provision: ${err instanceof Error ? err.message : String(err)}\n`)
			return 2
		}
		try {
			const repos = await listInstallationRepos(options.listRepos, {
				getToken: () => client.getInstallationToken(options.listRepos!),
				...(process.env.GITHUB_API_BASE_URL ? { baseUrl: process.env.GITHUB_API_BASE_URL } : {}),
			})
			for (const repo of repos) {
				process.stdout.write(`${repo.fullName}\t${repo.owner}\t${repo.name}\t${repo.defaultBranch}\n`)
			}
			process.stdout.write(`[provision] ${repos.length} repo(s) accessible to installation ${options.listRepos}\n`)
			return 0
		} catch (err) {
			process.stderr.write(`headlesscode provision: ${err instanceof Error ? err.message : String(err)}\n`)
			return 1
		}
	}

	if (!options.installationId || !options.owner || !options.repo || !options.target) {
		process.stderr.write(
			`headlesscode provision: --installation-id, --owner, --repo and --target are required\n\n${PROVISION_USAGE}`,
		)
		return 2
	}

	let client
	try {
		client = buildProvisionClient()
	} catch (err) {
		process.stderr.write(`headlesscode provision: ${err instanceof Error ? err.message : String(err)}\n`)
		return 2
	}

	try {
		const localPath = await provisionRepo({
			installationId: options.installationId,
			owner: options.owner,
			repo: options.repo,
			targetDir: options.target,
			getToken: () => client.getInstallationToken(options.installationId!),
		})
		process.stdout.write(`${localPath}\n`)
		return 0
	} catch (err) {
		process.stderr.write(`headlesscode provision: ${err instanceof Error ? err.message : String(err)}\n`)
		return 1
	}
}

const PUSH_PR_USAGE = `headlesscode push-pr — push a branch + open a pull request

Usage:
	 headlesscode push-pr --installation-id <id> --owner <o> --repo <r> \\
	   --local-dir <path> --branch <name> --title <title> --body <text> [--base <branch>]
	     Push the local <branch> (the current HEAD of <local-dir>, which must
	     already have the work committed) to <owner>/<repo> using a GitHub App
	     installation access token, then open a pull request from <branch> into
	     --base (default: the repo's ACTUAL default branch, resolved from the
	     repo API — never hardcoded). Prints "#<n>: <url>".
	     The token is scrubbed from the origin URL immediately after the push
	     (it never persists in .git/config) and push-pr NEVER pushes to the
	     repo's default branch — opening the PR is the whole deliverable,
	     merging is a human's job.

Options:
	 --installation-id <id>  GitHub App installation ID (required)
	 --owner <o>             Repo owner (required)
	 --repo <r>              Repo name (required)
	 --local-dir <path>      Local repo to push from (required; work committed)
	 --branch <name>         Branch to push + open the PR from. Must NOT be the
	                         repo's default branch (required)
	 --title <text>          PR title (required)
	 --body <text>           PR body (required)
	 --base <branch>         PR target branch (default: the repo's default branch)
	 --help                  Show this help and exit

Environment:
	 GITHUB_APP_ID                   GitHub App numeric ID (required; see docs/github-app-setup.md)
	 GITHUB_APP_PRIVATE_KEY          The App's private key PEM text (required; never logged)
	 GITHUB_APP_PRIVATE_KEY_PATH     Alternative: path to a .pem private key file
	 GITHUB_API_BASE_URL             API base URL override (tests/mocks)
`

interface PushPrCliOptions {
	installationId?: string
	owner?: string
	repo?: string
	localDir?: string
	branch?: string
	title?: string
	body?: string
	base?: string
	help: boolean
}

export function parsePushPrArgs(argv: string[]): { options: PushPrCliOptions; error?: string } {
	const options: PushPrCliOptions = { help: false }
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		const eq = arg.indexOf("=")
		const flag = eq === -1 ? arg : arg.slice(0, eq)
		const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
		const next = (): string | undefined => {
			if (inlineValue !== undefined) {
				return inlineValue
			}
			const v = argv[i + 1]
			if (v === undefined || v.startsWith("--")) {
				return undefined
			}
			i++
			return v
		}

		switch (flag) {
			case "--installation-id":
			case "--owner":
			case "--repo":
			case "--local-dir":
			case "--branch":
			case "--title":
			case "--body":
			case "--base": {
				const value = next()
				if (value === undefined) {
					return { options, error: `Missing value for ${flag}` }
				}
				switch (flag) {
					case "--installation-id":
						options.installationId = value
						break
					case "--owner":
						options.owner = value
						break
					case "--repo":
						options.repo = value
						break
					case "--local-dir":
						options.localDir = value
						break
					case "--branch":
						options.branch = value
						break
					case "--title":
						options.title = value
						break
					case "--body":
						options.body = value
						break
					case "--base":
						options.base = value
						break
				}
				break
			}
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown push-pr argument: ${arg}` }
		}
	}
	return { options }
}

/** Injectable seams for pushPrMain (tests); defaults are the real modules. */
export interface PushPrDeps {
	buildClient?: () => ReturnType<typeof createAppAuthClient>
	pushBranch?: typeof pushBranch
	openPullRequest?: typeof openPullRequest
	getRepoDefaultBranch?: typeof getRepoDefaultBranch
	stdout?: (text: string) => void
	stderr?: (text: string) => void
}

export async function pushPrMain(argv: string[], deps: PushPrDeps = {}): Promise<number> {
	const buildClient = deps.buildClient ?? buildProvisionClient
	const push = deps.pushBranch ?? pushBranch
	const openPr = deps.openPullRequest ?? openPullRequest
	const repoDefaultBranch = deps.getRepoDefaultBranch ?? getRepoDefaultBranch
	const out = deps.stdout ?? ((text: string) => process.stdout.write(text))
	const errOut = deps.stderr ?? ((text: string) => process.stderr.write(text))

	const { options, error } = parsePushPrArgs(argv)
	if (error) {
		errOut(`headlesscode push-pr: ${error}\n\n${PUSH_PR_USAGE}`)
		return 2
	}
	if (options.help) {
		out(PUSH_PR_USAGE)
		return 0
	}
	if (
		!options.installationId ||
		!options.owner ||
		!options.repo ||
		!options.localDir ||
		!options.branch ||
		options.title === undefined ||
		options.body === undefined
	) {
		errOut(
			`headlesscode push-pr: --installation-id, --owner, --repo, --local-dir, --branch, ` +
				`--title and --body are required\n\n${PUSH_PR_USAGE}`,
		)
		return 2
	}

	let client
	try {
		client = buildClient()
	} catch (err) {
		errOut(`headlesscode push-pr: ${err instanceof Error ? err.message : String(err)}\n`)
		return 2
	}
	const getToken = () => client.getInstallationToken(options.installationId!)

	// Resolve the PR target branch UP FRONT (the repo's real default branch
	// unless --base is given) so the hard rule can be enforced BEFORE pushing:
	// push-pr never pushes to the repo's default branch.
	let base: string
	try {
		base =
			options.base ??
			(await repoDefaultBranch({
				owner: options.owner!,
				repo: options.repo!,
				getToken,
				...(process.env.GITHUB_API_BASE_URL ? { baseUrl: process.env.GITHUB_API_BASE_URL } : {}),
			}))
	} catch (err) {
		errOut(`headlesscode push-pr: ${err instanceof Error ? err.message : String(err)}\n`)
		return 1
	}
	if (base === options.branch) {
		errOut(
			`headlesscode push-pr: refusing to push '${options.branch}' — it IS the repo's default branch. ` +
				`push-pr never pushes to the default branch; use a feature branch name.\n`,
		)
		return 2
	}

	try {
		await push({
			installationId: options.installationId,
			owner: options.owner!,
			repo: options.repo!,
			localDir: options.localDir!,
			branchName: options.branch!,
			getToken,
		})
	} catch (err) {
		errOut(`headlesscode push-pr: ${err instanceof Error ? err.message : String(err)}\n`)
		return 1
	}

	let pr
	try {
		pr = await openPr({
			installationId: options.installationId,
			owner: options.owner!,
			repo: options.repo!,
			head: options.branch!,
			base,
			title: options.title!,
			body: options.body!,
			getToken,
			...(process.env.GITHUB_API_BASE_URL ? { baseUrl: process.env.GITHUB_API_BASE_URL } : {}),
		})
	} catch (err) {
		errOut(`headlesscode push-pr: ${err instanceof Error ? err.message : String(err)}\n`)
		return 1
	}

	out(`PR #${pr.number}: ${pr.url}\n`)
	return 0
}
