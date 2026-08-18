/**
 * Vendored `@roo-code/types` barrel.
 *
 * The harness does not depend on the published `@roo-code/types` package. The
 * type modules below are copied verbatim from `packages/types/src/`, and this
 * barrel re-exports exactly the surface the vendored core imports. Vendored
 * files' `@roo-code/types` imports are rewritten to import this barrel by
 * relative path (issue #99 rework).
 *
 * Files: tool.ts, mode.ts, todo.ts, vscode.ts are verbatim copies.
 * message.ts and tool-params.ts are also verbatim copies; only the two types
 * each of them contributes to the vendored core are re-exported here.
 */

export * from "./tool.js"
export * from "./mode.js"
export * from "./todo.js"
export * from "./vscode.js"
export * from "./global-settings.js"

export type { ClineAsk, ToolProgressStatus } from "./message.js"
export type { GenerateImageParams, ReadFileToolParams } from "./tool-params.js"
