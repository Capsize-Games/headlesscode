/**
 * Vendored `@roo-code/types` barrel.
 *
 * The harness does not depend on the published `@roo-code/types` package. The
 * type modules below are copied verbatim from `packages/types/src/`, and this
 * barrel re-exports exactly the surface the vendored core imports. It is wired
 * up via the "@roo-code/types" entry in tsconfig.json "paths".
 *
 * Files: tool.ts, mode.ts, todo.ts, vscode.ts are verbatim copies.
 * message.ts and tool-params.ts are also verbatim copies; only the two types
 * each of them contributes to the vendored core are re-exported here.
 */

export * from "./tool.js"
export * from "./mode.js"
export * from "./todo.js"
export * from "./vscode.js"

export type { ClineAsk, ToolProgressStatus } from "./message.js"
export type { GenerateImageParams, ReadFileToolParams } from "./tool-params.js"
