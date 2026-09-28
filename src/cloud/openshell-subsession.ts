import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { mainRepositoryForWorktree, runOpenShellWorktreeCommand } from "./openshell-worker.js"
import { OPENSHELL_HARNESS_ROOT } from "./openshell-provider.js"

const SESSION_FILES_ROOT = "/workspace/.headlesscode-session"

export async function runOpenShellSubsession<T>(
	role: "review" | "qa",
	workspaceRoot: string,
	payload: Record<string, unknown>,
): Promise<T> {
	const workspace = path.resolve(workspaceRoot)
	const repo = mainRepositoryForWorktree(workspace)
	const sessionPayload = remapWorkspacePaths(payload, workspace)
	let stagedPromptDir: string | undefined
	if (role === "review" && typeof sessionPayload.reviewPromptPath === "string") {
		// Copy only the selected prompt file into the disposable session clone.
		stagedPromptDir = fs.mkdtempSync(path.join(os.tmpdir(), "headlesscode-openshell-review-"))
		try {
			fs.chmodSync(stagedPromptDir, 0o755)
			const stagedPrompt = path.join(stagedPromptDir, "review-prompt.md")
			fs.copyFileSync(String(sessionPayload.reviewPromptPath), stagedPrompt)
			fs.chmodSync(stagedPrompt, 0o644)
			sessionPayload.reviewPromptPath = `${SESSION_FILES_ROOT}/review-prompt.md`
		} catch (error) {
			fs.rmSync(stagedPromptDir, { recursive: true, force: true })
			throw error
		}
	}
	const encoded = Buffer.from(JSON.stringify(sessionPayload), "utf8").toString("base64url")
	const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
	const command = `cd ${quote(OPENSHELL_HARNESS_ROOT)} && ./node_modules/.bin/tsx src/cli.ts openshell-${role}-session ${quote(encoded)}`
	let cleanedUp = false
	try {
		const result = await runOpenShellWorktreeCommand(repo, workspace, command, {}, stagedPromptDir ? {
			readOnlyMounts: [{ source: stagedPromptDir, target: SESSION_FILES_ROOT }],
			importResults: false,
		} : { importResults: false })
		cleanedUp = true
		const line = result.output.split(/\r?\n/).reverse().find((item) => item.startsWith("HEADLESSCODE_RESULT_JSON:"))
		if (!line) throw new Error(`OpenShell ${role} session returned no result JSON (exit ${result.exitCode}): ${result.output}`)
		return JSON.parse(line.slice("HEADLESSCODE_RESULT_JSON:".length)) as T
	} finally {
		// If sandbox teardown failed, retain the mounted file for recovery. A
		// missing marker means validation failed before sandbox creation began.
		if (stagedPromptDir && (cleanedUp || !fs.existsSync(path.join(workspace, ".harness.openshell-sandbox")))) {
			fs.rmSync(stagedPromptDir, { recursive: true, force: true })
		}
	}
}

function remapWorkspacePaths(value: unknown, workspace: string): any {
	if (typeof value === "string") {
		if (value === workspace) return "/workspace"
		if (value.startsWith(`${workspace}${path.sep}`)) return `/workspace${value.slice(workspace.length).split(path.sep).join("/")}`
		return value
	}
	if (Array.isArray(value)) return value.map((item) => remapWorkspacePaths(item, workspace))
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapWorkspacePaths(item, workspace)]))
	return value
}
