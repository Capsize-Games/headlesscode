import { combinedArchive } from "./controller-candidates.js"
import { selectParentChoices, type ParentChoice } from "./selection.js"
import type {
	CandidateRecord,
	RsiArchive,
	RsiConfig,
	RsiRunRecord,
} from "./types.js"
import { newCandidate } from "./workspace.js"

export interface PlanGenerationArgs {
	archive: RsiArchive
	run: RsiRunRecord
	config: RsiConfig
	runConfig: RsiConfig
	generation: number
	now: () => string
	log: (message: string) => void
	checkpoint: () => Promise<void>
}

function parentChoicesFor(
	archive: RsiArchive,
	run: RsiRunRecord,
	config: RsiConfig,
	generation: number,
): ParentChoice[] {
	if (generation === 0) return []
	const merged = { ...combinedArchive(archive, run) }
	merged.candidates = run.candidates
	const policy = run.parentSelectionPolicy ?? "champion-specialist-novelty"
	return selectParentChoices(merged, policy, config.population)
}

function fallbackBaseFor(run: RsiRunRecord): string {
	if (!run.selected) return run.baseCommit
	const found = run.candidates.find((entry) => entry.id === run.selected)
	return found?.commits[0] ?? run.baseCommit
}

function plannedCount(config: RsiConfig, generation: number): number {
	const single = config.computePolicy === "adaptive-independent"
	return single && generation > 0 ? 1 : config.population
}

export async function planGenerationCandidates(
	args: PlanGenerationArgs,
): Promise<CandidateRecord[]> {
	const { archive, run, config, runConfig } = args
	const { generation, now, log, checkpoint } = args
	const choices = parentChoicesFor(archive, run, config, generation)
	const fallbackBase = fallbackBaseFor(run)
	const count = plannedCount(config, generation)
	const scope = { run, runConfig, generation }
	const candidates = Array.from({ length: count }, (_, index) =>
		makePlannedCandidate(scope, index, choices[index], fallbackBase,
			now()))
	run.candidates.push(...candidates)
	log(`[rsi] generation ${generation}: planning ${candidates.length}`
		+ ` candidate(s) with policy ${run.parentSelectionPolicy}`)
	if (!config.dryRun) await checkpoint()
	return candidates
}

interface PlanScope {
	run: RsiRunRecord
	runConfig: RsiConfig
	generation: number
}

function makePlannedCandidate(
	scope: PlanScope,
	index: number,
	parentChoice: ParentChoice | undefined,
	fallbackBase: string,
	stamp: string,
): CandidateRecord {
	const { run, runConfig, generation } = scope
	const base = parentChoice?.baseCommit ?? fallbackBase
	const made = newCandidate(runConfig, generation, index, base,
		stamp, parentChoice)
	if (parentChoice) run.parentChoices![made.id] = parentChoice.reason
	return made
}
