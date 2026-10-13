// Architectural checks for docs/typescript-standards.md: import cycles (via
// the repo's own codeintel graph — fewest lines wins), duplicated blocks,
// cyclomatic complexity, nesting depth, parameter counts, and stray
// console/process calls in src. Same baseline ratchet as check-code-standards.
//
// Usage: tsx scripts/check-architecture.mjs [paths...] [--workspace <dir>]
//        [--no-baseline] [--baseline <path>] [--write-baseline]
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

import { getCodeIntelCache } from "../src/codeintel/program.js"
import { getImportGraph } from "../src/codeintel/import-graph.js"

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEFAULT_BASELINE = path.join(repoRoot, "scripts", "architecture-baseline.json")
const LIMITS = { complexity: 10, nesting: 4, params: 5, cloneLines: 10 }

function fingerprint(content) {
	return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12)
}

function collectFiles(targets) {
	const out = []
	const walk = (entry) => {
		const stat = fs.statSync(entry)
		if (stat.isFile()) {
			if (entry.endsWith(".ts") && !entry.includes("src/vendor/") && !entry.includes("node_modules")) out.push(entry)
			return
		}
		for (const child of fs.readdirSync(entry)) walk(path.join(entry, child))
	}
	for (const target of targets) walk(path.resolve(repoRoot, target))
	return out.sort()
}

function checkCycles(workspaceRoot) {
	const findings = []
	const intel = getCodeIntelCache(workspaceRoot).get()
	const graph = getImportGraph(intel)
	const local = (p) => p && p.endsWith(".ts") && !p.includes("src/vendor/") && !p.includes("node_modules")
	const edges = new Map()
	for (const [file, imports] of graph.imports) {
		if (!local(file)) continue
		edges.set(file, imports.map((e) => e.resolved).filter((r) => local(r)).sort())
	}
	const seen = new Set()
	const stack = []
	const visit = (file) => {
		if (stack.includes(file)) {
			const cycle = [...stack.slice(stack.indexOf(file)), file]
			const relKey = [...new Set(cycle)].map((f) => path.relative(workspaceRoot, f)).sort()
			const key = `cycle ${relKey.join("<")}`
			if (!seen.has(key)) {
				seen.add(key)
				const rel = cycle.map((f) => path.relative(workspaceRoot, f))
				findings.push({ key, display: `cycle ${rel.join(" -> ")}` })
			}
			return
		}
		if (seen.has(`done:${file}`)) return
		stack.push(file)
		for (const next of edges.get(file) ?? []) visit(next)
		stack.pop()
		seen.add(`done:${file}`)
	}
	// Sorted: DFS done-pruning makes the reported cycle set order-dependent,
	// and codeintel's graph order follows readdir order, which differs per checkout.
	for (const file of [...edges.keys()].sort()) visit(file)
	return findings
}

