#!/usr/bin/env node
/**
 * Mechanical citation verifier: extracts every `path/to/file.ext:N` or
 * `path/to/file.ext:N-M` citation from a markdown doc and prints the REAL
 * content at that location, so a human (or a smarter reviewer) can check
 * whether the citation's attached claim actually matches reality.
 *
 * Neither the writing model nor a text-only judge model can be trusted to
 * do this themselves: live-verified 2026-08-21 (guided-research-with-
 * review.sh) that a real citation (a genuine file:line that exists) can
 * carry a completely fabricated claim about what's there, and a judge
 * given only the document text has no way to catch it — it can only see
 * that a citation-shaped string is present, same blind spot as
 * requireArtifactMinCitations' own regex check. This script closes that
 * gap deterministically: no LLM involved, just real file reads.
 *
 * Usage: node scripts/eval-suite/verify-citations.mjs <doc-path> [workspace-root]
 */
import fs from "node:fs"
import path from "node:path"

const docPath = process.argv[2]
const workspaceRoot = process.argv[3] ?? process.cwd()

if (!docPath) {
	console.error("Usage: verify-citations.mjs <doc-path> [workspace-root]")
	process.exit(1)
}

const CITATION_PATTERN = /\b[\w.-]+(?:\/[\w.-]+)+\.\w+:\d+(?:-\d+)?\b/g

const docContent = fs.readFileSync(docPath, "utf-8")
const citations = [...new Set(docContent.match(CITATION_PATTERN) ?? [])]

if (citations.length === 0) {
	console.log("No file:line-shaped citations found.")
	process.exit(0)
}

console.log(`Found ${citations.length} unique citation(s) in ${docPath}\n`)

let anyMissing = false
for (const citation of citations) {
	const match = /^(.+):(\d+)(?:-(\d+))?$/.exec(citation)
	if (!match) continue
	const [, filePart, startStr, endStr] = match
	const start = Number(startStr)
	const end = endStr ? Number(endStr) : start
	const filePath = path.resolve(workspaceRoot, filePart)

	console.log(`--- ${citation} ---`)
	if (!fs.existsSync(filePath)) {
		console.log(`  [MISSING FILE] ${filePath} does not exist.`)
		anyMissing = true
		console.log()
		continue
	}
	const lines = fs.readFileSync(filePath, "utf-8").split("\n")
	const lo = Math.max(1, start - 1)
	const hi = Math.min(lines.length, end + 1)
	for (let n = lo; n <= hi; n++) {
		const marker = n >= start && n <= end ? ">" : " "
		console.log(`  ${marker} ${n}: ${lines[n - 1] ?? ""}`)
	}
	console.log()
}

if (anyMissing) {
	console.log("WARNING: one or more cited files do not exist.")
	process.exit(2)
}
