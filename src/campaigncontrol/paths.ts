import * as os from "node:os"
import * as path from "node:path"

export const CAMPAIGN_CONTROL_ROOT = path.join(
	os.homedir(), ".local", "share", "headlesscode", "campaign-control",
)

function controlFile(name: string): string {
	return path.join(CAMPAIGN_CONTROL_ROOT, name)
}

export const CAMPAIGN_CONTROL_FILE = controlFile("control.json")
export const CAMPAIGN_ADAPTER_FILE = controlFile("fleet-adapter.json")
export const REPOSITORY_CAMPAIGN_STATE_FILE = controlFile(
	"repository-campaigns.json",
)
export const REPOSITORY_CAMPAIGN_REGISTRY_FILE = controlFile(
	"repository-registry.json",
)
export const REPOSITORY_WORKER_REGISTRY_FILE = controlFile(
	"repository-workers.json",
)
