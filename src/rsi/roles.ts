import { DEFAULT_RSI_MODEL } from "./config.js"
import { openRouterProfileForModel, RSI_DEFAULT_OPENROUTER_PROFILE_ID } from "./inference-broker.js"
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
		const openRouterProfile = env[`${prefix}OPENROUTER_PROFILE`]?.trim()
		if (provider && !["ollama", "openrouter", "command"].includes(provider)) throw new Error(`${prefix}PROVIDER must be ollama, openrouter, or command`)
		if (openRouterProfile && role !== "worker") throw new Error(`${prefix}OPENROUTER_PROFILE is supported only for worker jobs`)
		if (openRouterProfile && !(openRouterProfile === "deepseek-deepinfra-fp8" || openRouterProfile === "muse-spark-contributor")) throw new Error(`${prefix}OPENROUTER_PROFILE is not an admitted RSI profile`)
		if (model || provider || baseUrl || command || openRouterProfile) {
			roles[role] = {
				...(roles[role] ?? { provider: "ollama" as const, model: workerModel }),
				...(model ? { model } : {}),
				...(provider ? { provider: provider as RoleModelConfig["provider"] } : {}),
				...(baseUrl ? { baseUrl } : {}),
				...(command ? { command } : {}),
				...(openRouterProfile ? { openRouterProfile: openRouterProfile as NonNullable<RoleModelConfig["openRouterProfile"]> } : {}),
			}
		}
	}
	const worker = roles.worker
	if (worker?.provider === "openrouter") {
		const profile = openRouterProfileForModel(worker.model, worker.openRouterProfile)
		if (profile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID || worker.openRouterProfile) roles.worker = { ...worker, openRouterProfile: profile.id }
	} else if (worker?.openRouterProfile) {
		throw new Error("HEADLESSCODE_RSI_ROLE_WORKER_OPENROUTER_PROFILE requires the OpenRouter worker provider")
	}
	return roles
}
