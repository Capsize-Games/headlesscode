/**
 * `call_hierarchy` query + rendering: resolve a position to its target
 * declaration(s), BFS the call edges from ./hierarchy-edges.js to a bounded
 * depth on either side, and render one `from -> to` line per edge.
 */

import * as ts from "typescript"

import {
	collectCallEdges,
	enclosingFunction,
	MAX_HIERARCHY_DEPTH,
	MAX_HIERARCHY_EDGES,
	nodeKey,
	type HierarchyDirection,
	type HierarchyEdge,
} from "./hierarchy-edges.js"
import { identifierAtPosition } from "./position.js"
import { scriptKindFromFileName, type CodeIntel } from "./program.js"

/** Where the requested position resolves: target declarations + scope. */
export interface HierarchyTarget {
	name: string
	file: string
	line: number
	declKeys: string[]
	callerKey: string
}

/** Symbol at a location, with alias imports resolved to their target. */
function targetSymbol(
	checker: ts.TypeChecker,
	identifier: ts.Identifier,
): ts.Symbol | undefined {
	const sym = checker.getSymbolAtLocation(identifier)
	if (sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0) {
		return checker.getAliasedSymbol(sym)
	}
	return sym
}

/** Resolve the requested position to its declaration(s) + enclosing scope. */
export function resolveHierarchyTarget(
	intel: CodeIntel,
	file: string,
	line: number,
	character: number | undefined,
	symbol: string | undefined,
): HierarchyTarget | undefined {
	const sourceFile = intel.program.getSourceFile(file) ??
		readStandalone(file)
	if (sourceFile === undefined) {
		throw new Error(
			`file is not part of the loaded TypeScript program: ${file}`,
		)
	}
	const identifier = identifierAtPosition(
		sourceFile,
		line,
		character,
		symbol,
	)
	if (identifier === undefined) {
		return undefined
	}
	const sym = targetSymbol(intel.program.getTypeChecker(), identifier)
	if (sym?.declarations === undefined || sym.declarations.length === 0) {
		return undefined
	}
	const enclosing = enclosingFunction(identifier)
	const callerKey = enclosing === undefined
		? `top:${file}`
		: nodeKey(enclosing)
	return {
		name: identifier.text,
		file,
		line,
		declKeys: sym.declarations.map(nodeKey),
		callerKey,
	}
}

/** Parse a file standalone (for files created after program load). */
function readStandalone(file: string): ts.SourceFile | undefined {
	const text = ts.sys.readFile(file)
	if (text === undefined) {
		return undefined
	}
	return ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		scriptKindFromFileName(file),
	)
}

/** One BFS level: callers match calleeKey, callees match callerKey. */
interface WalkStep {
	found: HierarchyEdge[]
	next: Set<string>
}

function walkDepth(
	edges: HierarchyEdge[],
	frontier: Set<string>,
	outgoing: boolean,
	seen: Set<string>,
): WalkStep {
	const found: HierarchyEdge[] = []
	const next = new Set<string>()
	for (const edge of edges) {
		if (!frontier.has(outgoing ? edge.callerKey : edge.calleeKey)) {
			continue
		}
		const key = `${edge.callerFile}:${edge.callerLine}:` +
			edge.calleeKey
		if (seen.has(key)) {
			continue
		}
		seen.add(key)
		found.push(edge)
		next.add(outgoing ? edge.calleeKey : edge.callerKey)
	}
	return { found, next }
}

/** BFS one side up to maxDepth levels, with cycle protection. */
function walkSide(
	edges: HierarchyEdge[],
	startKeys: string[],
	maxDepth: number,
	outgoing: boolean,
): HierarchyEdge[] {
	const found: HierarchyEdge[] = []
	const seen = new Set<string>()
	const visited = new Set<string>(startKeys)
	let frontier = new Set<string>(startKeys)
	for (let depth = 0; depth < maxDepth && frontier.size > 0; depth++) {
		const step = walkDepth(edges, frontier, outgoing, seen)
		found.push(...step.found)
		frontier = new Set(
			[...step.next].filter((k) => !visited.has(k)),
		)
		for (const k of frontier) {
			visited.add(k)
		}
	}
	return found
}

/** Both requested sides from the resolved target, capped at maxDepth. */
export interface HierarchySides {
	callers: HierarchyEdge[]
	callees: HierarchyEdge[]
}

export function findCallHierarchy(
	intel: CodeIntel,
	target: HierarchyTarget,
	direction: HierarchyDirection,
	maxDepth: number,
): HierarchySides {
	const edges = collectCallEdges(intel)
	const depth = Math.min(Math.max(maxDepth, 1), MAX_HIERARCHY_DEPTH)
	const callers = direction === "callees"
		? []
		: walkSide(edges, target.declKeys, depth, false)
	const callees = direction === "callers"
		? []
		: walkSide(edges, [target.callerKey], depth, true)
	return { callers, callees }
}

/** One edge as `rel:line callerFn -> rel:line calleeFn`. */
function formatEdge(
	rel: (p: string) => string,
	edge: HierarchyEdge,
): string {
	const from = `${rel(edge.callerFile)}:${edge.callerLine} ` +
		edge.callerFn
	const to = `${rel(edge.calleeFile)}:${edge.calleeLine} ` +
		edge.calleeFn
	return `${from} -> ${to}`
}

/** Render one side's edges, capped, with a truncation note on overflow. */
function renderSide(
	title: string,
	edges: HierarchyEdge[],
	rel: (p: string) => string,
	limit: number,
): string {
	const shown = edges.slice(0, limit)
	const lines = shown.map((e) => formatEdge(rel, e))
	if (edges.length === 0) {
		lines.push("(none)")
	} else if (edges.length > shown.length) {
		const missing = edges.length - shown.length
		const kind = title.toLowerCase()
		lines.push(`…${missing} more ${kind} edge(s) not shown`)
	}
	return `${title}:\n${lines.join("\n")}`
}

/** Render both requested sides with headers, capped at 50 edges total. */
export function formatCallHierarchy(
	rel: (p: string) => string,
	target: HierarchyTarget,
	callers: HierarchyEdge[],
	callees: HierarchyEdge[],
	direction: HierarchyDirection,
): string {
	const where = `${rel(target.file)}:${target.line}`
	const head = `Call hierarchy for ${target.name} (${where}):`
	const sections: string[] = []
	const used = direction === "both"
		? Math.min(callers.length, MAX_HIERARCHY_EDGES)
		: 0
	if (direction !== "callees") {
		const side = renderSide(
			"Callers",
			callers,
			rel,
			MAX_HIERARCHY_EDGES,
		)
		sections.push(side)
	}
	if (direction !== "callers") {
		const rest = MAX_HIERARCHY_EDGES - used
		sections.push(renderSide("Callees", callees, rel, rest))
	}
	return `${head}\n${sections.join("\n")}`
}
