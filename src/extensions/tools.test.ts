import assert from "node:assert/strict"

import { appendExtensionTools, EXTENSION_CALL_TOOL, EXTENSION_MANAGE_TOOL } from "./tools.js"
import type { ChatTool } from "../engine/types.js"

const ordinaryTools: ChatTool[] = [
	{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } },
	{ type: "function", function: { name: "write_to_file", parameters: { type: "object", properties: {} } } },
	{ type: "function", function: { name: "execute_command", parameters: { type: "object", properties: {} } } },
]

function names(tools: ChatTool[]): string[] {
	return tools.map((tool) => tool.function.name)
}

function testCodingCatalogAddsOnlyFixedSchemas(): void {
	const result = appendExtensionTools(ordinaryTools, { codingMode: true, canWrite: true, canExecute: true, explicitAllowlist: false })
	assert.deepEqual(names(result), [...names(ordinaryTools), "extension_manage", "extension_call"])
	assert.equal(result.at(-2), EXTENSION_MANAGE_TOOL)
	assert.equal(result.at(-1), EXTENSION_CALL_TOOL)
	const snapshot = JSON.stringify(result.filter((tool) => tool.function.name.startsWith("extension_")))
	const repeated = appendExtensionTools(ordinaryTools, { codingMode: true, canWrite: true, canExecute: true, explicitAllowlist: false })
	assert.equal(JSON.stringify(repeated.filter((tool) => tool.function.name.startsWith("extension_"))), snapshot)
}

function testRestrictedCatalogsNeverGainExtensionTools(): void {
	for (const options of [
		{ codingMode: true, canWrite: false, canExecute: true, explicitAllowlist: false },
		{ codingMode: true, canWrite: true, canExecute: false, explicitAllowlist: false },
		{ codingMode: false, canWrite: true, canExecute: true, explicitAllowlist: false },
		{ codingMode: true, canWrite: true, canExecute: true, explicitAllowlist: true },
	]) {
		assert.deepEqual(appendExtensionTools(ordinaryTools, options), ordinaryTools)
	}
	const explicitlyAllowed = appendExtensionTools(
		[...ordinaryTools, { type: "function", function: { name: "extension_call" } }],
		{ codingMode: true, canWrite: true, canExecute: true, explicitAllowlist: true, explicitToolNames: ["extension_call"] },
	)
	assert.deepEqual(names(explicitlyAllowed), [...names(ordinaryTools), "extension_call"])
	assert.equal(explicitlyAllowed.at(-1), EXTENSION_CALL_TOOL)
}

function testManifestSchemaAllowsOptionalKindSpecificFields(): void {
	const schema = EXTENSION_MANAGE_TOOL.function.parameters as { properties: { manifest: { properties: Record<string, unknown>; required: string[] } } }
	const manifest = schema.properties.manifest
	assert.ok(manifest.required.includes("schemaVersion"))
	assert.equal(manifest.required.includes("entrypoint"), false)
	assert.equal(manifest.required.includes("inputSchema"), false)
}

testCodingCatalogAddsOnlyFixedSchemas()
testRestrictedCatalogsNeverGainExtensionTools()
testManifestSchemaAllowsOptionalKindSpecificFields()
console.log("All extension tool schema tests passed")
