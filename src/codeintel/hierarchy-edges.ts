/**
 * Call-edge extraction for `call_hierarchy`: which function calls which,
 * resolved with the real TS checker (`getResolvedSignature`), not text
 * matching. Unresolvable calls (any-typed, dynamic) are skipped silently
 * by the collector — they never become edges.
 */

import * as ts from "typescript"

import { type CodeIntel } from "./program.js"

/** One resolved call: caller site + callee declaration. */
export interface HierarchyEdge {
	callerFile: string
	callerLine: number
	callerFn: string
	callerKey: string
	calleeFile: string
	calleeLine: number
	calleeFn: string
	calleeKey: string
}

export type HierarchyDirection = "callers" | "callees" | "both"

/** Hard cap on hierarchy depth and on rendered edge lines. */
export const MAX_HIERARCHY_DEPTH = 5
export const MAX_HIERARCHY_EDGES = 50

/** Identity key for a declaration node (file + start offset). */
export function nodeKey(node: ts.Node): string {
	const sf = node.getSourceFile()
	return `${sf.fileName}:${node.getStart(sf)}`
}

function isFunctionLike(node: ts.Node): boolean {
	return ts.isFunctionDeclaration(node)
		|| ts.isMethodDeclaration(node)
		|| ts.isFunctionExpression(node)
		|| ts.isArrowFunction(node)
		|| ts.isConstructorDeclaration(node)
		|| ts.isGetAccessorDeclaration(node)
		|| ts.isSetAccessorDeclaration(node)
}

/** Nearest enclosing function-like node, or undefined at top level. */
export function enclosingFunction(node: ts.Node): ts.Node | undefined {
	let current: ts.Node | undefined = node.parent
	while (current !== undefined) {
		if (isFunctionLike(current)) {
			return current
		}
		current = current.parent
	}
	return undefined
}

/** Best-effort name for a function-like node (or <anonymous>). */
function nameOfFunction(node: ts.Node): string {
	if (ts.isConstructorDeclaration(node)) {
		return "constructor"
	}
	const name = (node as { name?: ts.Node }).name
	if (name !== undefined && ts.isIdentifier(name)) {
		return name.text
	}
	const parent = node.parent
	if (parent === undefined || !ts.isVariableDeclaration(parent)) {
		return "<anonymous>"
	}
	if (ts.isIdentifier(parent.name)) {
		return parent.name.text
	}
	return "<anonymous>"
}

/** A resolved callee declaration (file + line + name + key). */
interface CalleeTarget {
	file: string
	line: number
	name: string
	key: string
}

/** The resolved callee declaration of a call, or undefined. */
function calleeOf(
	checker: ts.TypeChecker,
	node: ts.CallExpression | ts.NewExpression,
): CalleeTarget | undefined {
	const declaration = checker.getResolvedSignature(node)?.declaration
	if (declaration === undefined) {
		return undefined
	}
	const sf = declaration.getSourceFile()
	const start = declaration.getStart(sf)
	const { line } = ts.getLineAndCharacterOfPosition(sf, start)
	return {
		file: sf.fileName,
		line: line + 1,
		name: nameOfFunction(declaration),
		key: nodeKey(declaration),
	}
}

/** Record one call edge when its signature resolves to a declaration. */
function recordCall(
	checker: ts.TypeChecker,
	node: ts.CallExpression | ts.NewExpression,
	sourceFile: ts.SourceFile,
	edges: HierarchyEdge[],
): void {
	const callee = calleeOf(checker, node)
	if (callee === undefined) {
		return
	}
	const start = node.getStart(sourceFile)
	const { line } = ts.getLineAndCharacterOfPosition(sourceFile, start)
	const enclosing = enclosingFunction(node)
	const callerFn = enclosing === undefined
		? "<top-level>"
		: nameOfFunction(enclosing)
	const callerKey = enclosing === undefined
		? `top:${sourceFile.fileName}`
		: nodeKey(enclosing)
	edges.push({
		callerFile: sourceFile.fileName,
		callerLine: line + 1,
		callerFn,
		callerKey,
		calleeFile: callee.file,
		calleeLine: callee.line,
		calleeFn: callee.name,
		calleeKey: callee.key,
	})
}

/** Walk one source file, recording every resolved call edge. */
function collectFileEdges(
	checker: ts.TypeChecker,
	sourceFile: ts.SourceFile,
	edges: HierarchyEdge[],
): void {
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
			recordCall(checker, node, sourceFile, edges)
		}
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
}

/** Every resolved call edge in the program's own (non-declaration) files. */
export function collectCallEdges(intel: CodeIntel): HierarchyEdge[] {
	const checker = intel.program.getTypeChecker()
	const edges: HierarchyEdge[] = []
	for (const sf of intel.program.getSourceFiles()) {
		if (!sf.isDeclarationFile) {
			collectFileEdges(checker, sf, edges)
		}
	}
	return edges
}
