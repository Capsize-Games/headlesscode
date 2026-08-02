/**
 * `outline` analysis: every top-level (and one level of nested) declaration
 * in a source file, as `line kind signature` — one compact line per symbol,
 * signatures only, no bodies. Built on the real AST (`ts.forEachChild`), not
 * regex: kinds come from the node types, lines from
 * `ts.getLineAndCharacterOfPosition`, and signatures are the node's own
 * source text cut at its body — so `14 function foo(x: string): void` is
 * exactly what the source says, no guesswork.
 */

import * as ts from "typescript"

export interface OutlineEntry {
	/** 1-based line of the declaration's name. */
	line: number
	kind: string
	signature: string
	/** Nesting depth: 0 = top level, 1 = class/interface/namespace member. */
	depth: number
}

/** Map a TS node to a short human kind label. */
function kindOf(node: ts.Node): string | undefined {
	if (ts.isFunctionDeclaration(node)) return "function"
	if (ts.isClassDeclaration(node)) return "class"
	if (ts.isInterfaceDeclaration(node)) return "interface"
	if (ts.isTypeAliasDeclaration(node)) return "type"
	if (ts.isEnumDeclaration(node)) return "enum"
	if (ts.isModuleDeclaration(node)) return "namespace"
	if (ts.isVariableStatement(node)) return "var"
	if (ts.isMethodDeclaration(node)) return "method"
	if (ts.isPropertyDeclaration(node)) return "property"
	if (ts.isGetAccessorDeclaration(node)) return "getter"
	if (ts.isSetAccessorDeclaration(node)) return "setter"
	if (ts.isPropertySignature(node)) return "property"
	if (ts.isMethodSignature(node)) return "method"
	if (ts.isCallSignatureDeclaration(node)) return "call-signature"
	if (ts.isConstructSignatureDeclaration(node)) return "construct-signature"
	if (ts.isIndexSignatureDeclaration(node)) return "index-signature"
	return undefined
}

/** True for function-like nodes whose body is a block we must cut off. */
function hasBlockBody(node: ts.Node): boolean {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	)
}

/** A container whose members are worth outlining one level deep. */
function isContainer(node: ts.Node): boolean {
	return (
		ts.isClassDeclaration(node) ||
		ts.isInterfaceDeclaration(node) ||
		ts.isModuleDeclaration(node) ||
		ts.isEnumDeclaration(node)
	)
}

/**
 * The declaration's signature text WITHOUT its body: for functions, source
 * from the node start up to the body's `{`; for types/classes/interfaces,
 * up to the first `{` or `;`. Internal whitespace is collapsed to one space
 * so multi-line signatures stay on a single output line.
 */
function signatureOf(node: ts.Node, sourceFile: ts.SourceFile): string {
	const full = node.getText(sourceFile)
	let cut = full
	if (hasBlockBody(node)) {
		const body = (node as ts.FunctionLikeDeclaration).body
		if (body !== undefined) {
			cut = full.slice(0, body.getStart(sourceFile) - node.getStart(sourceFile))
		}
	} else {
		const brace = cut.indexOf("{")
		const semi = cut.indexOf(";")
		if (brace !== -1 && (semi === -1 || brace < semi)) {
			cut = cut.slice(0, brace)
		} else if (semi !== -1) {
			cut = cut.slice(0, semi)
		}
	}
	return stripLeadingKeywords(cut.replace(/\s+/g, " ").trim())
}

/**
 * Leading tokens to drop from a signature: visibility/export modifiers and the
 * declaration keyword itself (`export function foo()`, `abstract class Shape`,
 * `public readonly x`). The kind column already prints the keyword, so keeping
 * it would duplicate ("function export function foo()").
 */
const STRIP_PREFIX = [
	"export", "default", "declare", "abstract", "async",
	"public", "private", "protected", "readonly", "static", "override",
	"function", "class", "interface", "type", "enum", "namespace", "module",
	"const", "let", "var",
]

/** Strip leading modifier/kind tokens, keeping the name onward intact. */
function stripLeadingKeywords(text: string): string {
	const words = text.split(/\s+/)
	let i = 0
	while (i < words.length && STRIP_PREFIX.includes(words[i]!)) {
		i++
	}
	return words.slice(i).join(" ")
}

/** Variable statements declare each name separately (kind from the statement). */
function variableEntries(stmt: ts.VariableStatement, sourceFile: ts.SourceFile): OutlineEntry[] {
	const flags = stmt.declarationList.flags
	const kind = flags & ts.NodeFlags.Const ? "const" : flags & ts.NodeFlags.Let ? "let" : "var"
	return stmt.declarationList.declarations.map((decl) => {
		const name = decl.name.getText(sourceFile)
		const type = decl.type !== undefined ? decl.type.getText(sourceFile) : undefined
		return {
			line: ts.getLineAndCharacterOfPosition(sourceFile, decl.getStart(sourceFile)).line + 1,
			kind,
			// The kind column already prints the keyword — don't repeat it.
			signature: `${name}${type !== undefined ? `: ${type}` : ""}`,
			depth: 0,
		}
	})
}

/**
 * Outline a source file. `maxDepth` controls how deep into the declaration
 * tree we go: 0 = top level only, 1 (default) = also members of classes,
 * interfaces, and namespaces. Function bodies are never descended into —
 * nested locals are noise for a structure overview.
 */
export function outlineSourceFile(sourceFile: ts.SourceFile, maxDepth = 1): OutlineEntry[] {
	const entries: OutlineEntry[] = []

	const walk = (node: ts.Node, depth: number): void => {
		if (ts.isVariableStatement(node)) {
			entries.push(...variableEntries(node, sourceFile))
		} else {
			const kind = kindOf(node)
			if (kind !== undefined) {
				const named = node as { name?: ts.Node }
				entries.push({
					line:
						ts.getLineAndCharacterOfPosition(sourceFile, named.name ? named.name.getStart(sourceFile) : node.getStart(sourceFile))
							.line + 1,
					kind,
					signature: signatureOf(node, sourceFile),
					depth,
				})
			}
		}

		if (depth >= maxDepth) {
			return
		}
		// Never look inside function bodies; containers get one deeper level.
		if (hasBlockBody(node) || ts.isVariableStatement(node)) {
			return
		}
		if (isContainer(node)) {
			ts.forEachChild(node, (child) => walk(child, depth + 1))
			return
		}
		ts.forEachChild(node, (child) => walk(child, depth))
	}

	ts.forEachChild(sourceFile, (child) => walk(child, 0))
	return entries
}

/** Render outline entries as the compact `line kind signature` lines. */
export function formatOutline(entries: OutlineEntry[]): string {
	if (entries.length === 0) {
		return "No declarations found in this file."
	}
	return entries.map((e) => `${"  ".repeat(e.depth)}${e.line} ${e.kind} ${e.signature}`).join("\n")
}
