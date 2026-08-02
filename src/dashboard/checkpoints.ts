/**
 * Browser control plane — checkpoint list/diff/restore, as a thin HTTP-agnostic
 * wrapper around `src/checkpoints/service.ts` (the same way
 * `src/dashboard/session-launch.ts` wraps the session-launch logic).
 *
 * The dashboard routes pass `repo` (the workspace whose files the shadow git
 * repo tracks) + `session` (the session/task id — HeadlessSession uses its
 * sessionId as the checkpoint service's taskId, see src/engine/loop.ts) and
 * this module does the rest: resolve the service against the default shadow
 * storage root, init it, and delegate list/diff/restore.
 *
 * `renderUnifiedDiff` turns the service's `CheckpointDiff[]` (one entry per
 * changed file, each with before/after full content) into a simple
 * unified-diff-style text block — the same plain-text ethos the CLI uses, no
 * diff library. This is a deliberate UI-only rendering choice; nothing here
 * reimplements shadow-git diffing.
 *
 * Restore is DESTRUCTIVE (reverts real workspace files) — the HTTP layer
 * gates it behind the optional bearer token, and the UI requires an explicit
 * confirmation step before calling it. This module just performs the call.
 */

import * as path from "node:path"

import { createCheckpointService, defaultCheckpointDir, type CheckpointLogEntry } from "../checkpoints/service.js"
import type { CheckpointDiff } from "../vendor/zoo-code/src/services/checkpoints/types.js"

/** Options for resolving a checkpoint service for one session. */
export interface CheckpointRouteOptions {
	/** Workspace root whose files the shadow repo tracks (the dashboard's repo param). */
	workspaceRoot: string
	/** Session/task id (the checkpoint service's taskId). */
	sessionId: string
	/** Shadow-git storage root override (default: defaultCheckpointDir()). Test-only. */
	checkpointDir?: string
}

/**
 * Resolve + initialize the checkpoint service for a session. Throws on
 * invalid input (e.g. checkpointDir nested inside workspaceRoot) — the HTTP
 * layer surfaces the message as an error response.
 */
export async function resolveCheckpointService(
	options: CheckpointRouteOptions,
): Promise<ReturnType<typeof createCheckpointService>> {
	const checkpointDir = options.checkpointDir
		? path.resolve(options.checkpointDir)
		: defaultCheckpointDir()
	const service = createCheckpointService({
		taskId: options.sessionId,
		workspaceRoot: path.resolve(options.workspaceRoot),
		checkpointDir,
	})
	await service.init()
	return service
}

/** List checkpoints oldest-first (message, date, hash). */
export async function listCheckpoints(options: CheckpointRouteOptions): Promise<CheckpointLogEntry[]> {
	const service = await resolveCheckpointService(options)
	return service.list()
}

/** Diff between two checkpoints, or a checkpoint and the current working tree (to omitted). */
export async function diffCheckpoints(
	options: CheckpointRouteOptions,
	from: string,
	to?: string,
): Promise<CheckpointDiff[]> {
	const service = await resolveCheckpointService(options)
	return service.diff({ from, to })
}

/** Restore a checkpoint — reverts REAL workspace files (destructive). */
export async function restoreCheckpoint(options: CheckpointRouteOptions, hash: string): Promise<void> {
	const service = await resolveCheckpointService(options)
	await service.restore(hash)
}

/**
 * Render `CheckpointDiff[]` as a plain unified-diff-style text block:
 *
 *   --- a/src/greet.js
 *   +++ b/src/greet.js
 *   @@ src/greet.js @@
 *   -// BUG: old line
 *   +// fixed line
 *
 * Line-level `-`/`+` marking requires the before/after content line counts to
 * align for readability, so this does a trivial line-by-line prefix (before
 * lines get `-`, after lines get `+`, padding the shorter side with a blank
 * marker) — deliberately NOT a real diff algorithm. Good enough for a plain
 * dashboard; matches the project's zero-dependency ethos.
 */
export function renderUnifiedDiff(changes: CheckpointDiff[]): string {
	if (changes.length === 0) {
		return "(no changes)"
	}
	const blocks: string[] = []
	for (const change of changes) {
		const rel = change.paths.relative
		const before = change.content.before.split("\n")
		const after = change.content.after.split("\n")
		// split() leaves a trailing "" when content ends with \n — drop it so
		// the marker count matches the actual displayed lines.
		if (before.length > 0 && before[before.length - 1] === "") before.pop()
		if (after.length > 0 && after[after.length - 1] === "") after.pop()

		const width = Math.max(before.length, after.length)
		const lines: string[] = []
		for (let i = 0; i < width; i++) {
			const b = i < before.length ? before[i] : ""
			const a = i < after.length ? after[i] : ""
			if (b !== a) {
				if (b !== "") lines.push("-" + b)
				if (a !== "") lines.push("+" + a)
			}
		}
		blocks.push(
			`--- a/${rel}\n+++ b/${rel}\n@@ ${rel} @@\n` + (lines.length > 0 ? lines.join("\n") : "(identical content)"),
		)
	}
	return blocks.join("\n\n")
}
