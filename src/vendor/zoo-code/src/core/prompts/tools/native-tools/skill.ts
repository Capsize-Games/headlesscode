import type OpenAI from "openai"

const SKILL_DESCRIPTION = `Load the captured instructions for one relevant skill. This returns text only; it does not run scripts, add tools, change modes or permissions, or bypass evidence and security checks. Available skills are listed in AVAILABLE SKILLS.`

const SKILL_PARAMETER_DESCRIPTION = `Exact name of one skill from AVAILABLE SKILLS.`

const ARGS_PARAMETER_DESCRIPTION = `Optional short task context for the skill; this is not executed as a command.`

export default {
	type: "function",
	function: {
		name: "skill",
		description: SKILL_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				skill: {
					type: "string",
					description: SKILL_PARAMETER_DESCRIPTION,
				},
				args: {
					type: ["string", "null"],
					description: ARGS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["skill", "args"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
