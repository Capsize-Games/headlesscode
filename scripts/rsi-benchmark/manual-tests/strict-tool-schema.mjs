import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
import * as path from "node:path"

const { goToDefinitionTool, findReferencesTool } = await import(pathToFileURL(path.join(process.cwd(), "src/codeintel/tools.ts")))
for (const tool of [goToDefinitionTool, findReferencesTool]) {
	assert.equal(tool.function.strict, true)
	const schema = tool.function.parameters
	assert.equal(schema.type, "object")
	assert.equal(schema.additionalProperties, false)
	assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${tool.function.name} must require every property in strict mode`)
	for (const property of Object.values(schema.properties)) assert.ok(property.description.length > 0, "each property has a useful description")
}
console.log("Strict code-intelligence tool schemas passed")
