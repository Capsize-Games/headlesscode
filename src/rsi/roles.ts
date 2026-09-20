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
		if (model) {
			const existing = roles[role]
			roles[role] = { ...(existing ?? { provider: "ollama" }), model } as RoleModelConfig
		}
	}
	return roles
}
