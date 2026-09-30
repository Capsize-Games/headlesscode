import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
const root = path.resolve(process.argv[2] ?? "")
const taskId = process.argv[3]
const files = [{"path":"scripts/rsi-benchmark/manual-tests/strict-tool-schema.mjs","source":"import assert from \"node:assert/strict\"\nimport { pathToFileURL } from \"node:url\"\nimport * as path from \"node:path\"\n\nconst { goToDefinitionTool, findReferencesTool } = await import(pathToFileURL(path.join(process.cwd(), \"src/codeintel/tools.ts\")))\nfor (const tool of [goToDefinitionTool, findReferencesTool]) {\n\tassert.equal(tool.function.strict, true)\n\tconst schema = tool.function.parameters\n\tassert.equal(schema.type, \"object\")\n\tassert.equal(schema.additionalProperties, false)\n\tassert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${tool.function.name} must require every property in strict mode`)\n\tfor (const property of Object.values(schema.properties)) assert.ok(property.description.length > 0, \"each property has a useful description\")\n}\nconsole.log(\"Strict code-intelligence tool schemas passed\")\n"}]
for (const file of files) { const target = path.resolve(root, file.path); assert.ok(target.startsWith(root + path.sep)); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await fs.writeFile(target, file.source, { mode: 0o600 }) }
for (const file of files) { const target = path.resolve(root, file.path); const result = spawnSync(process.execPath, [process.env.HEADLESSCODE_BENCHMARK_TSX ?? "/opt/headlesscode/node_modules/tsx/dist/cli.mjs", target], { cwd: root, encoding: "utf8", timeout: 110000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, HOME: root } }); if (result.error || result.status !== 0) { process.stderr.write("" + (result.error?.message ?? "") + result.stdout + result.stderr); process.exit(result.status ?? 1) } }
process.stdout.write("historical independent regression checks passed: " + taskId + " (" + files.length + " files)\n")
