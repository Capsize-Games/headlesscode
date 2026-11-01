const ACTIONS: readonly string[] = [
	"status", "rsi", "on", "off", "budget", "tick", "serve",
	"qualify-known", "retry-no-call", "repair-known", "repair-known-v2",
	"retry-repair", "recover-no-call", "reconcile-paid-qualification",
	"_apply", "_adapter-tick", "_repository-run-begin",
	"_repository-run-finish", "_repository-lock-hold",
]

const COMMANDS = [
	"status|rsi|on|off|budget --usd <amount>|tick|serve",
	"qualify-known curl-maintenance CVE-2026-92390 --purpose=qualification",
	"retry-no-call curl-maintenance <failed-job-id> " +
		"--confirm-retry-no-call=<failed-job-id>",
	"repair-known curl-historical-repair CVE-2026-92390 --purpose=repair",
	"repair-known-v2 curl-historical-repair-v2 CVE-2026-92390 --purpose=repair",
	"retry-repair curl-historical-repair <failed-job-id> " +
		"--confirm-retry-repair=<failed-job-id>",
	"recover-no-call curl-maintenance <job-id> --confirm-no-call-proof=<job-id>",
	"reconcile-paid-qualification curl-maintenance <job-id> " +
		"--confirm-partial-billing=<job-id>",
]

export function isCampaignAction(action: string): boolean {
	return ACTIONS.includes(action)
}

export function campaignUsage(): string {
	return `Usage: headlesscode campaign <${COMMANDS.join("|")}> [--json]`
}
