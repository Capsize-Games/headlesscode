import { promoteArchivedCurriculumTask } from "./curriculum.js"

function argument(flag: string): string | undefined {
	const index = process.argv.indexOf(flag)
	return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
	const archiveDir = argument("--archive-dir")
	const taskId = argument("--task-id")
	if (!archiveDir || !taskId || process.argv.some((value, index) => value.startsWith("--") && !["--archive-dir", "--task-id"].includes(value)) || process.argv.filter((value) => value === "--archive-dir").length !== 1 || process.argv.filter((value) => value === "--task-id").length !== 1) {
		throw new Error("usage: headlesscode-rsi-promote-curriculum --archive-dir <path> --task-id <id>")
	}
	const task = await promoteArchivedCurriculumTask(archiveDir, taskId)
	process.stdout.write(`${task.id} promoted at ${task.promotedAt}\n`)
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
	process.exitCode = 1
})
