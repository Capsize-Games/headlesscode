import { createHash } from "node:crypto"
import type { BenchmarkAttempt, BenchmarkImageIdentity, BenchmarkManifest, BenchmarkTask } from "./benchmark/types.js"

export interface DevelopmentProofRule {
	minimumNetWins: number
	retentionTaskIds: string[]
	maximumMeanTokenIncreaseRatio: number
}

export interface DevelopmentProofProtocol {
	schemaVersion: 1
	manifestDigest: string
	taskSetDigest: string
	taskIds: string[]
	taskIdentities: Array<{
		id: string
		family: string
		seed: number
	startDigest: string
	verifierDigest: string
	ceilings: BenchmarkTask["ceilings"]
	}>
	model: { provider: string; id: string; sampling: Record<string, number | string | boolean> }
	rule: DevelopmentProofRule
	protocolDigest: string
}

export interface DevelopmentTaskCell {
	attemptId: string
	taskId: string
	harnessCommit: string
	manifestDigest: string
	model: DevelopmentProofProtocol["model"]
	agentImage: BenchmarkImageIdentity | null
	seed: number
	startDigest: string
	evaluatorDigest: string
	ceilings: BenchmarkTask["ceilings"]
	verifiedSuccess: boolean
	validity: BenchmarkAttempt["validity"]
	proofQualified: boolean
	resourceAccounting: BenchmarkAttempt["resourceAccounting"]
	calls: number | null
	tokens: number | null
	wallTimeMs: number
}

export interface PairedTaskOutcome {
	taskId: string
	childAttemptId?: string
	parentAttemptId?: string
	outcome: "child-win" | "parent-win" | "both-pass" | "both-fail" | "invalid"
	retention: boolean
}

export interface DevelopmentProofComparison {
	referenceKind: "immediate-parent" | "original-base"
	childCommit: string
	referenceCommit: string
	comparable: boolean
	resourceQualified: boolean
	eligible: boolean
	reason: string
	outcomes: PairedTaskOutcome[]
	childWins: number
	parentWins: number
	bothPass: number
	bothFail: number
	invalid: number
	netWins: number
	childTotals: { costUsd: null; calls: number | null; tokens: number | null; wallTimeMs: number | null }
	parentTotals: { costUsd: null; calls: number | null; tokens: number | null; wallTimeMs: number | null }
	meanTokenIncreaseRatio: number | null
}

export interface CandidateDevelopmentProof {
	runId: string
	protocolDigest: string
	childAttemptIds: string[]
	parentAttemptIds: string[]
	originalBaseAttemptIds: string[]
	immediateParent: DevelopmentProofComparison
	originalBase: DevelopmentProofComparison
	accepted: boolean
	reason: string
}

export const DEFAULT_DEVELOPMENT_PROOF_RULE: DevelopmentProofRule = {
	minimumNetWins: 1,
	retentionTaskIds: ["tool-symlink-escape", "malformed-child-completion", "ollama-request-timeout", "watch-abort-callbacks"],
	maximumMeanTokenIncreaseRatio: 1.1,
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex")
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
		Object.freeze(value)
	}
	return value
}

function protocolDigest(protocol: DevelopmentProofProtocol): string {
	const { protocolDigest: _saved, ...payload } = protocol
	return sha256(JSON.stringify(payload))
}

function taskIdentity(task: BenchmarkTask): unknown {
	return {
		id: task.id,
		family: task.family,
		seed: task.seed,
		startDigest: task.startDigest,
		verifierDigest: task.verifierDigest,
		ceilings: task.ceilings,
	}
}

export function freezeDevelopmentProofProtocol(
	manifest: BenchmarkManifest,
	manifestDigest: string,
	model: DevelopmentProofProtocol["model"],
	rule: DevelopmentProofRule = DEFAULT_DEVELOPMENT_PROOF_RULE,
): DevelopmentProofProtocol {
	const tasks = manifest.tasks.filter((task) => task.split === "development").sort((left, right) => Buffer.compare(Buffer.from(left.id, "utf8"), Buffer.from(right.id, "utf8")))
	if (tasks.length === 0) throw new Error("development proof task set is empty")
	if (!/^[a-f0-9]{64}$/.test(manifestDigest)) throw new Error("development proof manifest digest is malformed")
	const taskIds = tasks.map((task) => task.id)
	if (new Set(rule.retentionTaskIds).size !== rule.retentionTaskIds.length || rule.retentionTaskIds.some((id) => !taskIds.includes(id))) throw new Error("development proof retention task set is invalid")
	if (!Number.isSafeInteger(rule.minimumNetWins) || rule.minimumNetWins < 1 || !Number.isFinite(rule.maximumMeanTokenIncreaseRatio) || rule.maximumMeanTokenIncreaseRatio < 1) throw new Error("development proof acceptance rule is invalid")
	const taskIdentities = tasks.map((task) => ({
		id: task.id, family: task.family, seed: task.seed, startDigest: task.startDigest,
		verifierDigest: task.verifierDigest, ceilings: structuredClone(task.ceilings),
	}))
	const taskSetDigest = sha256(JSON.stringify(tasks.map(taskIdentity)))
	const frozen = {
		schemaVersion: 1 as const,
		manifestDigest,
		taskSetDigest,
		taskIds: [...taskIds],
		taskIdentities,
		model: structuredClone(model),
		rule: {
			minimumNetWins: rule.minimumNetWins,
			retentionTaskIds: [...rule.retentionTaskIds].sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))),
			maximumMeanTokenIncreaseRatio: rule.maximumMeanTokenIncreaseRatio,
		},
	}
	return deepFreeze({ ...frozen, protocolDigest: sha256(JSON.stringify(frozen)) })
}

