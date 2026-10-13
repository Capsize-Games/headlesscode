/** Shared --issue/--pr/--group target parsing for resume.ts mains. */

export interface ResumeTarget {
	issue?: number
	pr?: number
	group?: string
}

/** One of --issue/--pr/--group is set (never more than one). */
export function hasExactlyOneTarget(t: ResumeTarget): boolean {
	const n = (t.issue !== undefined ? 1 : 0)
		+ (t.pr !== undefined ? 1 : 0)
		+ (t.group !== undefined ? 1 : 0)
	return n === 1
}

/** Split "--flag=value" into its flag and inline value parts. */
export function splitFlag(arg: string): {
	flag: string
	inline: string | undefined
} {
	const eq = arg.indexOf("=")
	if (eq === -1) {
		return { flag: arg, inline: undefined }
	}
	return { flag: arg.slice(0, eq), inline: arg.slice(eq + 1) }
}

/** Take an option value: inline first, else the next argv entry. */
export function takeValue(
	argv: string[],
	i: number,
	inline: string | undefined,
): { value: string | undefined; consumed: number } {
	if (inline !== undefined) {
		return { value: inline, consumed: 0 }
	}
	const v = argv[i + 1]
	if (v === undefined || v.startsWith("--")) {
		return { value: undefined, consumed: 0 }
	}
	return { value: v, consumed: 1 }
}

/** True for the three target-selection flags. */
export function isTargetFlag(flag: string): boolean {
	if (flag === "--issue") {
		return true
	}
	if (flag === "--pr") {
		return true
	}
	return flag === "--group"
}

function rejectUnlessSingle(t: ResumeTarget): string | undefined {
	if (hasExactlyOneTarget(t)) {
		return "provide exactly one of --issue, --pr, --group"
	}
	return undefined
}

function assignIssueTarget(
	t: ResumeTarget,
	raw: string | undefined,
): string | undefined {
	const n = raw === undefined ? Number.NaN : Number(raw)
	if (!Number.isInteger(n) || n <= 0) {
		return "--issue requires a positive integer"
	}
	const conflict = rejectUnlessSingle(t)
	if (conflict) {
		return conflict
	}
	t.issue = n
	return undefined
}

function assignPrTarget(
	t: ResumeTarget,
	raw: string | undefined,
): string | undefined {
	const n = raw === undefined ? Number.NaN : Number(raw)
	if (!Number.isInteger(n) || n <= 0) {
		return "--pr requires a positive integer"
	}
	const conflict = rejectUnlessSingle(t)
	if (conflict) {
		return conflict
	}
	t.pr = n
	return undefined
}

function assignGroupTarget(
	t: ResumeTarget,
	raw: string | undefined,
): string | undefined {
	if (raw === undefined || raw === "") {
		return "--group requires a non-empty group name"
	}
	const conflict = rejectUnlessSingle(t)
	if (conflict) {
		return conflict
	}
	t.group = raw
	return undefined
}

/** Apply one target flag; returns the error when rejected. */
export function applyTargetFlag(
	t: ResumeTarget,
	flag: string,
	raw: string | undefined,
): string | undefined {
	if (flag === "--issue") {
		return assignIssueTarget(t, raw)
	}
	if (flag === "--pr") {
		return assignPrTarget(t, raw)
	}
	return assignGroupTarget(t, raw)
}

interface TargetScan {
	target: ResumeTarget
	rest: string[]
	error?: string
}

/** Process one argv entry, advancing the index past a consumed value. */
function scanOneArg(argv: string[], i: number, scan: TargetScan): number {
	const { flag, inline } = splitFlag(argv[i] ?? "")
	if (!isTargetFlag(flag)) {
		scan.rest.push(argv[i] ?? "")
		return i
	}
	const taken = takeValue(argv, i, inline)
	const flagError = applyTargetFlag(scan.target, flag, taken.value)
	if (flagError) {
		scan.error = flagError
	}
	return i + taken.consumed
}

/** Extract --issue/--pr/--group; the rest is returned untouched. */
export function parseTargetArgs(argv: string[]): {
	rest: string[]
	target: ResumeTarget
	error?: string
} {
	const scan: TargetScan = { target: {}, rest: [] }
	for (let i = 0; i < argv.length; i++) {
		i = scanOneArg(argv, i, scan)
	}
	return scan
}

/** Human-readable target description for error messages. */
export function describeTarget(target: ResumeTarget): string {
	if (target.issue !== undefined) {
		return `issue #${target.issue}`
	}
	if (target.pr !== undefined) {
		return `PR #${target.pr}`
	}
	if (target.group !== undefined) {
		return `group "${target.group}"`
	}
	return "(none)"
}

function missingIntFlag(
	flag: string,
): { value: number | undefined; error?: string; consumed: number } {
	return { value: undefined, error: `Missing value for ${flag}`, consumed: 0 }
}

function invalidIntFlag(
	flag: string,
	consumed: number,
): { value: number | undefined; error?: string; consumed: number } {
	const msg = `${flag} requires a positive integer`
	return { value: undefined, error: msg, consumed }
}

/** Parse a positive-integer flag in spaced or --flag=value form. */
export function parseIntFlag(
	argv: string[],
	i: number,
	flag: string,
): { value: number | undefined; error?: string; consumed: number } {
	const { inline } = splitFlag(argv[i] ?? "")
	const taken = takeValue(argv, i, inline)
	if (taken.value === undefined) {
		return missingIntFlag(flag)
	}
	const n = Number(taken.value)
	if (!Number.isInteger(n) || n <= 0) {
		return invalidIntFlag(flag, taken.consumed)
	}
	return { value: n, consumed: taken.consumed }
}
