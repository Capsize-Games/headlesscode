export const ORACLE_INFRASTRUCTURE_EXIT = 125

export function classifyOracleChild(result) {
	if (result.status === 125 || result.status === null || result.error || result.signal) return "infrastructure-failure"
	return result.status === 0 ? "pass" : "test-failure"
}
