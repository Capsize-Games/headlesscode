/**
 * Checkpoint service — thin wrapper around the vendored
 * `RepoPerTaskCheckpointService` (a shadow git repo, per-task, tracking the
 * real workspace via `core.worktree`; see
 * `src/vendor/zoo-code/src/services/checkpoints/`).
 *
 * A "checkpoint" is a commit in a hidden shadow git repository — separate
 * from any real git repo the workspace happens to have — so it never
 * interferes with the user's own commits/branches/index. Restoring a
 * checkpoint checks the shadow ref out onto the REAL working tree
 * (`core.worktree` points at the workspace), so it genuinely reverts files.
 *
 * IMPORTANT — the shadow dir must live OUTSIDE the workspace it tracks. Zoo
 * Code's real shadow dir is always outside any workspace (a VS Code
 * extension's `globalStorageUri`, e.g. under the user's app-data profile).
 * Two vendored operations assume that:
 *   - `stageAll()` (called by `initShadowGit`/`saveCheckpoint`/`getDiff`) runs
 *     `git add` with `cwd` set to the shadow dir itself. If the shadow dir is
 *     nested inside the workspace, `git add .`'s `.` pathspec resolves
 *     relative to that nested `cwd`, not the worktree root — so it only ever
 *     matches the (nearly empty) shadow dir, and both the "initial commit"
 *     and every checkpoint silently become empty-tree commits (verified
 *     empirically). This wrapper patches `stageAll` to `git add -A` (which
 *     resolves against the repo root regardless of `cwd`) as a belt-and-suspenders
 *     fix — see the patch below — but that alone does not make nesting safe:
 *   - `restoreCheckpoint()` runs `git clean -f -d -f` against the worktree.
 *     If the shadow dir is nested inside the workspace and isn't part of the
 *     shadow repo's own tracked tree (it never is — a git repo can't usefully
 *     track its own `.git`), `git clean` treats the entire shadow dir —
 *     `.git` included — as untracked cruft in the worktree and DELETES IT,
 *     destroying the checkpoint history it's mid-restore from. Verified
 *     empirically: a nested shadow dir does not survive a single restore.
 *
 * For both reasons, `createCheckpointService` refuses to create a service
 * whose `checkpointDir` resolves inside `workspaceRoot`, and defaults to a
 * per-user location outside any workspace: the central store's
 * `~/.local/share/headlesscode/checkpoints` (mirroring Zoo Code's
 * `globalStorageUri` design; consolidated here from the old
 * `~/.headlesscode/checkpoints` — see src/project-store.ts's
 * migrateCheckpointStore). Each session's shadow repo is further namespaced by
 * a random `taskId`, so unrelated workspaces/sessions never collide there.
 *
 * Failure handling: every method here can throw (init can fail if git isn't
 * installed, a nested git repo is detected, etc.). This wrapper does NOT
 * swallow errors — callers (e.g. `HeadlessSession` in `src/engine/loop.ts`)
 * are expected to wrap calls in try/catch and treat failures as non-fatal,
 * exactly like the existing Phase 3 memory-recall pattern. The CLI
 * (`src/checkpoints/cli.ts`) surfaces errors directly since a human is
 * driving it there.
 */

import * as path from "node:path"

import { ensureCheckpointMigration, projectStoreRoot } from "../project-store.js"
import { ShadowCheckpointService } from "../vendor/zoo-code/src/services/checkpoints/ShadowCheckpointService.js"
import type { CheckpointDiff, CheckpointResult } from "../vendor/zoo-code/src/services/checkpoints/types.js"

/**
 * Default shadow-git storage root, outside any workspace (see file header).
 * Lives under the central data store (`~/.local/share/headlesscode/checkpoints`)
 * — consolidated from the old `~/.headlesscode/checkpoints`, which is migrated
 * once automatically on first use (see ensureCheckpointMigration).
 */
export function defaultCheckpointDir(): string {
	ensureCheckpointMigration()
	return path.join(projectStoreRoot(), "checkpoints")
}

export interface CreateCheckpointServiceOptions {
	/** Session/task id — the shadow repo lives at `<checkpointDir>/tasks/<taskId>/checkpoints`. */
	taskId: string
	/** The real workspace whose files are being tracked (not the shadow dir itself). */
	workspaceRoot: string
	/** Base shadow-git storage dir. Default: `defaultCheckpointDir()`. Must NOT be inside workspaceRoot. */
	checkpointDir?: string
	/** Optional log sink (default: no-op — callers typically wire this to their own logger). */
	log?: (message: string) => void
}

export interface CheckpointLogEntry {
	hash: string
	date: string
	message: string
}

