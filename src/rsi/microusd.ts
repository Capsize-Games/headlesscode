/** Add durable integer microUSD amounts before converting once for display. */
export function sumMicrousd(values: Iterable<unknown>): number {
	let totalMicrousd = 0
	for (const value of values) {
		const microusd = Number(value)
		if (!Number.isSafeInteger(microusd) || microusd < 0 || !Number.isSafeInteger(totalMicrousd + microusd)) {
			throw new Error("microUSD amount is not a non-negative safe integer")
		}
		totalMicrousd += microusd
	}
	return totalMicrousd
}

/** Add durable integer microUSD amounts before converting once for display. */
export function sumMicrousdAsUsd(values: Iterable<unknown>): number {
	return sumMicrousd(values) / 1_000_000
}

/** Compare a displayed USD value to the exact integer billing amount without tolerance. */
export function usdEqualsMicrousd(value: unknown, microusd: number): boolean {
	return typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(microusd) && microusd >= 0 && value === microusd / 1_000_000
}
