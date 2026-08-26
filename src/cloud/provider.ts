/**
 * Phase 6 — ephemeral compute abstraction (spec 6.1) + the local reference
 * implementation.
 *
 * The goal of 6.1 is "container/VM per issue → run harness → tear down". That
 * slots in BEHIND this interface: a cloud provider implements the same
 * five-method lifecycle as `LocalProcessProvider`, but its
 * `spawnWorktreeSession` creates a container/VM (Hetzner + Docker in the
 * 6.2 evaluation) instead of a local git worktree, `runHarness` executes the
 * harness inside it, and `teardown` deletes it. The orchestration layer
 * (orchestrate/watch) keeps calling the SAME methods either way.
 *
 * The interface is deliberately small — the cloud-specific details (image,
 * volume, network) are implementation concerns; the harness only needs
 * "make me a session, wait until it's usable, run this command in it, get the
 * results, delete it".
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { writeTaskFiles } from "../orchestrator/cli.js"
import type { WorktreeSpec } from "../orchestrator/split.js"

/** The worktree/issue spec a provider turns into an isolated session. */
export interface CloudSessionRequest {
	/** Local clone of the target repo (worktrees are created under it). */
	repo: string
	/** The issue driving this session (for task-file generation + labels). */
	issue: { number: number; title: string; body?: string }
	/** The worktree group spec (name, issues, taskFile) from splitIssues. */
	worktreeSpec: WorktreeSpec
	/** Extra env to pass to the harness (e.g. ORCHESTRATOR_MODE). */
	env?: Record<string, string>
}

/** Opaque handle returned by spawnWorktreeSession; used by the other calls. */
export interface SessionHandle {
	/** Unique id within the provider (e.g. the worktree/container name). */
	id: string
	/** Provider name (e.g. "local", "docker", "hetzner-docker"). */
	provider: string
	/** Where the session lives (worktree path / container address). */
	address?: string
	/** Provider-specific opaque identifier (e.g. container id) — optional. */
	containerId?: string
}

export interface CommandResult {
	exitCode: number
	/** Combined stdout+stderr. */
	output: string
}

/**
 * The lifecycle contract every compute backend implements. All methods are
 * async (cloud operations are slow/network-bound even when the local
 * implementation is synchronous under the hood).
 */
export interface CloudProvider {
	readonly name: string

	/** Create the isolated session (worktree/container/VM) for one issue. */
	spawnWorktreeSession(request: CloudSessionRequest): Promise<SessionHandle>

	/** Wait until the session is ready to run the harness (no-op locally). */
	waitReady(handle: SessionHandle): Promise<void>

	/** Run the harness command inside the session; returns its exit code+output. */
	runHarness(handle: SessionHandle, cmd: string): Promise<CommandResult>

	/** Gather the session's results (exit code, done marker, log summary). */
	collectResults(handle: SessionHandle): Promise<Record<string, unknown>>

	/** Tear the session down (delete worktree/container/VM). */
	teardown(handle: SessionHandle): Promise<void>
}

// ─── Local reference implementation ─────────────────────────────────────────
//
// `LocalProcessProvider` is the CURRENT behavior behind the interface:
// spawn a local git worktree (scripts/spawn-parallel-worktrees.sh) + a local
// harness process (scripts/run-worker.sh). It exists so the abstraction is
// real and tested locally — cloud providers (see the HetznerDockerProvider
// sketch in docs/phase6-cloud.md) implement the same contract.

/** The harness repo root (parent of src/cloud) — same pattern as the CLI. */
const HARNESS_ROOT = fileURLToPath(new URL("../..", import.meta.url))

export interface LocalProcessProviderOptions {
	/** Override the harness repo root (default: this repo). */
	harnessRoot?: string
	/**
	 * Dry-run: record every command instead of executing it (no worktrees, no
	 * processes). Used by tests + `--dry-run`-style callers.
	 */
	dryRun?: boolean
	/** Override the spawn script (default: scripts/spawn-parallel-worktrees.sh). */
	spawnScript?: string
	/** Override the run-worker script (default: scripts/run-worker.sh). */
	runWorkerScript?: string
	/** Injectable command runner (tests): returns a fake result instead of spawnSync. */
	run?: (command: string, cwd: string, env: Record<string, string>) => CommandResult
	/** Injectable readiness probe (tests): replaces the .harness.pid poll. */
	waitForReady?: (worktree: string, timeoutMs: number) => Promise<void>
}

