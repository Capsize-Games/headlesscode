import * as os from "node:os"
import * as path from "node:path"

export const CAMPAIGN_CONTROL_ROOT = path.join(os.homedir(), ".local", "share", "headlesscode", "campaign-control")
export const CAMPAIGN_CONTROL_FILE = path.join(CAMPAIGN_CONTROL_ROOT, "control.json")
export const CAMPAIGN_ADAPTER_FILE = path.join(CAMPAIGN_CONTROL_ROOT, "fleet-adapter.json")
export const REPOSITORY_CAMPAIGN_STATE_FILE = path.join(CAMPAIGN_CONTROL_ROOT, "repository-campaigns.json")
export const REPOSITORY_CAMPAIGN_REGISTRY_FILE = path.join(CAMPAIGN_CONTROL_ROOT, "repository-registry.json")
export const REPOSITORY_WORKER_REGISTRY_FILE = path.join(CAMPAIGN_CONTROL_ROOT, "repository-workers.json")
