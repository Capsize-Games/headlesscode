import * as fsSync from "node:fs"
import * as os from "node:os"
import { spawnSync } from "node:child_process"

const DOCKER_SOCKET = "unix:///var/run/docker.sock"

export function assertNoActiveCurlWorktrees(root: string): void {
	try {
		const info = fsSync.lstatSync(root)
		const wrongOwner = typeof process.getuid === "function" &&
			info.uid !== process.getuid()
		const privateRoot = info.isDirectory() && !info.isSymbolicLink() &&
			!(info.mode & 0o077) && !wrongOwner
		if (!privateRoot) throw new Error("Curl worktree root is not owner-only")
		const active = fsSync.readdirSync(root).some(
			(name) => name.startsWith("curl-campaign-"),
		)
		if (active) throw new Error("Curl campaign worktree remains")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
}

export function listOpenShellSandboxes(): string[] {
	const result = spawnSync("docker", ["--host", DOCKER_SOCKET, "ps", "-q",
		"--no-trunc", "--filter", "label=openshell.ai/isolation-role=sandbox"], {
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 256 * 1024,
		env: {
			HOME: os.homedir(),
			PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		},
	})
	if (result.error || result.status !== 0) {
		throw new Error("could not verify OpenShell sandboxes")
	}
	const ids = (result.stdout ?? "").split(/\r?\n/).filter(Boolean)
	if (ids.length > 200 || ids.some((id) => !/^[a-f0-9]{64}$/i.test(id))) {
		throw new Error("OpenShell sandbox list is invalid")
	}
	return ids
}