/** True when `child` is `parent` itself or nested anywhere inside it. */
function isSameOrInside(parent: string, child: string): boolean {
	const parentAbs = path.resolve(parent)
	const childAbs = path.resolve(child)
	if (parentAbs === childAbs) {
		return true
	}
	const rel = path.relative(parentAbs, childAbs)
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/**
 * Internal subclass that exposes just enough of `ShadowCheckpointService`'s
 * protected `git` handle to list commits with metadata (message/date) —
 * `getCheckpoints()` on the base class only returns bare hashes, which isn't
 * enough for a human-facing `checkpoints list` CLI. Everything else is
 * inherited from the vendored class unmodified. Named "RepoPerTask..." to
 * match the vendored subclass's directory-layout convention
 * (`shadowDir/tasks/<taskId>/checkpoints`).
 */
class RepoPerTaskCheckpointServiceWithLog extends ShadowCheckpointService {
	static create({ taskId, workspaceRoot, checkpointDir, log }: Required<CreateCheckpointServiceOptions>) {
		return new RepoPerTaskCheckpointServiceWithLog(
			taskId,
			path.join(checkpointDir, "tasks", taskId, "checkpoints"),
			workspaceRoot,
			log,
		)
	}

	async logEntries(): Promise<CheckpointLogEntry[]> {
		if (!this.git) {
			throw new Error("Shadow git repo not initialized")
		}
		const log = await this.git.log()
		// simple-git returns newest-first; checkpoints read more naturally oldest-first.
		return log.all.map((c) => ({ hash: c.hash, date: c.date, message: c.message })).reverse()
	}
}

/**
 * Patch `ShadowCheckpointService`'s private `stageAll()` to use `git add -A`
 * instead of the vendored `git add . --ignore-errors` — see the file header
 * for why. `stageAll` is declared `private` on `ShadowCheckpointService`,
 * which is a compile-time-only restriction in TypeScript; the method still
 * exists on the prototype at runtime and can be replaced like any other.
 * This patches ONE method's implementation on our own subclass's prototype;
 * every other vendored code path (`initShadowGit`, `saveCheckpoint`,
 * `restoreCheckpoint`, `getDiff`) is untouched and calls through to this
 * patched `stageAll` exactly as before. `git add -A` behaves identically to
 * `git add .` when `cwd` is already the repo root (the expected/enforced
 * layout here), so this is a no-op behavior change in the supported
 * configuration and only matters as defense in depth.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
;(RepoPerTaskCheckpointServiceWithLog.prototype as any).stageAll = async function (
	this: { log: (message: string) => void },
	git: { add: (args: string[]) => Promise<unknown> },
) {
	try {
		await git.add(["-A", "--ignore-errors"])
	} catch (error) {
		this.log(`[stageAll] failed to add files to git: ${error instanceof Error ? error.message : String(error)}`)
	}
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class CheckpointService {
	private readonly svc: RepoPerTaskCheckpointServiceWithLog
	private initialized = false

	constructor(private readonly options: Required<CreateCheckpointServiceOptions>) {
		this.svc = RepoPerTaskCheckpointServiceWithLog.create(options)
	}

	get taskId(): string {
		return this.options.taskId
	}

	get checkpointsDir(): string {
		return this.svc.checkpointsDir
	}

	/** Initialize the shadow git repo (idempotent per process — safe to call once per session). */
	async init(): Promise<{ created: boolean; duration: number }> {
		if (this.initialized) {
			return { created: false, duration: 0 }
		}
		const result = await this.svc.initShadowGit()
		this.initialized = true
		return result
	}

	/** Save a checkpoint (commit). Returns undefined when there was nothing to commit (no changes, allowEmpty false). */
	async save(message: string, options?: { allowEmpty?: boolean }): Promise<CheckpointResult | undefined> {
		return this.svc.saveCheckpoint(message, options)
	}

	/** Check the shadow ref out onto the real workspace, reverting files to that checkpoint. */
	async restore(commitHash: string): Promise<void> {
		return this.svc.restoreCheckpoint(commitHash)
	}

	/** Diff between two checkpoints (or a checkpoint and the current working tree when `to` is omitted). */
	async diff(options: { from?: string; to?: string }): Promise<CheckpointDiff[]> {
		return this.svc.getDiff(options)
	}

	/** List checkpoints oldest-first, with commit message + date. */
	async list(): Promise<CheckpointLogEntry[]> {
		return this.svc.logEntries()
	}
}

/**
 * Create (but do not initialize) a checkpoint service for a task/session.
 * Call `.init()` before `.save()`/`.restore()`/`.diff()`/`.list()`.
 *
 * Throws synchronously if `checkpointDir` resolves inside `workspaceRoot` —
 * see the file header for why that combination is unsafe (a restore would
 * delete the shadow repo, and possibly nothing would ever get staged).
 */
export function createCheckpointService(options: CreateCheckpointServiceOptions): CheckpointService {
	const checkpointDir = options.checkpointDir ?? defaultCheckpointDir()

	if (isSameOrInside(options.workspaceRoot, checkpointDir)) {
		throw new Error(
			`Checkpoint dir '${checkpointDir}' is inside the workspace it tracks ('${options.workspaceRoot}'). ` +
				"The shadow git repo must live outside the workspace (restoring a checkpoint runs " +
				"`git clean` against the workspace, which would delete a nested shadow repo). " +
				"Pass a checkpointDir outside the workspace, or omit it to use the default " +
				`(${defaultCheckpointDir()}).`,
		)
	}

	return new CheckpointService({
		taskId: options.taskId,
		workspaceRoot: options.workspaceRoot,
		checkpointDir,
		log: options.log ?? (() => {}),
	})
}
