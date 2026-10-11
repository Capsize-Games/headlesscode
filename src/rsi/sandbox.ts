import { DEFAULT_PROTECTED_FILES, findMatchingPattern } from "../permissions/protected-files.js"

const MUTATION_HARD_PROTECTIONS = [
	"src/rsi/", "scripts/", "tests/", "test/", "fixtures/",
	"**/*.test.ts", "**/*.spec.ts", "package.json", "package-lock.json", ".gitignore", "docker/", ".dockerignore",
	".headlesscode/", ".worktrees/", "__rsi_benchmark_verifier__/",
]

export function protectedPathViolations(changedFiles: string[], patterns: string[]): string[] {
	return changedFiles.filter((file) => findMatchingPattern(file, patterns) !== null)
}

export function mutationSnapshotProtectedPathViolations(changedFiles: string[], configuredPatterns: string[]): string[] {
	const patterns = [...new Set([...DEFAULT_PROTECTED_FILES, ...MUTATION_HARD_PROTECTIONS, ...configuredPatterns])]
	return protectedPathViolations(changedFiles, patterns)
}

export function protectedPathReport(changedFiles: string[], patterns: string[]): string {
	const violations = protectedPathViolations(changedFiles, patterns)
	return violations.length === 0 ? "none" : violations.join(", ")
}