function checkClones(files) {
	const windows = new Map()
	for (const abs of files) {
		const lines = fs.readFileSync(abs, "utf8").split("\n")
			.map((l) => l.replace(/\s+/g, " ").trim())
			.filter((l) => l && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*") && !l.startsWith("import ") && !l.startsWith("export "))
		for (let i = 0; i + LIMITS.cloneLines <= lines.length; i++) {
			const block = lines.slice(i, i + LIMITS.cloneLines).join("\n")
			const hash = fingerprint(block)
			if (!windows.has(hash)) windows.set(hash, [])
			windows.get(hash).push({ file: abs, start: i })
		}
	}
	const findings = []
	for (const [hash, spots] of windows) {
		const distinct = spots.filter((s, i) => spots.findIndex((o) => o.file === s.file && Math.abs(o.start - s.start) < LIMITS.cloneLines) === i)
		if (distinct.length < 2) continue
		const filesKey = [...new Set(distinct.map((s) => path.relative(repoRoot, s.file)))].sort()
		const key = `clone ${hash} ${filesKey.join(",")}`
		const where = distinct.slice(0, 3).map((s) => `${path.relative(repoRoot, s.file)}#${s.start + 1}`).join(", ")
		findings.push({ key, display: `clone ${LIMITS.cloneLines}+ identical lines x${distinct.length}: ${where}${distinct.length > 3 ? "…" : ""}` })
	}
	return findings
}

function complexityOf(node) {
	let score = 1
	const visit = (child) => {
		if (child !== node && ts.isFunctionLike(child)) return
		if (ts.isIfStatement(child) || ts.isConditionalExpression(child) || ts.isCaseClause(child)
			|| ts.isForStatement(child) || ts.isForInStatement(child) || ts.isForOfStatement(child)
			|| ts.isWhileStatement(child) || ts.isDoStatement(child) || ts.isCatchClause(child)) score += 1
		if (ts.isBinaryExpression(child) && ["&&", "||", "??"].includes(child.operatorToken.getText())) score += 1
		ts.forEachChild(child, visit)
	}
	ts.forEachChild(node, visit)
	return score
}

function nestingOf(node) {
	let max = 0
	const visit = (child, depth) => {
		if (child !== node && ts.isFunctionLike(child)) return
		const deeper = ts.isIfStatement(child) || ts.isCaseClause(child) || ts.isConditionalExpression(child)
			|| ts.isForStatement(child) || ts.isForInStatement(child) || ts.isForOfStatement(child)
			|| ts.isWhileStatement(child) || ts.isDoStatement(child) || ts.isTryStatement(child) || ts.isCatchClause(child)
			? depth + 1 : depth
		if (deeper > max) max = deeper
		ts.forEachChild(child, (c) => visit(c, deeper))
	}
	ts.forEachChild(node, (c) => visit(c, 0))
	return max
}

function checkFile(relPath, absPath) {
	const findings = []
	const text = fs.readFileSync(absPath, "utf8")
	const lines = text.split("\n")
	const sourceFile = ts.createSourceFile(absPath, text, ts.ScriptTarget.ES2022, true)
	const anchorOf = (node) => {
		const start = node.getStart(sourceFile)
		const firstLine = text.slice(text.lastIndexOf("\n", start - 1) + 1, text.indexOf("\n", start))
		return { line: sourceFile.getLineAndCharacterOfPosition(start).line + 1, tag: fingerprint(firstLine.trim()) }
	}
	const isTest = relPath.includes("__tests__") || relPath.endsWith(".test.ts")
	const isEntry = /(^|\/)cli\.ts$/.test(relPath) || relPath.endsWith("smoke.ts")
	const visit = (node) => {
		if (ts.isFunctionLike(node) && node.body && !ts.isConstructorDeclaration(node)) {
			const anchor = anchorOf(node)
			const complexity = complexityOf(node)
			if (complexity > LIMITS.complexity) {
				findings.push({ key: `${relPath} complexity ${anchor.tag}`, display: `${relPath}:${anchor.line} complexity ${complexity}>${LIMITS.complexity}` })
			}
			const nesting = nestingOf(node)
			if (nesting > LIMITS.nesting) {
				findings.push({ key: `${relPath} nesting ${anchor.tag}`, display: `${relPath}:${anchor.line} nesting ${nesting}>${LIMITS.nesting}` })
			}
			if (node.parameters && node.parameters.length > LIMITS.params) {
				findings.push({ key: `${relPath} params ${anchor.tag}`, display: `${relPath}:${anchor.line} params ${node.parameters.length}>${LIMITS.params}` })
			}
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
			&& node.expression.expression.getText(sourceFile) === "console" && !isTest && !isEntry) {
			const anchor = anchorOf(node)
			findings.push({ key: `${relPath} console ${anchor.tag}`, display: `${relPath}:${anchor.line} console ${lines[anchor.line - 1].trim().slice(0, 60)}` })
		}
		if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "process.exit" && !isEntry) {
			const anchor = anchorOf(node)
			findings.push({ key: `${relPath} process-exit ${anchor.tag}`, display: `${relPath}:${anchor.line} process-exit direct process.exit call` })
		}
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	return findings
}

function parseArgs(args) {
	const positional = []
	let baseline
	let workspace
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === "--baseline" || arg === "--workspace") {
			if (!args[i + 1]) {
				console.error(`check-architecture: ${arg} needs a value`)
				process.exit(2)
			}
			if (arg === "--baseline") baseline = args[i + 1]
			else workspace = args[i + 1]
			i++
		} else if (!arg.startsWith("--")) {
			positional.push(arg)
		}
	}
	return { positional, baseline, workspace }
}

function main() {
	const args = process.argv.slice(2)
	const writeBaseline = args.includes("--write-baseline")
	const useBaseline = !args.includes("--no-baseline")
	const parsed = parseArgs(args)
	const baselinePath = path.resolve(repoRoot, parsed.baseline ?? "scripts/architecture-baseline.json")
	const workspaceRoot = path.resolve(repoRoot, parsed.workspace ?? ".")
	const targets = parsed.positional
	const files = collectFiles(targets.length ? targets : ["src"])
	const current = [...checkCycles(workspaceRoot), ...checkClones(files)]
	for (const f of files) current.push(...checkFile(path.relative(repoRoot, f), f))
	current.sort((a, b) => (a.key < b.key ? -1 : 1))
	const currentKeys = new Set(current.map((v) => v.key))
	if (writeBaseline) {
		fs.writeFileSync(baselinePath, `${JSON.stringify({ version: 1, violations: [...currentKeys].sort() }, null, 1)}\n`)
		process.stdout.write(`check-architecture: wrote ${currentKeys.size} findings to baseline\n`)
		return
	}
	if (!useBaseline) {
		for (const v of current) process.stdout.write(`${v.display}\n`)
		process.stdout.write(`check-architecture: ${current.length} findings (--no-baseline)\n`)
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
		for (const v of fresh.slice(0, 50)) process.stdout.write(`new: ${v.display}\n`)
		if (fresh.length > 50) process.stdout.write(`... and ${fresh.length - 50} more\n`)
		process.stdout.write(`check-architecture: ${fresh.length} NEW findings (baseline has ${baseline.length})\n`)
		process.exit(1)
	}
	process.stdout.write(`check-architecture: ${current.length} findings, all baselined, ${fixed.length} fixed since baseline\n`)
}

main()
