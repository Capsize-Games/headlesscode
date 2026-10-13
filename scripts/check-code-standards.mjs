// Mechanical check for docs/typescript-standards.md: line/file/class/function
// sizes, one class per file, explicit return types, no `any`, no suppression
// comments. AST-based (typescript package), so it cannot be fooled by
// strings or comments that merely mention code.
//
// Usage: node scripts/check-code-standards.mjs [paths...] [--no-baseline]
//        node scripts/check-code-standards.mjs --write-baseline
// Paths default to src (src/vendor/** always excluded). Exit 1 when the
// current violation set is not a subset of scripts/code-standards-baseline.json.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEFAULT_BASELINE = path.join(repoRoot, "scripts", "code-standards-baseline.json")
const LIMITS = { lineLength: 80, fileLines: 250, classLines: 200, functionLines: 20 }
const SUPPRESS = /eslint-disable|@ts-ignore|@ts-expect-error|#\s*noqa|#\s*type:\s*ignore/

function collectFiles(targets) {
	const out = []
	const walk = (entry) => {
		const stat = fs.statSync(entry)
		if (stat.isFile()) {
			if (entry.endsWith(".ts") && !entry.includes("src/vendor/")) out.push(entry)
			return
		}
		for (const child of fs.readdirSync(entry)) walk(path.join(entry, child))
	}
	for (const target of targets) walk(path.resolve(repoRoot, target))
	return out.sort()
}

function lineOf(sourceFile, pos) {
	return sourceFile.getLineAndCharacterOfPosition(pos).line + 1
}

function fingerprint(content) {
	return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12)
}

function checkFile(relPath, absPath) {
	const violations = []
	const text = fs.readFileSync(absPath, "utf8")
	const lines = text.split("\n")
	if (lines.length > LIMITS.fileLines) {
		// File-level rules anchor on the path: stable across edits, cleared
		// only when the file itself complies again.
		violations.push({ key: `${relPath} file-lines`, display: `${relPath}:1 file-lines ${lines.length}>${LIMITS.fileLines}` })
	}
	lines.forEach((content, i) => {
		// Line rules anchor on content hash, not line number: inserting lines
		// above must not re-baseline unrelated violations. Editing a flagged
		// line changes its hash, which correctly counts as new.
		const tag = fingerprint(content.trim())
		if (content.length > LIMITS.lineLength) {
			violations.push({ key: `${relPath} line-length ${tag}`, display: `${relPath}:${i + 1} line-length ${content.length}>${LIMITS.lineLength}` })
		}
		if (SUPPRESS.test(content)) {
			violations.push({ key: `${relPath} no-suppress ${tag}`, display: `${relPath}:${i + 1} no-suppress ${content.trim().slice(0, 60)}` })
		}
	})
	const sourceFile = ts.createSourceFile(absPath, text, ts.ScriptTarget.ES2022, true)
	let classCount = 0
	const anchorOf = (node) => {
		const start = node.getStart(sourceFile)
		const firstLine = text.slice(text.lastIndexOf("\n", start - 1) + 1, text.indexOf("\n", start))
		return { line: lineOf(sourceFile, start), tag: fingerprint(firstLine.trim()) }
	}
	const visit = (node) => {
		if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
			classCount += 1
			const span = lineOf(sourceFile, node.getEnd()) - lineOf(sourceFile, node.getStart(sourceFile)) + 1
			if (span > LIMITS.classLines) {
				const anchor = anchorOf(node)
				violations.push({ key: `${relPath} class-lines ${anchor.tag}`, display: `${relPath}:${anchor.line} class-lines ${span}>${LIMITS.classLines}` })
			}
		}
		if (ts.isFunctionLike(node) && node.body && !ts.isConstructorDeclaration(node)) {
			const span = lineOf(sourceFile, node.getEnd()) - lineOf(sourceFile, node.getStart(sourceFile)) + 1
			const anchor = anchorOf(node)
			if (span > LIMITS.functionLines) {
				violations.push({ key: `${relPath} function-lines ${anchor.tag}`, display: `${relPath}:${anchor.line} function-lines ${span}>${LIMITS.functionLines}` })
			}
			const isInlineCallback = ts.isArrowFunction(node) || ts.isFunctionExpression(node) && ts.isCallExpression(node.parent)
			if (!node.type && !isInlineCallback) {
				violations.push({ key: `${relPath} explicit-return-type ${anchor.tag}`, display: `${relPath}:${anchor.line} explicit-return-type missing return annotation` })
			}
		}
		if (node.kind === ts.SyntaxKind.AnyKeyword) {
			const anchor = anchorOf(node)
			violations.push({ key: `${relPath} no-any ${anchor.tag}`, display: `${relPath}:${anchor.line} no-any explicit any` })
		}
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	if (classCount > 1) {
		violations.push({ key: `${relPath} one-class`, display: `${relPath}:1 one-class ${classCount} classes in file` })
	}
	return violations
}

function main() {
	const args = process.argv.slice(2)
	const writeBaseline = args.includes("--write-baseline")
	const useBaseline = !args.includes("--no-baseline")
	const baselineFlag = args.indexOf("--baseline")
	if (baselineFlag >= 0 && !args[baselineFlag + 1]) {
		console.error("check-standards: --baseline needs a path")
		process.exit(2)
	}
	const baselinePath = baselineFlag >= 0 ? path.resolve(repoRoot, args[baselineFlag + 1]) : DEFAULT_BASELINE
	const targets = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--baseline")
	const files = collectFiles(targets.length ? targets : ["src"])
	const current = files.flatMap((f) => checkFile(path.relative(repoRoot, f), f)).sort((a, b) => (a.key < b.key ? -1 : 1))
	const currentKeys = new Set(current.map((v) => v.key))
	if (writeBaseline) {
		fs.writeFileSync(baselinePath, `${JSON.stringify({ version: 2, violations: [...currentKeys].sort() }, null, 1)}\n`)
		process.stdout.write(`check-standards: wrote ${currentKeys.size} violations to baseline\n`)
		return
	}
	if (!useBaseline) {
		for (const v of current) process.stdout.write(`${v.display}\n`)
		process.stdout.write(`check-standards: ${current.length} violations (--no-baseline)\n`)
		process.exit(current.length ? 1 : 0)
	}
	let baseline = []
	if (fs.existsSync(baselinePath)) {
		baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")).violations ?? []
	}
	const baseSet = new Set(baseline)
	const fresh = current.filter((v) => !baseSet.has(v.key))
	const fixed = baseline.filter((k) => !currentKeys.has(k))
	if (fresh.length) {
		for (const v of fresh) process.stdout.write(`new: ${v.display}\n`)
		process.stdout.write(`check-standards: ${fresh.length} NEW violations (baseline has ${baseline.length})\n`)
		process.exit(1)
	}
	process.stdout.write(`check-standards: ${current.length} violations, all baselined, ${fixed.length} fixed since baseline\n`)
}

main()