export class LocalProcessProvider implements CloudProvider {
	readonly name = "local"
	private readonly harnessRoot: string
	private readonly dryRun: boolean
	private readonly spawnScript: string
	private readonly runWorkerScript: string
	private readonly run: (command: string, cwd: string, env: Record<string, string>) => CommandResult
	private readonly waitForReady?: (worktree: string, timeoutMs: number) => Promise<void>

	constructor(options: LocalProcessProviderOptions = {}) {
		this.harnessRoot = options.harnessRoot ?? HARNESS_ROOT
		this.dryRun = options.dryRun ?? false
		this.spawnScript = options.spawnScript ?? path.join(this.harnessRoot, "scripts", "spawn-parallel-worktrees.sh")
		this.runWorkerScript = options.runWorkerScript ?? path.join(this.harnessRoot, "scripts", "run-worker.sh")
		this.run =
			options.run ??
			((command, cwd, env) => {
				const res = spawnSync("bash", ["-c", command], {
					cwd,
					env: { ...process.env, ...env },
					encoding: "utf-8",
				})
				const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim()
				if (res.status !== 0) {
					return { exitCode: res.status ?? 1, output }
				}
				return { exitCode: 0, output }
			})
		this.waitForReady = options.waitForReady
	}

	/** The expected worktree path for a handle (repo/.worktrees/<id>). */
	worktreePath(handle: SessionHandle): string {
		if (handle.address) {
			return handle.address
		}
		throw new Error(`LocalProcessProvider: no address on handle ${handle.id}`)
	}

	async spawnWorktreeSession(request: CloudSessionRequest): Promise<SessionHandle> {
		const { repo, issue, worktreeSpec } = request
		const wtPath = path.join(path.resolve(repo), ".worktrees", worktreeSpec.name)

		// 1. Task file under <repo>/plans/parallel-tasks/ (the spawner copies
		//    it into the worktree) — same builder the watcher/orchestrator use.
		if (!this.dryRun) {
			writeTaskFiles(path.resolve(repo), [worktreeSpec], [issue])
		}

		// 2. Spawn via the EXISTING bash spawner (name:offset:taskfile triples,
		//    cwd = repo so `git rev-parse --show-toplevel` resolves).
		const triples = `${worktreeSpec.name}:0:plans/parallel-tasks/${worktreeSpec.taskFile}`
		const command = `bash ${this.spawnScript} ${triples}`
		const result = this.run(command, path.resolve(repo), {
			TARGET_REPO: path.resolve(repo),
			ORCHESTRATOR_MODE: request.env?.ORCHESTRATOR_MODE ?? "code",
			// Operator knobs (spawner no-index guardrail + local-explore phase)
			// flow from the ambient process env; an injected `run` only sees
			// this explicit env, so forward them alongside TARGET_REPO.
			...(process.env.ALLOW_UNINDEXED ? { ALLOW_UNINDEXED: process.env.ALLOW_UNINDEXED } : {}),
			...(process.env.HEADLESSCODE_AUTO_INDEX ? { HEADLESSCODE_AUTO_INDEX: process.env.HEADLESSCODE_AUTO_INDEX } : {}),
			...(process.env.HEADLESSCODE_LOCAL_EXPLORE ? { HEADLESSCODE_LOCAL_EXPLORE: process.env.HEADLESSCODE_LOCAL_EXPLORE } : {}),
			...(process.env.HEADLESSCODE_LOCAL_EXPLORE_MODEL
				? { HEADLESSCODE_LOCAL_EXPLORE_MODEL: process.env.HEADLESSCODE_LOCAL_EXPLORE_MODEL }
				: {}),
			...(process.env.HEADLESSCODE_LOCAL_EXPLORE_MAX_ITERATIONS
				? { HEADLESSCODE_LOCAL_EXPLORE_MAX_ITERATIONS: process.env.HEADLESSCODE_LOCAL_EXPLORE_MAX_ITERATIONS }
				: {}),
			...(process.env.HEADLESSCODE_LOCAL_EXPLORE_CONTEXT_TOKENS
				? { HEADLESSCODE_LOCAL_EXPLORE_CONTEXT_TOKENS: process.env.HEADLESSCODE_LOCAL_EXPLORE_CONTEXT_TOKENS }
				: {}),
		})
		if (result.exitCode !== 0) {
			throw new Error(`LocalProcessProvider: spawn failed (exit ${result.exitCode}): ${result.output}`)
		}

		return { id: worktreeSpec.name, provider: this.name, address: wtPath }
	}

