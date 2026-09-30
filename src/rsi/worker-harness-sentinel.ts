export function workerHarnessSentinelDiff(marker: string): string {
	const context = [
		"\t// Headless harness workflow conventions, appended AFTER the vendored",
		"\t// builder's output (which is vendored code and must not be edited in",
		"\t// place). These are harness-level expectations that live outside any",
		"\t// single rules file: committing real work before finishing, running the",
		"\t// targeted test file(s) during the iterative edit-check loop, and",
		"\t// batching same-file diffs into one apply_diff. Edit-workflow guidance",
		"\t// only applies to modes that can actually edit files (modeHasEditGroup);",
		"\t// read-only reviewer/QA roles never see it.",
		"\tconst conventions = buildHeadlessConventions(modeConfig.slug, customModes)",
		"\tconst fullPrompt = conventions === undefined ? withStackRules : `${withStackRules}\\n${conventions}`",
	]
	return [
		"<<<<<<< SEARCH",
		"-------",
		...context,
		"",
		"\treturn { prompt: fullPrompt, modeConfig, customModes }",
		"=======",
		...context,
		`\tconst fullPromptWithSentinel = \`${"${fullPrompt}"}\\n${marker}\``,
		"",
		"\treturn { prompt: fullPromptWithSentinel, modeConfig, customModes }",
		">>>>>>> REPLACE",
	].join("\n")
}
