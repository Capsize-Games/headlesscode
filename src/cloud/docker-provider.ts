/**
 * DockerSessionProvider — a real `CloudProvider` implementation that runs each
 * harness session in its own isolated Docker container.
 *
 * WHY (see docs/multi-tenant-hosting-design.md §1 for the full comparison):
 * the multi-tenant security requirement — one tenant's session (buggy,
 * malicious, or just aggressive) must not be able to see, affect, or exhaust
 * resources for another tenant's session or the host — is not satisfied by
 * the local process model's directory-level separation. Docker gives us a
 * real kernel-enforced boundary per session:
 *
 *   - cgroup resource limits (CPU/memory/pids): a runaway session is
 *     throttled/oom-killed by the kernel, never able to starve the host or
 *     sibling sessions;
 *   - per-container network namespace with no published ports: a session's
 *     sockets are unreachable from the host and from other sessions;
 *   - non-root user (host uid:gid — no root inside the container) +
 *     read-only rootfs (tmpfs /tmp): reduces the blast radius of a
 *     compromised harness without needing a rootless daemon.
 *
 * The container runs the harness INSIDE the boundary — `runHarness` is
 * `docker exec`, not a host subprocess. `teardown` is `docker rm -f` and
 * VERIFIES the container is actually gone (a leaked container per session is
 * a real cost/security problem at scale — the test suite enumerates
 * containers before/after rather than trusting an exit code).
 *
 * The harness repo (this checkout, containing src/cli.ts + node_modules) is
 * mounted read-only at /harness; the target repo/worktree is mounted at
 * /workspace. No image build per session; the session's own writes land in
 * the workspace mount, so results survive container teardown. Secrets ride
 * in via `CloudSessionRequest.env` (per-session container env, never
 * written to disk/logs) — see the design doc §2.
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { writeTaskFiles } from "../orchestrator/cli.js"
import type { CloudProvider, CloudSessionRequest, CommandResult, SessionHandle } from "./provider.js"

/** The harness repo root (parent of src/cloud) — same pattern as the CLI. */
const HARNESS_ROOT = fileURLToPath(new URL("../..", import.meta.url))

export const DEFAULT_DOCKER_IMAGE = "node:22-bookworm-slim"

/** Default per-session CPU cap (fraction of a core, Docker `--cpus`). */
export const DEFAULT_DOCKER_CPUS = 2
/** Default per-session memory cap, MB (Docker `--memory`). */
export const DEFAULT_DOCKER_MEMORY_MB = 2048
/** Default per-session process cap (Docker `--pids-limit`). */
export const DEFAULT_DOCKER_PIDS_LIMIT = 512

export interface DockerSessionProviderOptions {
	/** Image to run the session in (default: node:22-bookworm-slim). */
	image?: string
	/** Per-session CPU cap (fraction of a core). */
	cpus?: number
	/** Per-session memory cap, MB. */
	memoryMb?: number
	/** Per-session process count cap. */
	pidsLimit?: number
	/** Container name prefix (default: "hcls"). */
	namePrefix?: string
	/**
	 * Injectable `docker` runner (tests). Returns { exitCode, output } exactly
	 * like the local provider's `run` seam; default shells out to the real
	 * `docker` binary.
	 */
	run?: (command: string) => CommandResult
	/** Injectable `docker inspect` result parser (tests): container state → readiness. */
	isReady?: (inspectJson: string) => boolean
	/** Injectable `docker ps -a` filter listing (tests): returns container names/lines. */
	listContainers?: () => string[]
}

/**
 * DockerSessionProvider — one isolated container per session behind the
 * existing `CloudProvider` interface. The orchestration layer calls the SAME
 * five methods it calls on LocalProcessProvider; only the execution boundary
 * changes (docs/multi-tenant-hosting-design.md §3).
 */
export class DockerSessionProvider implements CloudProvider {
	readonly name = "docker"
	private readonly image: string
	private readonly cpus: number
	private readonly memoryMb: number
	private readonly pidsLimit: number
	private readonly namePrefix: string
	private readonly run: (command: string) => CommandResult
	private readonly isReady: (inspectJson: string) => boolean
	private readonly listContainers: () => string[]

