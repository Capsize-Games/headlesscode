import type {
	Calibration,
	FrozenPredictorArtifact,
	MonitorFeatureName,
	MonitorFeatureVector,
	PilotBoundary,
	Prediction,
	Standardization,
} from "./types.js"
import { MONITOR_FEATURE_ORDER } from "./types.js"
import { assertFiniteFeatures, extractMonitorFeatures, featureHash, sha256 } from "./features.js"

export interface LabeledWindow {
	readonly features: MonitorFeatureVector
	readonly label: 0 | 1
	readonly trajectoryId: string
	readonly boundarySequence?: number
}

export interface CalibrationPoint {
	readonly score: number
	readonly label: 0 | 1
}

export interface FitOptions {
	readonly modelDigest: string
	readonly templatesHash: string
	readonly l2?: 1
}

function sigmoid(value: number): number {
	if (value >= 0) {
		const z = Math.exp(-value)
		return 1 / (1 + z)
	}
	const z = Math.exp(value)
	return z / (1 + z)
}

function emptyFeatureRecord(value: number): Record<MonitorFeatureName, number> {
	return Object.fromEntries(MONITOR_FEATURE_ORDER.map((name) => [name, value])) as Record<MonitorFeatureName, number>
}

function standardize(rows: readonly LabeledWindow[]): Standardization {
	const mean = emptyFeatureRecord(0)
	const scale = emptyFeatureRecord(1)
	for (const row of rows) {
		for (const name of MONITOR_FEATURE_ORDER) mean[name] += row.features[name]
	}
	for (const name of MONITOR_FEATURE_ORDER) mean[name] /= Math.max(1, rows.length)
	for (const row of rows) {
		for (const name of MONITOR_FEATURE_ORDER) {
			const delta = row.features[name] - mean[name]
			scale[name] += delta * delta
		}
	}
	for (const name of MONITOR_FEATURE_ORDER) scale[name] = Math.sqrt((scale[name] - 1) / Math.max(1, rows.length)) || 1
	return { mean, scale }
}

function standardizedVector(features: MonitorFeatureVector, normalization: Standardization): number[] {
	assertFiniteFeatures(features)
	return MONITOR_FEATURE_ORDER.map((name) => (features[name] - normalization.mean[name]) / normalization.scale[name])
}

function fitLogistic(rows: readonly LabeledWindow[], normalization: Standardization): {
	coefficients: Record<MonitorFeatureName, number>
	intercept: number
} {
	const coefficients = emptyFeatureRecord(0)
	let intercept = 0
	// Fixed optimizer settings are part of the frozen baseline, not tunable data.
	const learningRate = 0.08
	for (let step = 0; step < 2_000; step++) {
		const gradient = emptyFeatureRecord(0)
		let interceptGradient = 0
		for (const row of rows) {
			const x = standardizedVector(row.features, normalization)
			let logit = intercept
			for (let i = 0; i < MONITOR_FEATURE_ORDER.length; i++) logit += coefficients[MONITOR_FEATURE_ORDER[i]] * x[i]
			const error = sigmoid(logit) - row.label
			interceptGradient += error
			for (let i = 0; i < MONITOR_FEATURE_ORDER.length; i++) gradient[MONITOR_FEATURE_ORDER[i]] += error * x[i]
		}
		const denominator = Math.max(1, rows.length)
		intercept -= learningRate * (interceptGradient / denominator)
		for (const name of MONITOR_FEATURE_ORDER) {
			// Fixed L2 coefficient 1.0; intercept is not regularized.
			coefficients[name] -= learningRate * (gradient[name] / denominator + coefficients[name] / denominator)
		}
	}
	return { coefficients, intercept }
}

function rawScore(artifact: Omit<FrozenPredictorArtifact, "artifactHash">, features: MonitorFeatureVector): number {
	const x = standardizedVector(features, artifact.standardization)
	let logit = artifact.intercept
	for (let i = 0; i < MONITOR_FEATURE_ORDER.length; i++) logit += artifact.coefficients[MONITOR_FEATURE_ORDER[i]] * x[i]
	return sigmoid(logit)
}

function fitCalibration(points: readonly CalibrationPoint[]): Calibration {
	let intercept = 0
	let slope = 1
	for (let step = 0; step < 1_000; step++) {
		let gi = 0
		let gs = 0
		for (const point of points) {
			const logit = Math.log(Math.min(1 - 1e-6, Math.max(1e-6, point.score)) / Math.max(1e-6, 1 - point.score))
			const probability = sigmoid(intercept + slope * logit)
			const error = probability - point.label
			gi += error
			gs += error * logit
		}
		const denominator = Math.max(1, points.length)
		intercept -= 0.05 * gi / denominator
		slope -= 0.05 * gs / denominator
	}
	return { intercept, slope }
}