export function developmentCells(attempts: BenchmarkAttempt[]): DevelopmentTaskCell[] {
	return attempts.map((attempt) => ({
		attemptId: attempt.attemptId,
		taskId: attempt.taskId,
		harnessCommit: attempt.harnessCommit,
		manifestDigest: attempt.manifestDigest,
		model: attempt.model,
		agentImage: attempt.agentImage,
		seed: attempt.seed,
		startDigest: attempt.startDigest,
		evaluatorDigest: attempt.evaluatorDigest,
		ceilings: attempt.ceilings,
		verifiedSuccess: attempt.verifiedSuccess,
		validity: attempt.validity,
		proofQualified: attempt.proofQualified,
		resourceAccounting: attempt.resourceAccounting,
		calls: attempt.calls,
		tokens: attempt.tokens,
		wallTimeMs: attempt.wallTimeMs,
	}))
}

function totals(cells: DevelopmentTaskCell[]): DevelopmentProofComparison["childTotals"] {
	return {
		costUsd: null,
		calls: cells.length > 0 && cells.every((cell) => cell.calls !== null) ? cells.reduce((sum, cell) => sum + (cell.calls ?? 0), 0) : null,
		tokens: cells.length > 0 && cells.every((cell) => cell.tokens !== null) ? cells.reduce((sum, cell) => sum + (cell.tokens ?? 0), 0) : null,
		wallTimeMs: cells.length > 0 ? cells.reduce((sum, cell) => sum + cell.wallTimeMs, 0) : null,
	}
}

function oneImagePerHarness(cells: DevelopmentTaskCell[], commit: string): boolean {
	const images = cells.map((cell) => cell.agentImage)
	if (images.some((image) => !image || image.harnessCommit !== commit || !/^sha256:[a-f0-9]{64}$/.test(image.digest))) return false
	return new Set(images.map((image) => `${image!.name}\0${image!.digest}\0${image!.harnessCommit}`)).size === 1
}

function validCell(cell: DevelopmentTaskCell | undefined, taskId: string, protocol: DevelopmentProofProtocol): cell is DevelopmentTaskCell {
	const task = protocol.taskIdentities.find((entry) => entry.id === taskId)
	return Boolean(cell && cell.taskId === taskId && cell.manifestDigest === protocol.manifestDigest && cell.agentImage && cell.agentImage.harnessCommit === cell.harnessCommit && /^sha256:[a-f0-9]{64}$/.test(cell.agentImage.digest) &&
		JSON.stringify(cell.model) === JSON.stringify(protocol.model) && Number.isSafeInteger(cell.seed) &&
		/^[a-f0-9]{64}$/.test(cell.startDigest) && /^[a-f0-9]{64}$/.test(cell.evaluatorDigest) &&
		task && cell.seed === task.seed && cell.startDigest === task.startDigest && cell.evaluatorDigest === task.verifierDigest && JSON.stringify(cell.ceilings) === JSON.stringify(task.ceilings) &&
		["valid", "malformed", "missing", "timeout", "agent-error", "patch-error", "verifier-error"].includes(cell.validity) &&
		Number.isSafeInteger(cell.wallTimeMs) && cell.wallTimeMs >= 0 &&
		[cell.calls, cell.tokens].every((n) => n === null || (Number.isSafeInteger(n) && n >= 0)) &&
		["guest-reported", "supervisor-enforced", "incomplete"].includes(cell.resourceAccounting) &&
		(!cell.proofQualified || cell.resourceAccounting === "supervisor-enforced"))
}

