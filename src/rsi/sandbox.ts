import { findMatchingPattern } from "../permissions/protected-files.js"

export function protectedPathViolations(changedFiles: string[], patterns: string[]): string[] {
	return changedFiles.filter((file) => findMatchingPattern(file, patterns) !== null)
}

export function protectedPathReport(changedFiles: string[], patterns: string[]): string {
	const violations = protectedPathViolations(changedFiles, patterns)
	return violations.length === 0 ? "none" : violations.join(", ")
}
