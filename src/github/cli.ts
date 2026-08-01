/**
 * `headlesscode provision` subcommand — GitHub App repo provisioning.
 *
 *   npx tsx src/cli.ts provision --installation-id <id> --owner <o> --repo <r> --target <dir>
 *
 * The manual/scriptable entry point for "give me this repo, right now": gets
 * a fresh installation access token (from GITHUB_APP_ID + the App private
 * key), clones the repo into --target, strips the token from the remote URL,
 * and prints the resulting local path — ready to be used as a `--workspace`
 * value for an orchestrate round, a single session, etc.
 *
 * Also `--list-repos <installation-id>`: list the repositories the
 * installation can access (what a future "choose a project" UI would call).
 *
 * Thin dispatch to src/github/ — no logic duplicated here. Exit codes match
 * the project convention: 0 success, 1 runtime failure, 2 usage/config error.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { createAppAuthClient } from "./app-auth.js"
import { listInstallationRepos } from "./installations.js"
import { provisionRepo } from "./provision.js"

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