function calibratedScore(artifact: Omit<FrozenPredictorArtifact, "artifactHash">, features: MonitorFeatureVector): number {
	const score = rawScore(artifact, features)
	const logit = Math.log(Math.min(1 - 1e-6, Math.max(1e-6, score)) / Math.max(1e-6, 1 - score))
	return sigmoid(artifact.calibration.intercept + artifact.calibration.slope * logit)
}

export function chooseThresholdFromScores(rows: readonly CalibrationPoint[]): number | undefined {
	for (let step = 10; step <= 19; step++) {
		const threshold = step / 20
		const selected = rows.filter((row) => row.score >= threshold)
		const truePositive = selected.filter((row) => row.label === 1).length
		const falsePositive = selected.filter((row) => row.label === 0).length
		const positives = rows.filter((row) => row.label === 1).length
		const negatives = rows.filter((row) => row.label === 0).length
		const precision = selected.length === 0 ? 1 : truePositive / selected.length
		const falsePositiveRate = negatives === 0 ? 0 : falsePositive / negatives
		if (precision >= 0.8 && falsePositiveRate <= 0.1 && positives >= 10) return threshold
	}
	return undefined
}

export function fitFrozenPredictor(
	rows: readonly LabeledWindow[],
	calibrationRows: readonly LabeledWindow[],
	options: FitOptions,
): FrozenPredictorArtifact {
	if (rows.length === 0) throw new Error("cannot fit predictor without training rows")
	const standardization = standardize(rows)
	const model = fitLogistic(rows, standardization)
	const provisional: Omit<FrozenPredictorArtifact, "artifactHash"> = {
		schemaVersion: 1,
		featureOrder: MONITOR_FEATURE_ORDER,
		coefficients: model.coefficients,
		intercept: model.intercept,
		standardization,
		calibration: fitCalibration(
			calibrationRows.map((row) => ({
				score: rawScore({
					schemaVersion: 1,
					featureOrder: MONITOR_FEATURE_ORDER,
					coefficients: model.coefficients,
					intercept: model.intercept,
					standardization,
					calibration: { intercept: 0, slope: 1 },
					threshold: 0.5,
					l2: 1,
					modelDigest: options.modelDigest,
					templatesHash: options.templatesHash,
				}, row.features),
				label: row.label,
			})),
		),
		threshold: 0.5,
		l2: 1,
		modelDigest: options.modelDigest,
		templatesHash: options.templatesHash,
	}
	const calibrationScores = calibrationRows.map((row) => ({
		score: calibratedScore(provisional, row.features),
		label: row.label,
	}))
	const threshold = chooseThresholdFromScores(calibrationScores)
	if (threshold === undefined) throw new Error("STOP: no qualifying calibration threshold")
	const frozen = { ...provisional, threshold }
	return { ...frozen, artifactHash: sha256(frozen) }
}

export function predict(artifact: FrozenPredictorArtifact, boundary: PilotBoundary): Prediction {
	const started = process.hrtime.bigint()
	try {
		return predictFromFeatures(artifact, extractMonitorFeatures(boundary))
	} catch (error) {
		const elapsedNs = Number(process.hrtime.bigint() - started)
		const features = emptyFeatureRecord(Number.NaN)
		return {
			probability: 0,
			threshold: artifact.threshold,
			features,
			featureHash: sha256(features),
			predictorHash: artifact.artifactHash,
			latencyNs: elapsedNs,
			abstentionReason: error instanceof Error && error.message.includes("finite")
				? "non-finite"
				: error instanceof Error && error.message.includes("unknown model")
					? "unknown-model"
					: "malformed",
		}
	}
}

export function predictFromFeatures(artifact: FrozenPredictorArtifact, features: MonitorFeatureVector): Prediction {
	const started = process.hrtime.bigint()
	try {
		assertFiniteFeatures(features)
		if (artifact.modelDigest.trim() === "") throw new Error("unknown model")
		const provisional = artifact as Omit<FrozenPredictorArtifact, "artifactHash">
		const probability = calibratedScore(provisional, features)
		return {
			probability,
			threshold: artifact.threshold,
			features,
			featureHash: featureHash(features),
			predictorHash: artifact.artifactHash,
			latencyNs: Number(process.hrtime.bigint() - started),
		}
	} catch (error) {
		return {
			probability: 0,
			threshold: artifact.threshold,
			features,
			featureHash: sha256(features),
			predictorHash: artifact.artifactHash,
			latencyNs: Number(process.hrtime.bigint() - started),
			abstentionReason: error instanceof Error && error.message.includes("finite")
				? "non-finite"
				: error instanceof Error && error.message.includes("unknown model")
					? "unknown-model"
					: "malformed",
		}
	}
}

export function predictedIntervention(artifact: FrozenPredictorArtifact, prediction: Prediction): boolean {
	return prediction.abstentionReason === undefined && prediction.probability >= artifact.threshold
}
