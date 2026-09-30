export type OracleChildResult = {
	status: number | null
	error?: { code?: string } | null
	signal?: string | null
}
export type OracleChildKind = "pass" | "test-failure" | "infrastructure-failure"
export const ORACLE_INFRASTRUCTURE_EXIT: 125
export function classifyOracleChild(result: OracleChildResult): OracleChildKind
