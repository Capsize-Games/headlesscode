/**
 * Terminal-status leaf (issue #128).
 *
 * TERMINAL_STATUSES/isTerminalStatus lived in src/orchestrator/status.ts,
 * which cleanup.ts needs — pulling the whole status CLI back in and closing
 * an import cycle (status.ts only needs the CleanupStatus TYPE from
 * cleanup.ts, which is cycle-free on its own). This leaf has no imports, so
 * both modules can share the predicate cycle-free; status.ts re-exports the
 * same names for backward compatibility.
 */

/**
 * The statuses that end a round for a group. `blocked` is NOT here on
 * purpose: a group waiting on a decision answer is not finished, and
 * `--wait` must keep waiting rather than exit early. `orphaned` IS here:
 * the group's worktree is gone, so there is nothing left to wait FOR.
 */
export const TERMINAL_STATUSES = [
	"done",
	"failed",
	"needs-human",
	"orphaned",
] as const

export function isTerminalStatus(status: string): boolean {
	return TERMINAL_STATUSES.includes(status as (typeof TERMINAL_STATUSES)[number])
}