	async waitReady(handle: SessionHandle): Promise<void> {
		if (this.dryRun) {
			return
		}
		if (this.waitForReady) {
			await this.waitForReady(this.worktreePath(handle), 30_000)
			return
		}
		// Default readiness probe: the worktree exists AND a worker pid file is
		// present (i.e. runHarness has been started). Poll up to 30s.
		const deadline = Date.now() + 30_000
		for (;;) {
			try {
				const pid = fs.readFileSync(path.join(this.worktreePath(handle), ".harness.pid"), "utf-8").trim()
				if (/^\d+$/.test(pid)) {
					return
				}
			} catch {
				// not ready yet
			}
			if (Date.now() > deadline) {
				throw new Error(`LocalProcessProvider: ${handle.id} not ready within 30s`)
			}
			await sleep(200)
		}
	}

	/** Run the harness in the session (default: scripts/run-worker.sh). */
	async runHarness(handle: SessionHandle, cmd?: string): Promise<CommandResult> {
		const wtPath = this.worktreePath(handle)
		// The spawner copies the task file into each worktree as
		// ORCHESTRATOR_TASK.md, so that is the default run-worker task. Callers
		// can pass any command (e.g. a cloud harness command) instead.
		const command =
			cmd ?? `bash ${this.runWorkerScript} '${wtPath}' ORCHESTRATOR_TASK.md --mode '${process.env.ORCHESTRATOR_MODE ?? "code"}'`
		if (this.dryRun) {
			return { exitCode: 0, output: `[dry-run] ${command}` }
		}
		const result = this.run(command, wtPath, { TARGET_REPO: this.harnessRoot })
		return result
	}

	async collectResults(handle: SessionHandle): Promise<Record<string, unknown>> {
		const wtPath = this.worktreePath(handle)
		const exitCode = readFileInt(path.join(wtPath, ".harness.exit"))
		const done = fs.existsSync(path.join(wtPath, ".harness.done"))
		const summary = tailFile(path.join(wtPath, "harness.log"), 40)
		return { exitCode, done, summary, worktree: wtPath }
	}

	async teardown(handle: SessionHandle): Promise<void> {
		if (this.dryRun) {
			return
		}
		const wtPath = this.worktreePath(handle)
		// git worktree remove detaches the worktree cleanly; force in case of
		// uncommitted harness artifacts. Address is <repo>/.worktrees/<name>.
		const repo = path.dirname(path.dirname(wtPath))
		this.run(`git worktree remove '${wtPath}' --force`, repo, {})
	}
}

/** Read a file's contents as an integer (undefined on missing/invalid). */
function readFileInt(file: string): number | undefined {
	try {
		const n = Number(fs.readFileSync(file, "utf-8").trim())
		return Number.isFinite(n) ? n : undefined
	} catch {
		return undefined
	}
}

/** Tail a file's last `maxLines` non-empty lines ("" when unreadable). */
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

// ─── Hetzner evaluation hook (superseded by the Docker provider) ─────────────
//
// `HetznerDockerProvider` was deliberately a SKETCH ONLY — it documented the
// shape a real 6.1 cloud provider would take (per docs/phase6-cloud.md) but
// was NOT implemented against live Hetzner: no API credentials, no Docker
// SDK, no network.
//
// It is now SUPERSEDED by the real `DockerSessionProvider` in
// src/cloud/docker-provider.ts (docs/multi-tenant-hosting-design.md §5): a
// working container-per-session implementation of the same `CloudProvider`
// interface, proven against a real local Docker daemon. This sketch is kept
// as a backward-compatible marker for the Phase 6.2 evaluation history and
// for the existing provider contract test; the "reason" now points at the
// replacement instead of describing an unimplemented future.
export interface HetznerDockerProviderSketch {
	readonly name: string
	readonly implemented: false
	reason: string
}

export const hetznerDockerProviderSketch: HetznerDockerProviderSketch = {
	name: "hetzner-docker",
	implemented: false,
	reason:
		"Evaluation artifact (Phase 6, spec 6.2) superseded by DockerSessionProvider (src/cloud/docker-provider.ts) — see docs/multi-tenant-hosting-design.md.",
}
