/**
 * SHIM — ambient type-only declaration for the `openai` package.
 *
 * All vendored tool-schema files import OpenAI types with `import type ... from
 * "openai"`, so nothing from this package is ever needed at runtime. This
 * declaration provides just enough of the `OpenAI.Chat` surface the vendored
 * schemas annotate with `satisfies OpenAI.Chat.ChatCompletionTool`.
 *
 * The canonical, much larger types come from the real `openai` npm package in
 * the upstream repo; a headless harness does not need to install it just for
 * JSON schema annotations. See VENDOR-NOTES.md.
 */

declare module "openai" {
	namespace OpenAI {
		namespace Chat {
			export type FunctionParameters = {
				type: "object"
				[key: string]: unknown
			}

			export interface ChatCompletionFunctionTool {
				type: "function"
				function: {
					name: string
					description?: string
					strict?: boolean | null
					parameters?: FunctionParameters
					[key: string]: unknown
				}
			}

			export interface ChatCompletionCustomTool {
				type: "custom"
				function: {
					name: string
					description?: string
					parameters?: unknown
					[key: string]: unknown
				}
			}

			export type ChatCompletionTool = ChatCompletionFunctionTool | ChatCompletionCustomTool

			export interface ChatCompletionCreateParams {
				tool_choice?:
					| "none"
					| "auto"
					| "required"
					| { type: "function"; function: { name: string } }
					| null
			}
		}

		export type FunctionParameters = Chat.FunctionParameters
		export type ChatCompletionTool = Chat.ChatCompletionTool
	}

	export = OpenAI
}
