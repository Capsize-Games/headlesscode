/**
 * SHIM — replaces zoo-code/src/utils/json-schema.ts.
 *
 * The original contains a 300-line zod-driven JSON Schema normalizer (and
 * imports `zod/v4` types). The vendored `native-tools/mcp_server.ts` only uses
 * `normalizeToolSchema` and `JsonSchema` to prepare MCP tool schemas. MCP
 * servers are not wired in Phase 1, so this shim provides an identity
 * normalization with a structural type. Needs adaptation when real MCP support
 * lands.
 */

export type JsonSchema = Record<string, unknown>

export function normalizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
	return schema
}
