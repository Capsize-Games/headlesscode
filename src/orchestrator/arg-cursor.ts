/** Shared argv cursor for orchestrator subcommand parsers. */

export interface ArgCursor {
	arg: string
	flag: string
	inlineValue: string | undefined
	next(): string | undefined
	nextRaw(): string | undefined
}

function readNext(
	argv: string[],
	i: number,
	inlineValue: string | undefined,
	advance: () => void,
): string | undefined {
	if (inlineValue !== undefined) {
		return inlineValue
	}
	const v = argv[i + 1]
	if (v === undefined || v.startsWith("--")) {
		return undefined
	}
	advance()
	return v
}

function readNextRaw(
	argv: string[],
	i: number,
	inlineValue: string | undefined,
	advance: () => void,
): string | undefined {
	if (inlineValue !== undefined) {
		return inlineValue
	}
	const v = argv[i + 1]
	if (v === undefined) {
		return undefined
	}
	advance()
	return v
}

export function createArgCursor(
	argv: string[],
	i: number,
	advance: () => void,
): ArgCursor {
	const arg = argv[i] ?? ""
	const eq = arg.indexOf("=")
	const flag = eq === -1 ? arg : arg.slice(0, eq)
	const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
	const next = (): string | undefined =>
		readNext(argv, i, inlineValue, advance)
	const nextRaw = (): string | undefined =>
		readNextRaw(argv, i, inlineValue, advance)
	return { arg, flag, inlineValue, next, nextRaw }
}
