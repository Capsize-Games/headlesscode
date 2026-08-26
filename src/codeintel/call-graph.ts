/**
 * CALL-edge extraction for the codemap's Phase 2 (issue #18): which function
 * in module A calls which function in module B — resolved with the real TS
 * checker, not text matching.
 *
 * For every CallExpression/NewExpression in the program we ask the type
 * checker for the RESOLVED signature and take its `declaration` — the actual
 * function/method/constructor the call binds to. The declaration's source
 * file is the edge's target. This is the same resolution the language
 * service uses for go-to-definition, so overloads, re-exports, aliased
 * imports and method calls all land on the real implementation (the 
 * deterministic answer the issue's "no LLM" requirement demands — no
 * name-matching heuristics anywhere).
 *
 * Call targets that resolve OUTSIDE the scanned workspace (lib.d.ts,
 * node_modules) or don't resolve at all (calls on `any`, dynamic JS calls)
 * are carried with `resolvedFile: undefined` — the consumer (codemap's
 * extractor) drops them, because external call targets are already visible
 * through the module's import edges + externalDeps.
 */

import * as ts from "typescript"

import type { CodeIntel } from "./program.js"

/** One call site in a source file, resolved to its real callee declaration. */
export interface CallEdge {
	/** Human-readable callee expression as written, e.g. "greet", "obj.method", "Foo". */
	callee: string
	/** Absolute path of the file declaring the callee (undefined when unresolvable). */
	resolvedFile: string | undefined
}

/** Per absolute file path: every call site in that file. */
export type CallGraph = Map<string, CallEdge[]>

/**
 * Build (or return the cached) call graph for the program. A pure function
 * of the program's source files, so it is computed once and reused until the
 * program itself is rebuilt — same caching idiom as the import graph.
 *
 * Walking every program source file (not just `projectFiles`) matters: a
 * module can be part of the program because a project file imports it, and
 * calls FROM it must still resolve.
 */
export function getCallGraph(intel: CodeIntel): CallGraph {
	const cached = (intel as { __callGraph?: CallGraph }).__callGraph
	if (cached !== undefined) {
		return cached
	}

	const checker = intel.program.getTypeChecker()
	const graph: CallGraph = new Map()

	for (const sourceFile of intel.program.getSourceFiles()) {
		const edges: CallEdge[] = []

		const collect = (node: ts.Node): void => {
			if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
				const signature = checker.getResolvedSignature(node)
				const declaration = signature?.declaration
				edges.push({
					callee: node.expression.getText(sourceFile),
					resolvedFile: declaration?.getSourceFile().fileName,
				})
			}
			ts.forEachChild(node, collect)
		}
		collect(sourceFile)

		if (edges.length > 0) {
			graph.set(sourceFile.fileName, edges)
		}
	}

	;(intel as { __callGraph?: CallGraph }).__callGraph = graph
	return graph
}
