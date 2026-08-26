/**
 * Entrypoint-rooted end-to-end flows for the codemap (Phase 2, issue #18):
 * for each entrypoint module, the sorted list of every module reachable from
 * it along directed import+call edges.
 *
 * Phase 2 explicitly considered RANKING flows by "importance" (entrypoint
 * fan-out, path length to a sink, …) and deliberately punted: every sketch
 * either needed per-framework semantics (FastAPI routes, Celery tasks,
 * pub/sub topics) that can't be derived without the project-specific pattern
 * lists, or reduced to "sort by size of the reachable set" in a trench coat.
 * The useful, honest half is surfacing the flows themselves — a human or a
 * worker can filter them, while a wrong ranking is worse than no ranking
 * (the original prompt's "Mark any relationship without source evidence as
 * unknown. Do not guess."). Deterministic: same repo, same flows.
 */

import type { CodemapEdge, ModuleEntry } from "./types.js"

/**
 * Compute the entrypoint-rooted flow map for a set of modules + edges.
 *
 * BFS along edge direction (imports, includes and calls all count — a call
 * is as much a "flow" as an import). Result keys are the sorted entrypoint
 * paths; values are the sorted reachable module paths, excluding the
 * entrypoint itself. A pure function of modules + edges, so it is derived
 * (not fingerprinted) by the build.
 */
export function computeEntrypointFlows(
	modules: ReadonlyArray<Pick<ModuleEntry, "path" | "role">>,
	edges: ReadonlyArray<Pick<CodemapEdge, "from" | "to">>,
): Record<string, string[]> {
	const byPath = new Set(modules.map((m) => m.path))
	const adjacency = new Map<string, string[]>()
	for (const edge of edges) {
		if (!byPath.has(edge.from) || !byPath.has(edge.to)) {
			continue
		}
		const targets = adjacency.get(edge.from) ?? []
		if (!targets.includes(edge.to)) {
			targets.push(edge.to)
		}
		adjacency.set(edge.from, targets)
	}

	const flows: Record<string, string[]> = {}
	for (const entrypoint of modules.filter((m) => m.role === "entrypoint").map((m) => m.path).sort()) {
		const reachable = new Set<string>()
		const queue = [...(adjacency.get(entrypoint) ?? [])]
		while (queue.length > 0) {
			const current = queue.shift()!
			if (reachable.has(current)) {
				continue
			}
			reachable.add(current)
			for (const next of adjacency.get(current) ?? []) {
				queue.push(next)
			}
		}
		flows[entrypoint] = [...reachable].sort()
	}
	return flows
}