	constructor(options: DockerSessionProviderOptions = {}) {
		this.image = options.image ?? dockerEnv("HEADLESSCODE_DOCKER_IMAGE", DEFAULT_DOCKER_IMAGE)
		this.cpus = numberEnv("HEADLESSCODE_DOCKER_CPUS", options.cpus ?? DEFAULT_DOCKER_CPUS)
		this.memoryMb = numberEnv("HEADLESSCODE_DOCKER_MEMORY_MB", options.memoryMb ?? DEFAULT_DOCKER_MEMORY_MB)
		this.pidsLimit = numberEnv("HEADLESSCODE_DOCKER_PIDS_LIMIT", options.pidsLimit ?? DEFAULT_DOCKER_PIDS_LIMIT)
		this.namePrefix = options.namePrefix ?? "hcls"
		this.run =
			options.run ??
			((command) => {
				const res = spawnSync("sh", ["-c", command], {
					encoding: "utf-8",
					maxBuffer: 64 * 1024 * 1024,
				})
				const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim()
				return { exitCode: res.status ?? 1, output }
			})
		this.isReady = options.isReady ?? ((json) => {
			try {
				const parsed = JSON.parse(json) as Array<{ State?: { Running?: boolean } }>
				return parsed.length > 0 && parsed[0].State?.Running === true
			} catch {
				return false
			}
		})
		this.listContainers = options.listContainers ?? (() => {
			const res = this.run("docker ps -a --format '{{.Names}}'")
			if (res.exitCode !== 0) {
				return []
			}
			return res.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
		})
	}

	/** The container name for a handle (id is the session/worktree name). */
	containerName(handle: SessionHandle): string {
		return `${this.namePrefix}-${handle.id}`
	}

	/** The tenant workspace mount path (must match what spawnWorktreeSession used). */
	workspacePath(handle: SessionHandle): string {
		if (!handle.address) {
			throw new Error(`DockerSessionProvider: no workspace path on handle ${handle.id}`)
		}
		return handle.address
	}

	async spawnWorktreeSession(request: CloudSessionRequest): Promise<SessionHandle> {
		const { repo, issue, worktreeSpec } = request
		const wtPath = path.join(path.resolve(repo), ".worktrees", worktreeSpec.name)

		// 1. Task file under <repo>/plans/parallel-tasks/ — same builder the
		//    local provider / watcher use. The workspace mount carries it into
		//    the container as <workspace>/plans/parallel-tasks/<taskFile>.
		writeTaskFiles(path.resolve(repo), [worktreeSpec], [issue])

		// 2. Create + start the isolated container. Deliberately NO published
		//    ports (per-container network namespace; a session's sockets are
		//    unreachable from the host and from sibling sessions) and no
		//    --network host. Non-root user + read-only rootfs with tmpfs /tmp:
		//    the harness's own writes go to the workspace mount; everything
		//    else is immutable from inside the session.
		const name = this.containerName({ id: worktreeSpec.name, provider: this.name })
		// Two separate commands (newline-joined): a pre-clean of a stale
		// container from a crashed run, then `docker create` (NOT `docker run
		// -d ... tail -f /dev/null`). Using `docker run -d` with a
		// long-running container process attached the container's stdio to
		// OUR stdout pipe, which spawnSync never sees close (the container's
		// tail holds the fd) → the spawn call hangs. `docker create` returns
		// the id without executing; `docker start` detaches. Neither holds
		// our stdio.
		const envEntries = Object.entries(request.env ?? {}).filter(([k]) => k !== "TARGET_REPO")
		const envFlags = [
			`-e TARGET_REPO=/workspace`,
			...envEntries.map(([k, v]) => `-e ${k}=${v}`),
		]
		// The pre-clean and the `docker create` must be SEPARATE shell
		// statements (newline), but the docker flags themselves must be ONE
		// space-joined line — a newline between flags turns each flag into a
		// separate shell command (`docker create` alone with no args errors).
		// A space join between the pre-clean and create would parse as
		// `docker rm ... || true docker create ...` — `true` swallows the
		// create and the container is never made.
		const createFlags = [
			`docker create`,
			`--name ${name}`,
			`--cpus ${this.cpus}`,
			`--memory ${this.memoryMb}m`,
			`--memory-swap ${this.memoryMb}m`,
			`--pids-limit ${this.pidsLimit}`,
			// Run as the HOST uid:gid (not the image's `node` user): the
			// workspace is a host-owned bind mount, and the harness must be
			// able to write .harness.* markers + edit files there. The
			// isolation boundary is the container namespace/cgroup separation,
			// not the uid — a non-root uid inside a container shares the host
			// kernel but is still fully separated from sibling sessions.
			`--user ${uidGid()}`,
			`--read-only`,
			`--tmpfs /tmp:rw,noexec,nosuid,size=256m`,
			`-v ${path.resolve(repo)}:/workspace`,
			`-v ${HARNESS_ROOT}:/harness:ro`,
			`-w /workspace`,
			...envFlags,
			this.image,
			`tail -f /dev/null`,
		].join(" ")
		const createCmd = [`docker rm -f ${name} 2>/dev/null || true`, createFlags].join("\n")
		const createResult = this.run(createCmd)
		if (createResult.exitCode !== 0) {
			// Best-effort cleanup so a failed spawn never leaks a container.
			this.run(`docker rm -f ${name} 2>/dev/null || true`)
			throw new Error(`DockerSessionProvider: create failed (exit ${createResult.exitCode}): ${createResult.output}`)
		}
		// docker create prints the container id (possibly preceded by warning
		// lines, e.g. the swap-limit cgroup warning seen on this host). Take
		// the last whitespace-separated token that looks like a 64-hex id;
		// fall back to the container name we chose (equally valid for inspect).
		const containerId = [...createResult.output.trim().split(/\s+/)].reverse().find((t) => /^[0-9a-f]{64}$/.test(t)) ?? name

		const startResult = this.run(`docker start ${containerId}`)
		if (startResult.exitCode !== 0) {
			this.run(`docker rm -f ${name} 2>/dev/null || true`)
			throw new Error(`DockerSessionProvider: start failed (exit ${startResult.exitCode}): ${startResult.output}`)
		}

		return { id: worktreeSpec.name, provider: this.name, address: wtPath, containerId }
	}