export function compareDevelopmentAttempts(args: {
	protocol: DevelopmentProofProtocol
	childCommit: string
	referenceCommit: string
	referenceKind: DevelopmentProofComparison["referenceKind"]
	child: DevelopmentTaskCell[]
	reference: DevelopmentTaskCell[]
}): DevelopmentProofComparison {
	const { protocol, childCommit, referenceCommit, referenceKind } = args
	if (protocolDigest(protocol) !== protocol.protocolDigest) throw new Error("development proof protocol digest does not match its frozen tasks or rule")
	const childById = new Map(args.child.map((cell) => [cell.taskId, cell]))
	const referenceById = new Map(args.reference.map((cell) => [cell.taskId, cell]))
	const outcomes: PairedTaskOutcome[] = protocol.taskIds.map((taskId) => {
		const child = childById.get(taskId)
		const parent = referenceById.get(taskId)
		const retention = protocol.rule.retentionTaskIds.includes(taskId)
		if (!validCell(child, taskId, protocol) || !validCell(parent, taskId, protocol) || child.validity !== "valid" || parent.validity !== "valid" || child.harnessCommit !== childCommit || parent.harnessCommit !== referenceCommit ||
			child.seed !== parent.seed || child.startDigest !== parent.startDigest || child.evaluatorDigest !== parent.evaluatorDigest || JSON.stringify(child.ceilings) !== JSON.stringify(parent.ceilings)) {
			return { taskId, ...(child ? { childAttemptId: child.attemptId } : {}), ...(parent ? { parentAttemptId: parent.attemptId } : {}), outcome: "invalid", retention }
		}
		const childPass = child.verifiedSuccess
		const parentPass = parent.verifiedSuccess
		const outcome = childPass ? parentPass ? "both-pass" : "child-win" : parentPass ? "parent-win" : "both-fail"
		return { taskId, childAttemptId: child.attemptId, parentAttemptId: parent.attemptId, outcome, retention }
	})
	const childTotals = totals(args.child)
	const parentTotals = totals(args.reference)
	const childWins = outcomes.filter((item) => item.outcome === "child-win").length
	const parentWins = outcomes.filter((item) => item.outcome === "parent-win").length
	const bothPass = outcomes.filter((item) => item.outcome === "both-pass").length
	const bothFail = outcomes.filter((item) => item.outcome === "both-fail").length
	const invalid = outcomes.filter((item) => item.outcome === "invalid").length
	const resourceQualified = protocol.taskIds.every((id) => childById.get(id)?.proofQualified === true && childById.get(id)?.resourceAccounting === "supervisor-enforced" && referenceById.get(id)?.proofQualified === true && referenceById.get(id)?.resourceAccounting === "supervisor-enforced")
	const complete = args.child.length === protocol.taskIds.length && args.reference.length === protocol.taskIds.length && invalid === 0 &&
		oneImagePerHarness(args.child, childCommit) && oneImagePerHarness(args.reference, referenceCommit)
	const comparable = complete && resourceQualified
	const meanTokenIncreaseRatio = childTotals.tokens === null || parentTotals.tokens === null
		? null
		: parentTotals.tokens === 0 ? childTotals.tokens === 0 ? 1 : Number.POSITIVE_INFINITY : childTotals.tokens / parentTotals.tokens
	const retentionLoss = outcomes.some((item) => item.retention && item.outcome === "parent-win")
	const eligible = comparable && childWins - parentWins >= protocol.rule.minimumNetWins && !retentionLoss &&
		meanTokenIncreaseRatio !== null && meanTokenIncreaseRatio <= protocol.rule.maximumMeanTokenIncreaseRatio
	const reason = !complete ? "paired development task set is incomplete or has invalid cells"
		: !resourceQualified ? "resource evidence is not proof-qualified; guest-reported usage cannot gate selection"
			: retentionLoss ? "candidate regressed on a designated retention task"
				: meanTokenIncreaseRatio === null ? "authoritative token totals are unavailable"
					: meanTokenIncreaseRatio > protocol.rule.maximumMeanTokenIncreaseRatio ? "mean token increase exceeds the frozen rule"
						: childWins - parentWins < protocol.rule.minimumNetWins ? "candidate did not meet the minimum net verified task wins"
							: "candidate met the frozen immediate-parent development rule"
	return {
		referenceKind, childCommit, referenceCommit, comparable, resourceQualified, eligible, reason, outcomes,
		childWins, parentWins, bothPass, bothFail, invalid, netWins: childWins - parentWins,
		childTotals, parentTotals, meanTokenIncreaseRatio,
	}
}

export function candidateProofDecision(args: {
	runId: string
	protocol: DevelopmentProofProtocol
	child: DevelopmentTaskCell[]
	parent: DevelopmentTaskCell[]
	originalBase: DevelopmentTaskCell[]
	immediateParent: DevelopmentProofComparison
	originalBaseComparison: DevelopmentProofComparison
}): CandidateDevelopmentProof {
	const { immediateParent, originalBaseComparison } = args
	const accepted = immediateParent.eligible && originalBaseComparison.comparable && originalBaseComparison.resourceQualified
	const reason = accepted ? "eligible development proof against the immediate parent; original-base arm is also comparable"
		: !immediateParent.eligible ? immediateParent.reason
			: !originalBaseComparison.comparable || !originalBaseComparison.resourceQualified ? "original-base development comparison is not comparable or resource-qualified"
				: "development proof is ineligible"
	return {
		runId: args.runId,
		protocolDigest: args.protocol.protocolDigest,
		childAttemptIds: args.child.map((cell) => cell.attemptId),
		parentAttemptIds: args.parent.map((cell) => cell.attemptId),
		originalBaseAttemptIds: args.originalBase.map((cell) => cell.attemptId),
		immediateParent,
		originalBase: originalBaseComparison,
		accepted,
		reason,
	}
}
