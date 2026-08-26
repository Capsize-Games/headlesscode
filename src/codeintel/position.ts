/**
 * Position → identifier resolution shared by `go_to_definition` and
 * `find_references`.
 *
 * The TS LanguageService APIs (`getDefinitionAtPosition`,
 * `getReferencesAtPosition`) take a character OFFSET into the file, not a
 * line number — so the tools' `{ line, character?, symbol? }` parameter
 * shape is resolved here into a concrete `ts.Identifier` the LS can answer
 * about:
 *   - `character` given (1-based column): the identifier touching that column
 *   - `symbol` given: the first identifier on the line whose text matches
 *   - neither: the first identifier on the line
 *
 * Identifiers come from a real AST walk (`ts.forEachChild`), so text inside
 * strings, comments, and import specifiers is naturally excluded — except
 * import clause names (`import { foo }` parses `foo` as an Identifier), which
 * is exactly what we want: "go to definition" on an imported name must
 * resolve through the checker to its real declaration.
 */

import * as ts from "typescript"

/** Collect every Identifier whose text range falls on `line` (1-based). */
export function identifiersOnLine(sourceFile: ts.SourceFile, line: number): ts.Identifier[] {
	const line0 = line - 1
	const found: ts.Identifier[] = []
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node)) {
			const { line: nodeLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile))
			if (nodeLine === line0) {
				found.push(node)
			}
		}
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	return found
}

/**
 * Resolve a (1-based line, optional 1-based character) + optional symbol name
 * to the identifier a user means, or undefined when nothing resolvable sits
 * at that spot. "Touching" semantics: a character pointing at the LAST char
 * of an identifier still selects it, so a model that guessed the column one
 * short of the end still gets the right symbol.
 */
export function identifierAtPosition(
	sourceFile: ts.SourceFile,
	line: number,
	character: number | undefined,
	symbol: string | undefined,
): ts.Identifier | undefined {
	if (line < 1 || line > sourceFile.getLineStarts().length) {
		return undefined
	}
	const onLine = identifiersOnLine(sourceFile, line)
	if (onLine.length === 0) {
		return undefined
	}

	if (character !== undefined && character >= 1) {
		const lineStart = ts.getPositionOfLineAndCharacter(sourceFile, line - 1, 0)
		const pos = lineStart + (character - 1)
		for (const id of onLine) {
			if (pos >= id.getStart(sourceFile) && pos <= id.getEnd()) {
				return id
			}
		}
		return undefined
	}

	if (symbol !== undefined && symbol.trim() !== "") {
		return onLine.find((id) => id.text === symbol)
	}

	return onLine[0]
}
