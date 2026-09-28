import { createHash } from "node:crypto"
import type { MonitorFeatureName, MonitorFeatureVector, PilotBoundary, PilotToolCall, PilotToolResult } from "./types.js"
import { MONITOR_FEATURE_ORDER } from "./types.js"

export function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
	const record = value as Record<string, unknown>
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`
}

export function sha256(value: unknown): string {
	return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex")
}

function isReadOnlyCall(call: PilotToolCall): boolean {
	return call.name === "read_file" || call.name === "list_files" || call.name === "execute_command"
}

function isWriteCall(call: PilotToolCall): boolean {
	return call.name === "apply_diff"
}

function callSignature(call: PilotToolCall): string {
	return `${call.name}:${stableJson(call.args)}`
}

function resultSignature(result: PilotToolResult): string {
	return `${result.name}:${result.isError}:${result.resultHash}`
}

function boundedFraction(numerator: number, denominator: number): number {
	return denominator > 0 ? numerator / denominator : 0
}

/** Extract only current and recent action/result state. Oracle fields never enter here. */
export function extractMonitorFeatures(boundary: PilotBoundary): MonitorFeatureVector {
	const turns = [...boundary.recentTurns].slice(-4)
	const calls = turns.flatMap((turn) => turn.calls)
	const results = turns.flatMap((turn) => turn.results)
	const lastCall = boundary.calls.at(-1)
	let identicalCallStreak = boundary.deterministicGuardrails.identicalCallStreak
	if (lastCall !== undefined) {
		identicalCallStreak = 0
		for (const call of [...calls].reverse()) {
			if (callSignature(call) !== callSignature(lastCall)) break
			identicalCallStreak++
		}
	}
	let sameToolErrorStreak = boundary.deterministicGuardrails.sameToolErrorStreak
	const lastError = [...results].reverse().find((result) => result.isError)
	if (lastError !== undefined) {
		sameToolErrorStreak = 0
		for (const result of [...results].reverse()) {
			if (!result.isError || result.name !== lastError.name) break
			sameToolErrorStreak++
		}
	}
	const distinctCalls = new Set(calls.map(callSignature)).size
	const errorCount = results.filter((result) => result.isError).length
	const repeatedResults = results.length - new Set(results.map(resultSignature)).size
	let turnsSinceSuccessfulVirtualWrite = 0
	for (const turn of [...turns].reverse()) {
		if (turn.successfulVirtualWrite) break
		turnsSinceSuccessfulVirtualWrite++
	}
	const values: Record<MonitorFeatureName, number> = {
		identicalCallStreak,
		sameToolErrorStreak,
		readOnlyStreak: boundary.deterministicGuardrails.readOnlyStreak,
		uniqueCallFraction4: boundedFraction(distinctCalls, calls.length),
		errorFraction4: boundedFraction(errorCount, results.length),
		turnsSinceSuccessfulVirtualWrite,
		repeatedResultFraction4: boundedFraction(repeatedResults, results.length),
		iterationBudgetFraction: boundary.maxIterations > 0 ? boundary.iteration / boundary.maxIterations : 1,
	}
	return values
}

export function featureVector(features: MonitorFeatureVector): number[] {
	return MONITOR_FEATURE_ORDER.map((name) => features[name])
}

export function featureHash(features: MonitorFeatureVector): string {
	return sha256(featureVector(features))
}

export function assertFiniteFeatures(features: MonitorFeatureVector): void {
	for (const name of MONITOR_FEATURE_ORDER) {
		if (!Number.isFinite(features[name])) throw new Error(`non-finite feature: ${name}`)
	}
}

export function currentTurnIsReadOnly(boundary: PilotBoundary): boolean {
	return boundary.calls.length > 0 && boundary.calls.every(isReadOnlyCall)
}

export function currentTurnHasWrite(boundary: PilotBoundary): boolean {
	return boundary.calls.some(isWriteCall) && boundary.results.some((result) => result.name === "apply_diff" && !result.isError)
}
