import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import {
	CURL_EVALUATOR_DIGEST,
	CURL_FIXED_ADVISORY,
	CURL_CAMPAIGN_ID,
	CURL_PRIVATE_SOURCE_REVISION,
	CURL_PROFILE_ID,
	CURL_WORKER_DIGEST,
} from "./repository-curl-evaluator.js"
import {
	CURL_DEBIAN_AFFECTED_RANGE,
	CURL_DEBIAN_FIXED_REVISION,
	CURL_DEBIAN_INTRODUCED_REVISION,
	CURL_DEBIAN_SNAPSHOT_SHA256,
	CURL_DEBIAN_SOURCE_HTML_SHA256,
	CURL_DEBIAN_SOURCE_URL,
} from "./repository-known-advisory.js"

export const MODEL = "meta/muse-spark-1.3-contributor"
export const PROFILE_ID = "muse-spark-contributor"
export const REPOSITORY_ID = CURL_CAMPAIGN_ID
export const REPOSITORY = "Capsize-Games/curl-maintenance"
export const WORKER_PROFILE = "curl-published-advisory-v1"
export const CURL_PRIVATE_SOURCE_ROOT = path.join(
	os.homedir(),
	".local",
	"share",
	"headlesscode",
	"repository-sources",
	"curl-maintenance",
)
export const CONTAINED_RUNTIME_ROOT = path.join(
	os.homedir(),
	".local",
	"state",
	"headlesscode",
	"repository-runtime",
)
export const EVIDENCE_STORAGE_DIR = path.join(CONTAINED_RUNTIME_ROOT,
	"evidence-store")
export const EVIDENCE_CONFIG_DIR = path.join(CONTAINED_RUNTIME_ROOT,
	"evidence-config")
export const EVIDENCE_SOCKET_DIRECTORY = path.join(CONTAINED_RUNTIME_ROOT,
	"evidence-socket")
export const EVIDENCE_SOCKET_PATH = path.join(EVIDENCE_SOCKET_DIRECTORY,
	"evidence.sock")
const RUNTIME_UID = typeof process.getuid === "function"
	? process.getuid()
	: "unknown"
const RUNTIME_USER_DIR = `/run/user/${RUNTIME_UID}`
export const PROFILE_PATH = path.join(CONTAINED_RUNTIME_ROOT, "profile",
	"repository-worker.yaml")
export const CONTROL_STATE_DIR = path.join(CONTAINED_RUNTIME_ROOT,
	"control-state")
export const CONTROL_SOCKET_DIR = path.join(
	RUNTIME_USER_DIR, "hcctl", "{session}",
)
export const OPEN_SHELL_XDG_CONFIG_HOME = path.join(
	"/home/joe/Projects/headlesscode", ".worktrees/ux/.headlesscode",
	"scratch/rsi-muse/xdg-user",
)
export const OPEN_SHELL_XDG_STATE_HOME = path.join(
	"/home/joe/Projects/headlesscode", ".worktrees/ux/.headlesscode",
	"scratch/rsi-muse/xdg-state",
)
export const CURL_RUNTIME_CONFIG_PATH = path.join(CONTAINED_RUNTIME_ROOT,
	"runtime.json")
export const MAX_LIFETIME_MICROS = 20_000
export const MAX_LIFETIME_TOKENS = 108_000
export const MAX_JOB_MICROS = 8_000
export const MAX_JOB_TOKENS = 72_000
export const CURL_PRIVATE_BOARD_CARD_ID = "1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7"
export const CURL_PRIVATE_BOARD_API_URL = "http://127.0.0.1:8078/api"

export const CURL_CAMPAIGN_POLICY = Object.freeze({
	schemaVersion: 1,
	campaignId: CURL_CAMPAIGN_ID,
	repositoryId: REPOSITORY_ID,
	repository: REPOSITORY,
	sourceRevision: CURL_PRIVATE_SOURCE_REVISION,
	advisory: Object.freeze({
		id: CURL_FIXED_ADVISORY,
		sourceUrl: CURL_DEBIAN_SOURCE_URL,
		snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256,
		sourceHtmlSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
		introducedRevision: CURL_DEBIAN_INTRODUCED_REVISION,
		fixedRevision: CURL_DEBIAN_FIXED_REVISION,
		affectedRange: CURL_DEBIAN_AFFECTED_RANGE,
	}),
	model: MODEL,
	profileId: PROFILE_ID,
	workerProfile: WORKER_PROFILE,
	dataAccessProfile: "public-upstream-source-and-published-advisory-only",
	executionKind: "live-cve",
	jobPurpose: "qualification-only",
	recipeDigest: CURL_WORKER_DIGEST,
	evaluatorDigest: CURL_EVALUATOR_DIGEST,
	privateDelivery: "job-bound-local-receipt-and-agent-board-comment",
	privateBoardCardId: CURL_PRIVATE_BOARD_CARD_ID,
	limits: Object.freeze({
		lifetimeMicros: MAX_LIFETIME_MICROS,
		lifetimeTokens: MAX_LIFETIME_TOKENS,
		jobMicros: MAX_JOB_MICROS,
		jobTokens: MAX_JOB_TOKENS,
		maxCalls: 2,
		maxInputTokensPerCall: 32_000,
		maxOutputTokensPerCall: 4_000,
		maxInputPricePerMillionUsd: 0.1,
		maxOutputPricePerMillionUsd: 0.2,
		maxCallSpendMicros: 4_000,
		maxJobSpendMicros: MAX_JOB_MICROS,
		maxDurationMs: 840_000,
	}),
})

export const CURL_CAMPAIGN_POLICY_SHA256 = createHash("sha256")
	.update(JSON.stringify(CURL_CAMPAIGN_POLICY))
	.digest("hex")
export const CURL_PRIVATE_RUNTIME_ADAPTER_ID = "curl-92390-private-runtime-v1"
