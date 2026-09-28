import type {
	FrozenPredictorArtifact,
	InterventionDecision,
	IterationInterventionTemplateId,
	PilotArm,
	PilotBoundary,
	Prediction,
} from "./types.js"
import { predict, predictedIntervention } from "./predictor.js"

export const SPECIFIC_CORRECTION =
	"Check the latest tool result. Re-read the affected configuration if necessary, identify the failed precondition, and change the next action before retrying."
export const GENERIC_REVIEW = "Pause and review your approach before continuing."
export const TEMPLATE_TEXT: Readonly<Record<IterationInterventionTemplateId, string>> = {
	"specific-correction": SPECIFIC_CORRECTION,
	"generic-review": GENERIC_REVIEW,
}

export interface ControllerState {
	readonly arm: PilotArm
	readonly disarmed: boolean
	readonly appliedInterventionIds: ReadonlySet<string>
}

export function initialControllerState(arm: PilotArm): ControllerState {
	return { arm, disarmed: false, appliedInterventionIds: new Set() }
}

export function decide(
	artifact: FrozenPredictorArtifact | undefined,
	boundary: PilotBoundary,
	state: ControllerState,
	prediction?: Prediction,
): { prediction?: Prediction; decision?: InterventionDecision; state: ControllerState } {
	if (state.disarmed || state.arm === "B") return { prediction, state }
	const nextPrediction = prediction ?? (artifact === undefined ? undefined : predict(artifact, boundary))
	if (nextPrediction === undefined || artifact === undefined || !predictedIntervention(artifact, nextPrediction)) {
		return { prediction: nextPrediction, state }
	}
	const templateId: IterationInterventionTemplateId = state.arm === "G" ? "generic-review" : "specific-correction"
	const interventionId = `${boundary.attemptId}:${boundary.sequence}:${templateId}`
	if (state.appliedInterventionIds.has(interventionId)) return { prediction: nextPrediction, state }
	const applied = new Set(state.appliedInterventionIds)
	applied.add(interventionId)
	return {
		prediction: nextPrediction,
		decision: { interventionId, templateId, reason: "threshold" },
		state: { ...state, disarmed: true, appliedInterventionIds: applied },
	}
}

export function randomDecision(
	boundary: PilotBoundary,
	state: ControllerState,
	probability: number,
	random: () => number,
): { decision?: InterventionDecision; state: ControllerState } {
	if (state.disarmed || state.arm !== "R" || probability <= 0 || random() >= probability) return { state }
	const interventionId = `${boundary.attemptId}:${boundary.sequence}:specific-correction`
	if (state.appliedInterventionIds.has(interventionId)) return { state }
	const applied = new Set(state.appliedInterventionIds)
	applied.add(interventionId)
	return {
		decision: { interventionId, templateId: "specific-correction", reason: "random-schedule" },
		state: { ...state, disarmed: true, appliedInterventionIds: applied },
	}
}

export function applyFixedTemplate(messages: string[], decision: InterventionDecision): void {
	const text = TEMPLATE_TEXT[decision.templateId]
	if (typeof text !== "string") throw new Error("unknown intervention template")
	messages.push(text)
}
