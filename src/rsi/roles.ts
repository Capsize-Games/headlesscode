import { DEFAULT_RSI_MODEL } from "./config.js"
import type { ModelRole, RsiRoleConfig, RoleModelConfig } from "./types.js"

const ROLE_ENV_NAMES: ModelRole[] = [
	"worker",
	"mutation-architect",
	"failure-analyst",
	"critic",
	"adversary",
	"reviewer",
	"curriculum-designer",
	"training-data-curator",
]

function envKey(role: ModelRole): string {
	return `HEADLESSCODE_RSI_ROLE_${role.toUpperCase().replace(/-/g, "_")}_MODEL`
}

export function defaultRoles(workerModel = DEFAULT_RSI_MODEL): RsiRoleConfig {
	return { worker: { provider: "ollama", model: workerModel } }
}

export function resolveRoles(
	configured: RsiRoleConfig | undefined,
	env: NodeJS.ProcessEnv = process.env,
	workerModel = DEFAULT_RSI_MODEL,
): RsiRoleConfig {
	const roles: RsiRoleConfig = { ...defaultRoles(workerModel), ...configured }
	for (const role of ROLE_ENV_NAMES) {
		const model = env[envKey(role)]
		const prefix = `HEADLESSCODE_RSI_ROLE_${role.toUpperCase().replace(/-/g, "_")}_`
		const provider = env[`${prefix}PROVIDER`]?.trim()
		const baseUrl = env[`${prefix}BASE_URL`]?.trim()
		const command = env[`${prefix}COMMAND`]?.trim()
		if (provider && !["ollama", "openrouter", "command"].includes(provider)) throw new Error(`${prefix}PROVIDER must be ollama, openrouter, or command`)
		if (model || provider || baseUrl || command) {
			roles[role] = {
				...(roles[role] ?? { provider: "ollama" as const, model: workerModel }),
				...(model ? { model } : {}),
				...(provider ? { provider: provider as RoleModelConfig["provider"] } : {}),
				...(baseUrl ? { baseUrl } : {}),
				...(command ? { command } : {}),
			}
		}
	}
	return roles
}
