import type OpenAI from "openai"

const description = "Read one text reference file captured inside a listed skill directory. Use only when a skill instruction links to a relevant file. Paths are relative to that skill and cannot escape it."

export default {
	type: "function",
	function: {
		name: "read_skill_reference",
		description,
		parameters: {
				type: "object",
			properties: {
				skill: { type: "string", description: "Exact skill name from AVAILABLE SKILLS" },
				path: { type: "string", description: "Relative path within that skill directory" },
			},
			required: ["skill", "path"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