	async waitReady(handle: SessionHandle): Promise<void> {
		const name = this.containerName(handle)
		const deadline = Date.now() + 60_000
		for (;;) {
			const inspect = this.run(`docker inspect ${name}`)
			if (inspect.exitCode === 0 && this.isReady(inspect.output)) {
				return
			}
			if (Date.now() > deadline) {
				throw new Error(`DockerSessionProvider: ${handle.id} not ready within 60s (last: ${inspect.output.slice(0, 200)})`)
			}
			await sleep(250)
		}
	}

	/**
	 * Run the harness command INSIDE the container (docker exec), not on the
	 * host. The command is wrapped in single quotes for the OUTER shell so the
	 * inner `bash -lc` receives it as ONE argument (JSON.stringify produces
	 * double-quoted strings that the outer shell re-splits on spaces — broken
	 * for any command with spaces, as the harness commands are). Single quotes
	 * inside the command are shell-escaped ('"'"' — the standard idiom).
	 */
	async runHarness(handle: SessionHandle, cmd: string): Promise<CommandResult> {
		const name = this.containerName(handle)
		const quoted = `'${cmd.replace(/'/g, `'\\''`)}'`
		const result = this.run(`docker exec ${name} bash -lc ${quoted}`)
		return result
	}

	async collectResults(handle: SessionHandle): Promise<Record<string, unknown>> {
		const wtPath = this.workspacePath(handle)
		const exitCode = readFileInt(path.join(wtPath, ".harness.exit"))
		const done = fs.existsSync(path.join(wtPath, ".harness.done"))
		const summary = tailFile(path.join(wtPath, "harness.log"), 40)
		return { exitCode, done, summary, worktree: wtPath }
	}

	/**
	 * Remove the container AND verify it is actually gone — a leaked container
	 * is a real cost/security problem. Docker's "removal of container ... is
	 * already in progress" (a benign race between `docker rm` calls on the
	 * same container, hit when parallel sessions teardown close together) is
	 * treated as success: the removal IS in progress, and the enumeration
	 * below is what actually proves the container is gone.
	 */
	async teardown(handle: SessionHandle): Promise<void> {
		const name = this.containerName(handle)
		const rm = this.run(`docker rm -f ${name}`)
		if (rm.exitCode !== 0 && !rm.output.includes("No such container") && !rm.output.includes("is already in progress")) {
			throw new Error(`DockerSessionProvider: teardown rm failed for ${name} (exit ${rm.exitCode}): ${rm.output}`)
		}
		// Prove removal by enumeration, not by trusting the exit code.
		// `docker rm` is async in the daemon: a just-issued rm can still list
		// the container for a few ms, so retry the enumeration briefly before
		// declaring a leak — an eventual rm failure (auth, I/O) IS a real leak
		// and still fails this loop.
		const deadline = Date.now() + 5_000
		for (;;) {
			const remaining = this.listContainers().filter((n) => n === name)
			if (remaining.length === 0) {
				return
			}
			if (Date.now() > deadline) {
				throw new Error(`DockerSessionProvider: teardown did not remove ${name} (still listed by docker ps -a)`)
			}
			await sleep(100)
		}
	}
}

// ─── Small helpers ───────────────────────────────────────────────────────────

/** Host uid:gid as "uid:gid" for --user (see the spawn comment: the workspace mount must stay writable by the harness). */
function uidGid(): string {
	return `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`
}

function dockerEnv(name: string, fallback: string): string {
	const v = process.env[name]
	return v && v.trim() !== "" ? v : fallback
}

function numberEnv(name: string, fallback: number): number {
	const v = process.env[name]
	if (v === undefined || v.trim() === "") {
		return fallback
	}
	const n = Number(v)
	return Number.isFinite(n) && n > 0 ? n : fallback
}

function readFileInt(file: string): number | undefined {
	try {
		const n = Number(fs.readFileSync(file, "utf-8").trim())
		return Number.isFinite(n) ? n : undefined
	} catch {
		return undefined
	}
}

function tailFile(file: string, maxLines: number): string {
	try {
		const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/).filter((l) => l.trim() !== "")
		return lines.slice(-maxLines).join("\n")
	} catch {
		return ""
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
