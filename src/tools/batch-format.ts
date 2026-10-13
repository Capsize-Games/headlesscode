/**
 * `batch` result rendering: labeled per-section blocks within the char
 * budgets, plus the `N sub-calls: X ok, Y error(s)` counts line.
 */

import type { BatchSection } from "./batch-types.js"

/** Per-section body cap (chars); the section keeps a truncation marker. */
export const MAX_BATCH_SECTION_CHARS = 20000
/** Whole-result cap (chars); over-budget sections become stubs. */
export const MAX_BATCH_TOTAL_CHARS = 60000

function sectionStatus(section: BatchSection): string {
	if (section.ok) {
		return "ok"
	}
	return section.skipped ? "skipped" : "error"
}

function formatSection(
	index: number,
	total: number,
	section: BatchSection,
): string {
	const at = `[${index + 1}/${total}] ${section.tool}`
	const head = `${at} — ${sectionStatus(section)}`
	const size = ` (${section.content.length} chars)`
	if (section.content.length <= MAX_BATCH_SECTION_CHARS) {
		return `${head}${size}\n${section.content}`
	}
	const kept = section.content.slice(0, MAX_BATCH_SECTION_CHARS)
	return `${head}${size}, truncated to ${MAX_BATCH_SECTION_CHARS}\n${kept}`
}

/** Join sections within the total budget; over-budget ones become stubs. */
export function assembleSections(
	total: number,
	sections: BatchSection[],
): string {
	const lines: string[] = []
	const omitted: number[] = []
	let used = 0
	sections.forEach((section, index) => {
		const rendered = formatSection(index, total, section)
		if (used + rendered.length > MAX_BATCH_TOTAL_CHARS) {
			omitted.push(index + 1)
			return
		}
		used += rendered.length
		lines.push(rendered)
	})
	if (omitted.length > 0) {
		const which = omitted.join(", ")
		lines.push(`[sections ${which} omitted — output budget exceeded]`)
	}
	return lines.join("\n")
}

export function formatSummary(
	total: number,
	sections: BatchSection[],
): string {
	const okCount = sections.filter((s) => s.ok).length
	const skipped = sections.filter((s) => s.skipped).length
	const errors = total - okCount - skipped
	let summary = `${total} sub-calls: ${okCount} ok, ${errors} error(s)`
	if (skipped > 0) {
		summary += `, ${skipped} skipped`
	}
	return summary
}
