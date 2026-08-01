/**
 * SHIM — minimal stand-in for the `@anthropic-ai/sdk` package.
 *
 * Maps to this file via the "@anthropic-ai/sdk" entry in tsconfig.json
 * "paths". The vendored `shared/tools.ts` imports the `Anthropic` value only
 * for its types (TextBlockParam/ImageBlockParam), and
 * `native-tools/converters.ts` imports it with `import type`. The class +
 * namespace merging below mirrors how the real SDK exports `Anthropic`: the
 * (empty) class provides the runtime value so the named import resolves
 * headlessly, and the merged namespace provides the type surface the vendored
 * converters rely on (`Anthropic.Tool`, `Anthropic.Tool.InputSchema`,
 * `Anthropic.Messages.MessageCreateParams`, text/image block params).
 *
 * See VENDOR-NOTES.md.
 */

export class Anthropic {}

export namespace Anthropic {
	export namespace Messages {
		export interface MessageCreateParams {
			tool_choice?:
				| "auto"
				| "any"
				| "tool"
				| { type: "auto" | "any" | "tool"; name?: string; disable_parallel_tool_use?: boolean }
				| null
		}
	}

	export interface Tool {
		name: string
		description?: string
		input_schema: {
			type: "object"
			properties?: Record<string, unknown>
			required?: string[]
			additionalProperties?: boolean
			[key: string]: unknown
		}
		[key: string]: unknown
	}

	export namespace Tool {
		export interface InputSchema {
			type: "object"
			properties?: Record<string, unknown>
			required?: string[]
			additionalProperties?: boolean
			[key: string]: unknown
		}
	}

	export interface TextBlockParam {
		type: "text"
		text: string
	}

	export interface ImageBlockParam {
		type: "image"
		source: {
			type: "base64" | "url"
			media_type?: string
			data?: string
			url?: string
		}
	}
}

export default Anthropic
