/**
 * Command allow/deny decision logic for the headless harness — a faithful port
 * of Zoo Code's auto-approval command gating.
 *
 * Ported (with attribution) from the reference tree (read-only):
 *   zoo-code/src/shared/parse-command.ts           — `parseCommand` (compound
 *     command splitting on &&/||/;/|/& + unterminated-quote detection)
 *   zoo-code/src/core/auto-approval/commands.ts    — `containsDangerousSubstitution`,
 *     `findLongestPrefixMatch`, `getSingleCommandDecision`, `getCommandDecision`
 *
 * The vendored copy under src/vendor/zoo-code/ does NOT include these files;
 * the reference lives at the repo-root `zoo-code/` tree.
 *
 * Verified precedence in the reference logic (do not assume; this is what the
 * vendored code actually does):
 *
 * 1. `getCommandDecision` splits the command with `parseCommand`, then checks
 *    each sub-command with `getSingleCommandDecision`. **If ANY sub-command is
 *    denied, the whole command is denied** (`decisions.includes("auto_deny")`
 *    → `"auto_deny"`) — deny wins over allow at the compound-command level.
 * 2. Dangerous substitutions (`containsDangerousSubstitution`) are NEVER
 *    auto-approved — upstream maps them to `"ask_user"` (a human must decide).
 * 3. For a single command, allow-vs-deny conflicts use LONGEST-PREFIX-MATCH:
 *    the longer (more specific) pattern wins; a TIE goes to deny
 *    (`longestAllowedMatch.length > longestDeniedMatch.length ? approve : deny`).
 * 4. No match at all → `"ask_user"`.
 *
 * Headless translation (our layer, on top of the port):
 * - A headless harness has no human to prompt for `"ask_user"`, so it is
 *   refused (deny). Dangerous substitution ⇒ deny unconditionally, regardless
 *   of config.
 * - DEFAULT-ALLOW decision (deliberate, documented in plans/permissions-parity.md
 *   and the completion report): an EMPTY `allowedCommands` list means "allow
 *   everything except the deny-list" — backward compatible with the
 *   pre-permissions harness. `deniedCommands` always applies. Only when an
 *   allow-list is explicitly configured does "not on the allow-list" mean deny.
 * - CENTRAL-STORE PROTECTION (always-applied, NOT configurable): a recursive
 *   `rm` whose resolved target is the shared central store root
 *   (~/.local/share/headlesscode) or a parent of it is refused EVEN with an
 *   empty allow/deny config — the default-allow branch must never bypass it.
 *   This is a pattern-based speed bump against the exact incident documented
 *   in plans/protect-shared-store-from-destructive-commands.md, not a
 *   sandbox; see src/permissions/store-protection.ts for the honest scope.
 *   Per-workspace permissions.json cannot override it (the whole point is
 *   protecting the SHARED resource from any single workspace).
 * - REDIRECT-ESCAPE PROTECTION (always-applied, NOT configurable, issue #122):
 *   an output redirect (`>`, `>>`, `2>`, `2>>`, `&>`, `&>>`) whose resolved
 *   target escapes the workspace root is refused EVEN with an empty allow/deny
 *   config. This closes the same-class hole the rules doc calls out in
 *   .roo/rules/rules.md: shell redirects to `/tmp` previously slipped through
 *   the command-string allow/deny gate even though every file tool rejects
 *   outside-workspace paths. Pattern-based like the store check — a script
 *   that writes outside the workspace via a non-redirect mechanism (e.g.
 *   `python -c "open('/tmp/x','w')"`) is out of scope; see
 *   redirectTargets/checkRedirectEscape below.
 * - CD-ESCAPE + WRITE-OPERAND PROTECTION (always-applied, NOT configurable,
 *   issue #136): a `cd`/`pushd` outside the workspace, or a file-writing
 *   operand (cp/mv/ln/install/rsync/scp destination, `tee` output, `git`
 *   repo pointer, `tar`/`sed -i`/`curl`/`wget` output, shell script file)
 *   outside the workspace, is refused. The cd guard is load-bearing: an
 *   outside-cd re-anchors every later relative path, defeating the other
 *   guards. Same honest scope as above (sudo/ssh/xargs/script contents
 *   are boundaries); see checkCdEscape/checkWriteOperandEscape below.
 *
 * `parseCommand` is ported WITHOUT the `shell-quote` dependency (not present in
 * this repo's node_modules): quoted strings, arithmetic, parameter expansions,
 * process substitutions, redirections and variables are all masked into
 * placeholder tokens BEFORE splitting (identical masking order to the
 * reference), so splitting the masked string on the chain operators and on
 * top-level subshell placeholders is behaviorally equivalent to the
 * reference's shell-quote token walk (which splits on exactly those operator
 * tokens and promotes subshell contents to their own sub-command). The quote
 * state machine (single/double/ANSI-C/locale/heredoc + comments) is ported
 * verbatim.
 */

import * as os from "node:os"
import * as path from "node:path"

import {
	type ChainEnv,
	checkCentralStoreDestruction,
	expandOperandWord,
	harvestSubAssignments,
	newChainEnv,
	prePoisonRawAssignments,
	resolveOperandTarget,
	splitCommandWords,
	usesPoisonedVar,
} from "./store-protection.js"

// ─── parseCommand port (zoo-code/src/shared/parse-command.ts) ───────────────

/**
 * The style of quoting that opened a region (see the reference file for the
 * full rationale; kept identical so masking behaves the same).
 */
export type QuoteType = "posix-single" | "ansi-c" | "double" | "locale" | "heredoc"

/** Describes the opening of a quoted region that is never closed. */
export interface UnterminatedQuote {
	quoteType: QuoteType
	/** Index in the original command string of the character that opened the region. */
	openIndex: number
	/** Human-readable description suitable for surfacing to an agent as a tool error. */
	message: string
}

/**
 * The result of parsing a command string. `commands` is the list of individual
 * sub-commands produced by splitting on unquoted newlines and chain operators.
 * When `parseError` is non-null the command string is syntactically malformed
 * (e.g. an unterminated quote) and `commands` contains the raw input as a
 * single opaque token so callers can surface the error without splitting
 * unsafe fragments.
 */
export interface ParseResult {
	commands: string[]
	parseError: UnterminatedQuote | null
}

function unterminatedQuoteMessage(quoteType: QuoteType, openIndex: number, command: string): string {
	const labels: Record<QuoteType, string> = {
		"posix-single": "single quote (')",
		"ansi-c": "ANSI-C quote ($')",
		double: 'double quote (")',
		locale: 'locale quote ($")',
		heredoc: "heredoc (<<)",
	}
	const snippetStart = Math.max(0, openIndex - 10)
	const snippetEnd = Math.min(command.length, openIndex + 20)
	const prefix = snippetStart > 0 ? "..." : ""
	const suffix = snippetEnd < command.length ? "..." : ""
	const excerpt = prefix + command.slice(snippetStart, snippetEnd).replace(/\r?\n/g, "\\n") + suffix
	return `Malformed command: unterminated ${labels[quoteType]} at position ${openIndex} -- near: \`${excerpt}\`. `
}

/** A contiguous quoted region found at the top level of a command string. */
interface QuoteSpan {
	/** Index of the first character of the opening delimiter (e.g. `$` for `$'...'`). */
	start: number
	/** Index one past the last character of the closing delimiter. */
	end: number
	/** The style of quoting. */
	quoteType: QuoteType
}

/** Result returned by the single shared state-machine walk. */
interface ScanResult {
	spans: QuoteSpan[]
	unterminatedQuote: UnterminatedQuote | null
}

/**
 * Parse a heredoc delimiter word starting at position `start` in `command`
 * (unquoted / 'EOF' / "EOF" / \EOF — see the reference for the rules).
 */
function parseHeredocDelimiter(command: string, start: number): { delimiter: string; endIndex: number } {
	let i = start
	let delimiter = ""

	if (command[i] === "'") {
		i++
		while (i < command.length && command[i] !== "'" && command[i] !== "\n") {
			delimiter += command[i++]
		}
		if (command[i] === "'") i++
	} else if (command[i] === '"') {
		i++
		while (i < command.length && command[i] !== '"' && command[i] !== "\n") {
			delimiter += command[i++]
		}
		if (command[i] === '"') i++
	} else if (command[i] === "\\") {
		i++
		while (i < command.length && command[i] !== "\n" && command[i] !== " " && command[i] !== "\t") {
			delimiter += command[i++]
		}
	} else {
		while (i < command.length && command[i] !== "\n" && command[i] !== " " && command[i] !== "\t") {
			delimiter += command[i++]
		}
	}

	return { delimiter, endIndex: i }
}

/**
 * Single shared state-machine walk used by `parseCommand`: identifies every
 * top-level quoted region (outside other quotes and `#` comments) and reports
 * the first unterminated one. Ported verbatim from the reference.
 */
function scanTopLevelQuotes(command: string): ScanResult {
	const spans: QuoteSpan[] = []
	let i = 0

	while (i < command.length) {
		const char = command[i]

		if (char === "\\") {
			i += 2
			continue
		}

		if (char === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
			while (i < command.length && command[i] !== "\n" && command[i] !== "\r") {
				i++
			}
			continue
		}

		// Herestring (<<<): single-line stdin redirect — no body or terminator.
		if (char === "<" && command[i + 1] === "<" && command[i + 2] === "<") {
			i += 3
			continue
		}

		// Heredoc opener: <<[-]? followed by an optional-quoted delimiter word.
		if (char === "<" && command[i + 1] === "<") {
			const start = i
			i += 2
			const stripTabs = command[i] === "-"
			if (stripTabs) i++
			while (i < command.length && (command[i] === " " || command[i] === "\t")) {
				i++
			}
			const { delimiter, endIndex } = parseHeredocDelimiter(command, i)
			i = endIndex
			while (i < command.length && command[i] !== "\n") i++
			if (i < command.length) i++
			if (delimiter.length > 0) {
				let found = false
				while (i < command.length) {
					const lineStart = i
					while (i < command.length && command[i] !== "\n" && command[i] !== "\r") {
						i++
					}
					const rawLine = command.slice(lineStart, i)
					const line = stripTabs ? rawLine.replace(/^\t*/, "") : rawLine
					if (line === delimiter) {
						found = true
						break
					}
					if (i < command.length) i++
				}
				if (!found) {
					return {
						spans,
						unterminatedQuote: {
							quoteType: "heredoc",
							openIndex: start,
							message: unterminatedQuoteMessage("heredoc", start, command),
						},
					}
				}
			}
			spans.push({ start, end: i, quoteType: "heredoc" })
			continue
		}

		// ANSI-C quoting: $'...', escape-aware.
		if (char === "$" && command[i + 1] === "'") {
			const start = i
			i += 2
			let closed = false
			while (i < command.length) {
				if (command[i] === "\\") {
					i += 2
				} else if (command[i] === "'") {
					i++
					closed = true
					break
				} else {
					i++
				}
			}
			if (!closed) {
				return {
					spans,
					unterminatedQuote: {
						quoteType: "ansi-c",
						openIndex: start,
						message: unterminatedQuoteMessage("ansi-c", start, command),
					},
				}
			}
			spans.push({ start, end: i, quoteType: "ansi-c" })
			continue
		}

		// Locale quoting: $"...", escape-aware like double quotes.
		if (char === "$" && command[i + 1] === '"') {
			const start = i
			i += 2
			let closed = false
			while (i < command.length) {
				if (command[i] === "\\") {
					i += 2
				} else if (command[i] === '"') {
					i++
					closed = true
					break
				} else {
					i++
				}
			}
			if (!closed) {
				return {
					spans,
					unterminatedQuote: {
						quoteType: "locale",
						openIndex: start,
						message: unterminatedQuoteMessage("locale", start, command),
					},
				}
			}
			spans.push({ start, end: i, quoteType: "locale" })
			continue
		}

		// POSIX single quote: fully opaque, ends at the next literal '.
		if (char === "'") {
			const start = i
			i++
			while (i < command.length && command[i] !== "'") {
				i++
			}
			if (i >= command.length) {
				return {
					spans,
					unterminatedQuote: {
						quoteType: "posix-single",
						openIndex: start,
						message: unterminatedQuoteMessage("posix-single", start, command),
					},
				}
			}
			i++
			spans.push({ start, end: i, quoteType: "posix-single" })
			continue
		}

		// Double quote: escape-aware, ends at the next unescaped ".
		if (char === '"') {
			const start = i
			i++
			let closed = false
			while (i < command.length) {
				if (command[i] === "\\") {
					i += 2
				} else if (command[i] === '"') {
					i++
					closed = true
					break
				} else {
					i++
				}
			}
			if (!closed) {
				return {
					spans,
					unterminatedQuote: {
						quoteType: "double",
						openIndex: start,
						message: unterminatedQuoteMessage("double", start, command),
					},
				}
			}
			spans.push({ start, end: i, quoteType: "double" })
			continue
		}

		i++
	}

	return { spans, unterminatedQuote: null }
}

/**
 * Walk `command` and replace every top-level quoted region with a placeholder
 * token. Returns the masked string and the array of original quoted substrings
 * so callers can restore them later. Ported verbatim from the reference.
 */
function maskTopLevelQuotes(command: string): { masked: string; quotes: string[] } {
	const { spans, unterminatedQuote } = scanTopLevelQuotes(command)

	const effectiveSpans: QuoteSpan[] =
		unterminatedQuote !== null
			? [
					...spans,
					{ start: unterminatedQuote.openIndex, end: command.length, quoteType: unterminatedQuote.quoteType },
				]
			: spans

	const quotes: string[] = []
	let result = ""
	let pos = 0

	for (const span of effectiveSpans) {
		result += command.slice(pos, span.start)
		quotes.push(command.slice(span.start, span.end))
		result += `__TOPLEVEL_QUOTE_${quotes.length - 1}__`
		pos = span.end
	}

	result += command.slice(pos)

	return { masked: result, quotes }
}

/**
 * Split a command string into individual sub-commands by chaining operators
 * (&&, ||, ;, |, &) and unquoted newlines, preserving quoted strings (including
 * multi-line quoted strings) as atomic units. Returns the sub-command list and
 * an optional parse error for unterminated quotes/heredocs. Ported from the
 * reference; the shell-quote tokenization step is replaced by an equivalent
 * operator split (see the module header).
 */
export function parseCommand(command: string): ParseResult {
	if (!command?.trim()) {
		return { commands: [], parseError: null }
	}

	const { unterminatedQuote } = scanTopLevelQuotes(command)

	if (unterminatedQuote !== null) {
		return { commands: [command], parseError: unterminatedQuote }
	}

	// Pre-escape literal __ sequences so they cannot collide with the internal
	// placeholder tokens. \x00 (the null byte) cannot appear in a real shell
	// command, so it is a safe sentinel; the post-unescape step reverses it.
	const escapedCommand = command.replace(/__/g, "\x00")

	const { masked, quotes: topLevelQuotes } = maskTopLevelQuotes(escapedCommand)

	const lines = masked.split(/\r\n|\r|\n/)
	const allCommands: string[] = []

	for (const line of lines) {
		if (!line.trim()) {
			continue
		}

		const restoredLine = line.replace(/__TOPLEVEL_QUOTE_(\d+)__/g, (_, i) => topLevelQuotes[parseInt(i)])

		// A restored line with embedded newlines means a top-level quote (e.g. a
		// heredoc) spanned multiple lines — the whole string is one atomic
		// command; re-splitting would break on the embedded newlines/<<.
		if (restoredLine.includes("\n")) {
			allCommands.push(restoredLine)
			continue
		}

		allCommands.push(...parseCommandLine(restoredLine))
	}

	return { commands: allCommands.map((cmd) => cmd.split("\x00").join("__")), parseError: null }
}

/**
 * Parse a single line of commands into sub-commands. The masking pipeline is
 * identical to the reference; the final shell-quote `parse()` call is replaced
 * by a split on chain operators + top-level subshell placeholders (see the
 * module header for why this is equivalent).
 */
function parseCommandLine(command: string): string[] {
	if (!command?.trim()) return []

	const redirections: string[] = []
	const subshells: string[] = []
	const quotes: string[] = []
	const singleQuotes: string[] = []
	const arithmeticExpressions: string[] = []
	const variables: string[] = []
	const parameterExpansions: string[] = []

	// Noclobber redirect operators (`>|`, `>>|`, `&>|`, `&>>|`, with optional
	// fd digits) mask like fd-duplications: their `|` is not a pipe and must
	// not split the sub-command (else `cat >| /tmp/x` splits into `cat >`
	// and `/tmp/x`, and the redirect guard never sees its target).
	const redirMask = /\d*>&\d*|\d*(?:&>>\||&>\||>>\||>\|)/g
	let processedCommand = command.replace(redirMask, (match) => {
		redirections.push(match)
		return `__REDIR_${redirections.length - 1}__`
	})

	processedCommand = processedCommand.replace(/\$\(\([^)]*(?:\)[^)]*)*\)\)/g, (match) => {
		arithmeticExpressions.push(match)
		return `__ARITH_${arithmeticExpressions.length - 1}__`
	})

	processedCommand = processedCommand.replace(/\$\[[^\]]*\]/g, (match) => {
		arithmeticExpressions.push(match)
		return `__ARITH_${arithmeticExpressions.length - 1}__`
	})

	processedCommand = processedCommand.replace(/\$\{[^}]+\}/g, (match) => {
		parameterExpansions.push(match)
		return `__PARAM_${parameterExpansions.length - 1}__`
	})

	processedCommand = processedCommand.replace(/[<>]\(([^)]+)\)/g, (_, inner) => {
		subshells.push(inner.trim())
		return `__SUBSH_${subshells.length - 1}__`
	})

	// Locale quoting: $"...". Must run before variable masking so the leading $
	// is captured as part of the quoted unit (see reference).
	processedCommand = processedCommand.replace(/\$"(?:[^"\\]|\\.)*"/g, (match) => {
		quotes.push(match)
		return `__QUOTE_${quotes.length - 1}__`
	})

	// ANSI-C quoting: $'...'. Same ordering rationale as locale quoting.
	processedCommand = processedCommand.replace(/\$'(?:[^'\\]|\\.)*'/g, (match) => {
		singleQuotes.push(match)
		return `__SQUOTE_${singleQuotes.length - 1}__`
	})

	// Simple variable references: $varname.
	processedCommand = processedCommand.replace(/\$[a-zA-Z_][a-zA-Z0-9_]*/g, (match) => {
		variables.push(match)
		return `__VAR_${variables.length - 1}__`
	})

	// Special bash variables: $?, $!, $#, $$, $@, $*, $-, $0-$9.
	processedCommand = processedCommand.replace(/\$[?!#$@*\-0-9]/g, (match) => {
		variables.push(match)
		return `__VAR_${variables.length - 1}__`
	})

	// Subshell commands $() and back-ticks.
	processedCommand = processedCommand
		.replace(/\$\((.*?)\)/g, (_, inner) => {
			subshells.push(inner.trim())
			return `__SUBSH_${subshells.length - 1}__`
		})
		.replace(/`(.*?)`/g, (_, inner) => {
			subshells.push(inner.trim())
			return `__SUBSH_${subshells.length - 1}__`
		})

	// Mask quoted strings (single + double) so their contents — including
	// operators like &&, |, ; and embedded newlines — are not treated as
	// command separators. Single quotes are fully opaque; double quotes are
	// escape-aware. Matches the reference's alternation exactly.
	processedCommand = processedCommand.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (match) => {
		if (match.startsWith("'")) {
			singleQuotes.push(match)
			return `__SQUOTE_${singleQuotes.length - 1}__`
		}
		quotes.push(match)
		return `__QUOTE_${quotes.length - 1}__`
	})

	// ── Replace the reference's `parse(processedCommand)` (shell-quote) with an
	// equivalent self-contained token walk. Everything that could contain an
	// operator is already masked above, so the only operator-like tokens left
	// are the chain operators and __SUBSH_ placeholders. Tokenizing on
	// whitespace collapses runs exactly like shell-quote's word tokens; chain
	// operators split commands; and a subshell placeholder promotes its content
	// to its own sub-command (mirroring the reference's token walk, including
	// its unanchored __SUBSH_ match). Operators are split out even when attached
	// to a word (`hi;`, `a||b`) — exactly like shell-quote's tokenizer — and
	// whitespace runs collapse to single separators.
	const tokens = processedCommand
		.split(/(\s+|&&|\|\||;|\||&)/)
		.filter((t) => t.length > 0 && !/^\s+$/.test(t))
	const commands: string[] = []
	let current: string[] = []

	for (const token of tokens) {
		if (token === "&&" || token === "||" || token === ";" || token === "|" || token === "&") {
			if (current.length > 0) {
				commands.push(current.join(" "))
				current = []
			}
		} else {
			const subshellMatch = token.match(/__SUBSH_(\d+)__/)
			if (subshellMatch) {
				if (current.length > 0) {
					commands.push(current.join(" "))
					current = []
				}
				commands.push(subshells[parseInt(subshellMatch[1])])
			} else {
				current.push(token)
			}
		}
	}
	if (current.length > 0) {
		commands.push(current.join(" "))
	}

	return commands.map((cmd) =>
		restorePlaceholders(
			cmd,
			quotes,
			singleQuotes,
			redirections,
			arithmeticExpressions,
			parameterExpansions,
			variables,
			subshells,
		),
	)
}

/** Helper function to restore placeholders in a command string (reference). */
function restorePlaceholders(
	command: string,
	quotes: string[],
	singleQuotes: string[],
	redirections: string[],
	arithmeticExpressions: string[],
	parameterExpansions: string[],
	variables: string[],
	subshells: string[],
): string {
	let result = command
	result = result.replace(/__QUOTE_(\d+)__/g, (_, i) => quotes[parseInt(i)])
	result = result.replace(/__SQUOTE_(\d+)__/g, (_, i) => singleQuotes[parseInt(i)])
	result = result.replace(/__REDIR_(\d+)__/g, (_, i) => redirections[parseInt(i)])
	result = result.replace(/__ARITH_(\d+)__/g, (_, i) => arithmeticExpressions[parseInt(i)])
	result = result.replace(/__PARAM_(\d+)__/g, (_, i) => parameterExpansions[parseInt(i)])
	result = result.replace(/__VAR_(\d+)__/g, (_, i) => variables[parseInt(i)])
	result = result.replace(/__SUBSH_(\d+)__/g, (_, i) => subshells[parseInt(i)])
	return result
}

// ─── redirect-target extraction (shell redirects to outside the workspace) ──

/**
 * A redirection found in a command string: the raw `>`-style operator
 * (including an optional numeric fd prefix and `&` for `&>`), the index it
 * starts at, and the word that follows it (the redirect target). Quoted words
 * (e.g. `> "out file.txt"`) arrive with their quotes intact; callers strip
 * them via splitCommandWords, which also removes backslash escapes.
 */
export interface RedirectTarget {
	operator: string
	/** Index in the ORIGINAL command string where the operator starts. */
	index: number
	/** The raw word following the operator (quote-stripped by splitCommandWords). */
	word: string
}

/**
 * Extract the target words of every output redirection in a command string.
 *
 * Recognized operators: `>`, `>>`, `>|` (noclobber), `2>`, `2>>`, `2>|`,
 * `&>`, `&>>`, `&>|` — the alternation is ordered longest-first so `>>` wins
 * over `>`. `<`/`<<`/`<<<` input redirects are deliberately NOT matched —
 * they read from a path instead of writing to it, so they cannot smuggle an
 * outside-workspace WRITE. `2>&1`/`3>&2` fd duplication is not a path
 * redirect: the `&` immediately after the `>` terminates the word, leaving
 * no target, so it is skipped (see parseCommandLine, which masks the same
 * shape).
 *
 * A target word is a shell WORD: unquoted characters up to the next
 * metacharacter (`;`, `|`, `&`, `<`, `>`, whitespace) or a quote/escape that
 * stays part of the word. When the redirect is immediately followed by a
 * metacharacter (`echo hi >;ls`, `echo hi >`), no word exists — the shell
 * errors on the missing operand and no file is created, so nothing is
 * emitted. A quoted target (`> "out file.txt"`, `> '/tmp/x y'`) is emitted
 * with its quotes intact; callers strip them via splitCommandWords.
 */
export function redirectTargets(command: string): RedirectTarget[] {
	const targets: RedirectTarget[] = []
	// Word chars: anything but unquoted shell metacharacters/quotes, plus
	// quoted regions (which may contain metacharacters) and backslash escapes.
	const re =
		/(?:\d*&>>|\d*&>\||\d*&>|\d*>>\||\d*>\||\d*>>|\d*>)(?:\s*)(?:[^\s;|&<>()'"]|"[^"]*"|'[^']*'|\\.)*/g
	let match: RegExpExecArray | null
	while ((match = re.exec(command)) !== null) {
		const raw = match[0]
		if (raw === undefined) {
			continue
		}
		const operatorMatch = raw.match(/^(\d*&>>|\d*&>\||\d*&>|\d*>>\||\d*>\||\d*>>|\d*>)/)
		if (operatorMatch === null) {
			continue
		}
		const operator = operatorMatch[1] ?? raw
		const wordText = raw.slice(operator.length).trimStart()
		if (wordText === "") {
			continue
		}
		const words = splitCommandWords(wordText)
		if (words.length === 0) {
			continue
		}
		targets.push({ operator, index: match.index, word: words[0] })
	}
	return targets
}

/**
 * Resolve a redirect target word to an absolute path, anchored on the command's
 * working directory. Delegates to the shared operand resolver: known vars
 * expand, unknown vars strip (exact — unset vars expand to empty, so
 * `> $U/x` really writes `/x` while bare `> $U` really errors, safe).
 */
export function resolveRedirectTarget(target: string, workspaceRoot: string): string {
	return resolveOperandTarget(target, path.resolve(workspaceRoot))
}

/**
 * True when the resolved redirect target escapes the workspace root — the
 * same lexical containment rule `resolveWithinWorkspace` uses for the file
 * tools (path.resolve prefix check; no symlink following, which matches the
 * store-protection check's documented boundary).
 *
 * `/dev/null` and `/dev/fd/N` are deliberately NOT escapes: they are
 * device/fd-backed targets with no persistent state and cannot leak data
 * outside the workspace, unlike a file redirect.  The agent routinely uses
 * `2>/dev/null` to silence stderr; refusing it makes every otherwise-fine
 * command fail with a redirect-escape error.
 */
export function isOutsideWorkspace(root: string, target: string): boolean {
	if (target === "/dev/null" || /^\/dev\/fd\/\d+$/.test(target)) {
		return false
	}
	const rootAbs = path.resolve(root)
	const t = path.resolve(target)
	if (t === rootAbs) {
		return false
	}
	return !t.startsWith(rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep)
}

/**
 * Check a command for an output redirect escaping the workspace root.
 * Runs the shared ordered walk: relative targets resolve against the
 * tracked cd-chain cwd but containment compares against the workspace
 * root (the old code compared against the post-cd directory, so
 * `cd /tmp && echo hi > x` wrongly passed). Chain exports overlay.
 */
export function checkRedirectEscape(subCommand: string, workspaceRoot?: string): RedirectTarget | null {
	return scanWholeCommand(subCommand, workspaceRoot).redir
}

/** Human-readable operator for the model-facing refusal message. */
export function describeRedirect(target: RedirectTarget): string {
	const compact =
		target.operator.includes("&") || target.operator.includes("|") || /^\d*>>/.test(target.operator)
	return compact ? `${target.operator}${target.word}` : `${target.operator} ${target.word}`
}

// ─── workspace-confinement scans (issue #136) ──
//
// A `cd` outside the workspace re-anchors every later relative path in the
// chain, silently defeating the redirect/operand guards (the SEC-6 tracking
// resolved AND compared against the post-cd directory — always "inside").
// The load-bearing fix is refusing the outside-cd itself; the redirect and
// write-operand scans are backstops for absolute paths. All three scans
// share one ordered sub-command walk so chain exports, cd tracking, and
// first-hit-wins stay consistent between checkCommand and the exported
// single-purpose checks. This is pattern-based, not a sandbox: sudo/su,
// ssh, xargs/find -exec command construction, and script-file CONTENTS are
// documented boundaries (an allowed `sudo` already moots confinement).

export interface CdEscape {
	subCommand: string
	directory: string
	reason?: string
}

export interface WriteOperandEscape {
	subCommand: string
	command: string
	operand: string
	reason?: string
}

export function describeCdEscape(escape: CdEscape): string {
	const base = `cd ${escape.directory}`
	return escape.reason === undefined ? base : `${base} (${escape.reason})`
}

export function describeWriteEscape(escape: WriteOperandEscape): string {
	if (escape.reason !== undefined) {
		return `${escape.command} ${escape.operand}: ${escape.reason}`
	}
	return `${escape.command} writes ${escape.operand}`
}

/** Mutable state for one ordered sub-command walk. `contain` never moves
 * (the workspace root); `cwd` tracks inside-only cds; `env` accumulates
 * chain exports. Forks (subshells, `sh -c`) copy everything but share hits. */
interface ScanCtx {
	contain: string
	cwd: string
	prevCwd: string
	stack: string[]
	env: ChainEnv
}

interface ScanOut {
	cd: CdEscape | null
	op: WriteOperandEscape | null
	redir: RedirectTarget | null
}

function newScanCtx(root: string): ScanCtx {
	const resolved = path.resolve(root)
	return {
		contain: resolved, cwd: resolved, prevCwd: resolved, stack: [],
		env: newChainEnv(),
	}
}

function hasMoreFlags(rest: string[]): boolean {
	return rest.length > 0 && (rest[0] ?? "").startsWith("-") && rest[0] !== "--"
}

function forkScanCtx(ctx: ScanCtx): ScanCtx {
	return {
		contain: ctx.contain,
		cwd: ctx.cwd,
		prevCwd: ctx.prevCwd,
		stack: [...ctx.stack],
		env: { overlay: new Map(ctx.env.overlay), poison: new Set(ctx.env.poison) },
	}
}

function newScanOut(): ScanOut {
	return { cd: null, op: null, redir: null }
}

function mergeChainEnv(chain: ChainEnv, local: ChainEnv): ChainEnv {
	return {
		overlay: new Map([...chain.overlay, ...local.overlay]),
		poison: new Set([...chain.poison, ...local.poison]),
	}
}

interface NormalizedArgv {
	argv0: string
	args: string[]
	local: ChainEnv
	opaqueEnv: boolean
	opaqueFlag: string | null
	parenLocal: boolean
}

const SHELL_KEYWORDS = new Set([
	"!", "time", "command", "builtin", "if", "while", "until",
	"do", "then", "else", "elif",
])

interface StrippedWrappers {
	words: string[]
	opaque: boolean
	opaqueFlag: string | null
	local: string[]
}

function splitEnvPrefix(words: string[]): { env: string[]; rest: string[] } {
	let i = 0
	while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i++
	return { env: words.slice(0, i), rest: words.slice(i) }
}

interface GroupedWords {
	words: string[]
	parenLocal: boolean
}

function stripGroupDelimiters(words: string[]): GroupedWords {
	let rest = words
	let parenLocal = false
	while (rest.length > 0 && /^[{()]+$/.test(rest[0])) {
		if (rest[0].includes("(")) parenLocal = true
		rest = rest.slice(1)
	}
	if (rest.length > 0 && /^[(]/.test(rest[0])) {
		parenLocal = true
		rest = [rest[0].replace(/^[(]+/, ""), ...rest.slice(1)]
	}
	if (rest.length > 0 && /^[{}]/.test(rest[0])) {
		rest = [rest[0].replace(/^[{}]+/, ""), ...rest.slice(1)]
	}
	return { words: rest, parenLocal }
}

function timeoutFlagTakesValue(flag: string): boolean {
	const valued = new Set(["-s", "-k", "--signal", "--kill-after"])
	return valued.has(flag)
}

function stripTimeoutPrefix(words: string[]): string[] {
	let rest = words.slice(1)
	while (hasMoreFlags(rest)) {
		rest = rest.slice(timeoutFlagTakesValue(rest[0] ?? "") ? 2 : 1)
	}
	if (rest[0] === "--") rest = rest.slice(1)
	if (rest.length > 0 && !(rest[0] ?? "").startsWith("-")) rest = rest.slice(1)
	return rest
}

function stripNicePrefix(words: string[]): string[] {
	let rest = words.slice(1)
	while (hasMoreFlags(rest)) {
		const flag = rest[0] ?? ""
		rest = rest.slice(flag === "-n" || flag === "--adjustment" ? 2 : 1)
	}
	if (rest[0] === "--") rest = rest.slice(1)
	return rest
}

function envFlagIsOpaque(flag: string): boolean {
	const opaque = new Set(["-i", "-u", "--ignore-environment", "--unset"])
	return opaque.has(flag)
}

function stripEnvCommand(words: string[]): StrippedWrappers {
	let rest = words.slice(1)
	let opaque = false
	let opaqueFlag: string | null = null
	while (hasMoreFlags(rest)) {
		const flag = rest[0] ?? ""
		if (envFlagIsOpaque(flag)) {
			opaque = true
			opaqueFlag = flag
		}
		rest = rest.slice(flag === "-u" || flag === "--unset" ? 2 : 1)
	}
	if (rest[0] === "--") rest = rest.slice(1)
	const prefix = splitEnvPrefix(rest)
	return { words: prefix.rest, opaque, opaqueFlag, local: prefix.env }
}

/** Peel one non-env transparent wrapper; null when the head is none. */
function stripPlainWrapper(words: string[]): string[] | null {
	const head = words[0] ?? ""
	if (head === "time") {
		const rest = words.slice(1)
		return rest[0] === "-p" ? rest.slice(1) : rest
	}
	if (SHELL_KEYWORDS.has(head)) return words.slice(1)
	if (head === "timeout") return stripTimeoutPrefix(words)
	if (head === "nice") return stripNicePrefix(words)
	if (head === "nohup") return words.slice(1)
	return null
}

interface WrapperAcc {
	opaque: boolean
	opaqueFlag: string | null
	local: string[]
}

function applyEnvWrapper(rest: string[], acc: WrapperAcc): string[] | null {
	if ((rest[0] ?? "") !== "env") return null
	const stripped = stripEnvCommand(rest)
	acc.opaque = acc.opaque || stripped.opaque
	acc.opaqueFlag = stripped.opaqueFlag ?? acc.opaqueFlag
	acc.local.push(...stripped.local)
	return stripped.words
}

function stripCommandWrappers(words: string[]): StrippedWrappers {
	let rest = words
	const acc: WrapperAcc = { opaque: false, opaqueFlag: null, local: [] }
	for (;;) {
		const peeled = stripPlainWrapper(rest) ?? applyEnvWrapper(rest, acc)
		if (peeled === null) break
		rest = peeled
	}
	return {
		words: rest, opaque: acc.opaque, opaqueFlag: acc.opaqueFlag, local: acc.local,
	}
}

/** Reduce split words to the effective argv: env prefixes (kept as a local
 * overlay), grouping delimiters, and transparent wrappers (keywords,
 * timeout/nice/nohup/env) are peeled; `sudo` is deliberately NOT peeled —
 * an allowed sudo already moots confinement (operator's choice). */
function normalizeArgv(words: string[]): NormalizedArgv | null {
	const prefix = splitEnvPrefix(words)
	const local = newChainEnv()
	harvestSubAssignments(prefix.env, local)
	const grouped = stripGroupDelimiters(prefix.rest)
	const stripped = stripCommandWrappers(grouped.words)
	harvestSubAssignments(stripped.local, local)
	const core = stripped.words.filter((word) => word !== "")
	if (core.length === 0) return null
	return {
		argv0: path.basename(core[0] ?? ""),
		args: core.slice(1),
		local,
		opaqueEnv: stripped.opaque,
		opaqueFlag: stripped.opaqueFlag,
		parenLocal: grouped.parenLocal,
	}
}

/** First non-flag word of a cd/pushd argv (`-` survives: it toggles cwd). */
function cdDirOperand(args: string[]): string | null {
	let rest = args
	while (hasMoreFlags(rest) && rest[0] !== "-") rest = rest.slice(1)
	if (rest[0] === "--") rest = rest.slice(1)
	return rest[0] ?? null
}

function cdpathBlocks(dir: string, subEnv: ChainEnv): boolean {
	if (dir.startsWith("~") || dir.includes("/") || dir === "-") return false
	const cdpath = subEnv.overlay.get("CDPATH") ?? process.env.CDPATH ?? ""
	return cdpath !== ""
}

function homeEscape(
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
): CdEscape | null {
	const resolved = resolveOperandTarget("~", ctx.cwd, subEnv)
	if (!isOutsideWorkspace(ctx.contain, resolved)) return null
	return { subCommand: sub, directory: "~" }
}

function opaqueEnvCdEscape(norm: NormalizedArgv, sub: string): CdEscape {
	return {
		subCommand: sub,
		directory: norm.opaqueFlag ?? "env",
		reason: "cleared environment is opaque",
	}
}

function cdCheckWord(word: string, subEnv: ChainEnv): string {
	if (word === "") return "~"
	return expandOperandWord(word, subEnv) === "" ? "~" : word
}

function poisonedCdHit(
	word: string,
	sub: string,
	subEnv: ChainEnv,
): CdEscape | null {
	if (!usesPoisonedVar(word, subEnv)) return null
	return { subCommand: sub, directory: word, reason: "unresolvable variable" }
}

function containedCdHit(
	check: string,
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
): CdEscape | null {
	if (cdpathBlocks(check, subEnv)) {
		const reason = "CDPATH makes slashless cd unresolvable"
		return { subCommand: sub, directory: check, reason }
	}
	const resolved = resolveOperandTarget(check, ctx.cwd, subEnv)
	if (!isOutsideWorkspace(ctx.contain, resolved)) return null
	return { subCommand: sub, directory: check }
}

function cdDirEscape(
	dir: string,
	norm: NormalizedArgv,
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
): CdEscape | null {
	const word = norm.parenLocal ? dir.replace(/\)+$/, "") : dir
	const poisoned = poisonedCdHit(word, sub, subEnv)
	if (poisoned !== null) return poisoned
	return containedCdHit(cdCheckWord(word, subEnv), sub, ctx, subEnv)
}

function cdEscapeInArgv(
	norm: NormalizedArgv,
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
): CdEscape | null {
	if (norm.opaqueEnv) return opaqueEnvCdEscape(norm, sub)
	if (norm.argv0 !== "cd" && norm.argv0 !== "pushd") return null
	const dir = cdDirOperand(norm.args)
	if (norm.argv0 === "pushd" && isStackRotation(dir)) return null
	if (dir === "-") return null
	if (dir === null || dir === "") return homeEscape(sub, ctx, subEnv)
	return cdDirEscape(dir, norm, sub, ctx, subEnv)
}

function isStackRotation(dir: string | null): boolean {
	return dir === null || /^[+-]\d+$/.test(dir)
}

function trackCdDir(
	norm: NormalizedArgv,
	ctx: ScanCtx,
	subEnv: ChainEnv,
): void {
	const dir = cdDirOperand(norm.args)
	if (dir === "-") {
		const prev = ctx.prevCwd
		ctx.prevCwd = ctx.cwd
		ctx.cwd = prev
		return
	}
	if (dir === null || dir === "") return
	if (cdpathBlocks(dir, subEnv)) return
	const word = norm.parenLocal ? dir.replace(/\)+$/, "") : dir
	if (usesPoisonedVar(word, subEnv)) return
	ctx.prevCwd = ctx.cwd
	ctx.cwd = resolveOperandTarget(word === "" ? "~" : word, ctx.cwd, subEnv)
}

function popDirStack(ctx: ScanCtx): void {
	const top = ctx.stack.pop()
	if (top === undefined) return
	ctx.prevCwd = ctx.cwd
	ctx.cwd = top
}

function swapDirStack(ctx: ScanCtx): void {
	const top = ctx.stack.pop()
	if (top === undefined) return
	ctx.stack.push(ctx.cwd)
	ctx.prevCwd = ctx.cwd
	ctx.cwd = top
}

function pushdDirUntrackable(dir: string, subEnv: ChainEnv): boolean {
	if (dir === "" || dir === "-") return true
	if (isStackRotation(dir) || cdpathBlocks(dir, subEnv)) return true
	return usesPoisonedVar(dir, subEnv)
}

function trackPushdPopd(
	norm: NormalizedArgv,
	ctx: ScanCtx,
	subEnv: ChainEnv,
): void {
	if (norm.argv0 === "popd") {
		popDirStack(ctx)
		return
	}
	if (norm.argv0 !== "pushd") return
	const dir = cdDirOperand(norm.args)
	if (dir === null) {
		swapDirStack(ctx)
		return
	}
	if (pushdDirUntrackable(dir, subEnv)) return
	ctx.stack.push(ctx.cwd)
	ctx.prevCwd = ctx.cwd
	ctx.cwd = resolveOperandTarget(dir, ctx.cwd, subEnv)
}

/** Track inside-only directory changes for later sub-commands. Paren-local
 * cds (subshells) never leak; rotations are no-ops (the stack holds only
 * inside dirs, so order is irrelevant to containment). */
function trackCd(
	norm: NormalizedArgv | null,
	ctx: ScanCtx,
	subEnv: ChainEnv,
): void {
	if (norm === null || norm.parenLocal || norm.opaqueEnv) return
	if (norm.argv0 === "cd") {
		trackCdDir(norm, ctx, subEnv)
		return
	}
	trackPushdPopd(norm, ctx, subEnv)
}

interface OperandRule {
	values: string[]
	scripts: string[]
	skipValues: string[]
	positionals: "last" | "all" | "script-rest" | "none" | "first"
}

function lastDest(...values: string[]): OperandRule {
	return { values, scripts: [], skipValues: [], positionals: "last" }
}

function noPositionals(...values: string[]): OperandRule {
	return { values, scripts: [], skipValues: [], positionals: "none" }
}

function allPositionals(): OperandRule {
	return { values: [], scripts: [], skipValues: [], positionals: "all" }
}

function scriptRest(...skipValues: string[]): OperandRule {
	const scripts = ["-e", "-f"]
	return { values: [], scripts, skipValues, positionals: "script-rest" }
}

const WRITE_OPERAND_RULES: Record<string, OperandRule> = {
	cp: lastDest("-t", "--target-directory"),
	mv: lastDest("-t", "--target-directory"),
	ln: lastDest("-t", "--target-directory"),
	install: lastDest("-t", "--target-directory"),
	rsync: lastDest(),
	scp: lastDest(),
	tee: allPositionals(),
	git: noPositionals("-C", "--git-dir", "--work-tree"),
	tar: noPositionals("-f", "--file", "-C", "--directory"),
	sed: scriptRest(),
	perl: scriptRest("-I", "-F"),
	curl: noPositionals("-o", "--output", "--output-dir"),
	wget: noPositionals("-O", "--output-document", "-P", "--directory-prefix"),
	source: { values: [], scripts: [], skipValues: [], positionals: "first" },
	".": { values: [], scripts: [], skipValues: [], positionals: "first" },
}

/** True when a single-dash cluster carries `letter` (`-pi` has `i`) or a
 * long flag matches. Letters that consume the rest of the word stop the
 * scan (`-ei` is `-e` with value `i`, not `-i`; `-tf` is `-t` with `f`). */
function matchesLongFlag(word: string, longs: string[]): boolean {
	return longs.some((long) => word === long || word.startsWith(`${long}=`))
}

function clusterCarries(
	word: string,
	letter: string,
	stoppers: string[],
): boolean {
	if (!/^-[^-]/.test(word)) return false
	for (const char of word.slice(1)) {
		if (stoppers.includes(`-${char}`)) return false
		if (char === letter) return true
	}
	return false
}

function clusterHasLetter(
	args: string[],
	letter: string,
	stoppers: string[],
	longs: string[],
): boolean {
	for (const word of args) {
		if (matchesLongFlag(word, longs)) return true
		if (clusterCarries(word, letter, stoppers)) return true
	}
	return false
}

/** Consume a value flag: separate (`-t DIR`), `--flag=DIR`, or attached
 * (`-tDIR`) forms. Returns the next index to visit. */
function attachedFlagValue(word: string, flags: string[]): string | null {
	if (!/^-[A-Za-z]/.test(word) || word.length <= 2) return null
	if (!flags.includes(word.slice(0, 2))) return null
	return word.slice(2)
}

function consumeValueFlag(
	word: string,
	args: string[],
	index: number,
	flags: string[],
	into: string[],
): number {
	if (flags.includes(word)) {
		if (index + 1 < args.length) into.push(args[index + 1] ?? "")
		return index + 1
	}
	const attached = attachedFlagValue(word, flags)
	if (attached !== null) {
		into.push(attached)
		return index
	}
	const eq = word.indexOf("=")
	if (eq > 0 && flags.includes(word.slice(0, eq))) into.push(word.slice(eq + 1))
	return index
}

/** tar's `-f` inside a cluster (`-cf ARCHIVE`, `-xffoo.tar`): the archive
 * follows the `f` (same word) or the word. Separate from the table: `f`
 * is positional-shape inside clusters, not a plain flag. */
function tarClusterArchive(args: string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		const word = args[i] ?? ""
		if (!/^-[^-]/.test(word) || word === "-f") continue
		const at = word.indexOf("f", 1)
		if (at < 0) continue
		if (at + 1 < word.length) return word.slice(at + 1)
		return i + 1 < args.length ? (args[i + 1] ?? null) : null
	}
	return null
}

interface CollectedOperands {
	fromFlags: string[]
	positional: string[]
	scriptSeen: boolean
}

interface FlagStep {
	next: number
	script: boolean
}

function collectFlagWord(
	word: string,
	args: string[],
	index: number,
	rule: OperandRule,
	fromFlags: string[],
): FlagStep {
	const before = fromFlags.length
	let next = consumeValueFlag(word, args, index, rule.values, fromFlags)
	if (fromFlags.length === before) {
		next = consumeValueFlag(word, args, next, rule.scripts, [])
	}
	const attached = attachedFlagValue(word, rule.scripts) !== null
	const script = rule.scripts.includes(word) || attached
	next = consumeValueFlag(word, args, next, rule.skipValues, [])
	return { next: next + 1, script }
}

interface CollectState extends CollectedOperands {
	dashdash: boolean
}

function collectNextArg(
	args: string[],
	index: number,
	rule: OperandRule,
	acc: CollectState,
): number {
	const word = args[index] ?? ""
	if (!acc.dashdash && word === "--") {
		acc.dashdash = true
		return index + 1
	}
	if (!acc.dashdash && word.startsWith("-") && word.length > 1) {
		const step = collectFlagWord(word, args, index, rule, acc.fromFlags)
		acc.scriptSeen = acc.scriptSeen || step.script
		return step.next
	}
	acc.positional.push(word)
	return index + 1
}

function collectOperandCandidates(
	args: string[],
	rule: OperandRule,
): CollectedOperands {
	const acc: CollectState = {
		fromFlags: [], positional: [], scriptSeen: false, dashdash: false,
	}
	let i = 0
	while (i < args.length) i = collectNextArg(args, i, rule, acc)
	const { fromFlags, positional, scriptSeen } = acc
	return { fromFlags, positional, scriptSeen }
}

function positionalCandidates(
	collected: CollectedOperands,
	rule: OperandRule,
): string[] {
	const positional = collected.positional
	if (rule.positionals === "last" && positional.length > 0) {
		const last = positional[positional.length - 1] ?? ""
		return [last]
	}
	if (rule.positionals === "all") return positional
	if (rule.positionals === "first") return positional.slice(0, 1)
	if (rule.positionals === "script-rest") {
		return collected.scriptSeen ? positional : positional.slice(1)
	}
	return []
}

function gitRepoVarEscape(
	name: string,
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
): WriteOperandEscape | null {
	const raw = subEnv.overlay.get(name) ?? process.env[name]
	if (raw === undefined) return null
	if (subEnv.poison.has(name) || usesPoisonedVar(raw, subEnv)) {
		const reason = "unresolvable repo pointer"
		return { subCommand: sub, command: "git", operand: name, reason }
	}
	const resolved = resolveOperandTarget(raw, ctx.cwd, subEnv)
	if (!isOutsideWorkspace(ctx.contain, resolved)) return null
	const operand = `${name}=${raw}`
	return { subCommand: sub, command: "git", operand, reason: "git repo escapes" }
}

function gitRepoEscape(
	norm: NormalizedArgv,
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
): WriteOperandEscape | null {
	if (norm.argv0 !== "git") return null
	for (const name of ["GIT_DIR", "GIT_WORK_TREE"]) {
		const hit = gitRepoVarEscape(name, sub, ctx, subEnv)
		if (hit !== null) return hit
	}
	return null
}

function wordWritesOutside(
	word: string,
	norm: NormalizedArgv,
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
): WriteOperandEscape | null {
	if (word === "" || (norm.argv0 === "scp" && word.includes(":"))) return null
	const check = norm.parenLocal ? word.replace(/\)+$/, "") : word
	if (usesPoisonedVar(check, subEnv)) {
		const reason = "unresolvable variable"
		return { subCommand: sub, command: norm.argv0, operand: word, reason }
	}
	const resolved = resolveOperandTarget(check, ctx.cwd, subEnv)
	if (!isOutsideWorkspace(ctx.contain, resolved)) return null
	return { subCommand: sub, command: norm.argv0, operand: word }
}

function writesOutside(
	words: string[],
	norm: NormalizedArgv,
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
): WriteOperandEscape | null {
	for (const word of words) {
		const hit = wordWritesOutside(word, norm, sub, ctx, subEnv)
		if (hit !== null) return hit
	}
	return null
}

function tarWriteHit(
	norm: NormalizedArgv,
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
): WriteOperandEscape | null {
	if (norm.argv0 !== "tar") return null
	const absolute = clusterHasLetter(norm.args, "P", ["-f"], ["--absolute-names"])
	if (absolute) {
		const reason = "absolute-name extraction"
		return { subCommand: sub, command: "tar", operand: "-P", reason }
	}
	const archive = tarClusterArchive(norm.args)
	if (archive === null) return null
	return writesOutside([archive], norm, sub, ctx, subEnv)
}

/** sed/perl without `-i` read their files (stdout carries the output);
 * only in-place edits write, so only those are gated. */
function inPlaceEditGated(norm: NormalizedArgv): boolean {
	if (norm.argv0 !== "sed" && norm.argv0 !== "perl") return true
	const base = ["-e", "-f"]
	const stoppers = norm.argv0 === "perl" ? [...base, "-I", "-F"] : base
	return clusterHasLetter(norm.args, "i", stoppers, ["--in-place"])
}

/** A hard link's TARGET is read (an outside inode smuggled in); a symlink
 * target is inert text (file tools refuse to follow escapes later). */
function hardlinkTargetHit(
	norm: NormalizedArgv,
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
	positional: string[],
): WriteOperandEscape | null {
	if (norm.argv0 !== "ln") return null
	if (clusterHasLetter(norm.args, "s", ["-t"], ["--symbolic"])) return null
	const first = positional[0] ?? ""
	if (first === "") return null
	return writesOutside([first], norm, sub, ctx, subEnv)
}

function tableOperandEscape(
	norm: NormalizedArgv,
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
): WriteOperandEscape | null {
	const rule = WRITE_OPERAND_RULES[norm.argv0]
	if (rule === undefined) return null
	const tarHit = tarWriteHit(norm, sub, ctx, subEnv)
	if (tarHit !== null) return tarHit
	if (!inPlaceEditGated(norm)) return null
	const collected = collectOperandCandidates(norm.args, rule)
	const flagHit = writesOutside(collected.fromFlags, norm, sub, ctx, subEnv)
	if (flagHit !== null) return flagHit
	const positional = positionalCandidates(collected, rule)
	const hit = writesOutside(positional, norm, sub, ctx, subEnv)
	if (hit !== null) return hit
	return hardlinkTargetHit(norm, sub, ctx, subEnv, collected.positional)
}

const SHELL_COMMANDS = new Set(["sh", "bash", "dash", "zsh", "ksh"])

function shellOptionTakesValue(flag: string): boolean {
	return flag === "-o" || flag === "-O" || flag === "+o" || flag === "+O"
}

/** First script-file operand of a shell invocation (no `-c`): `-o`/`-O`
 * values are consumed, every other dash-word skipped. */
function shellScriptFile(args: string[]): string | null {
	let i = 0
	while (i < args.length) {
		const word = args[i] ?? ""
		if (word === "--") return args[i + 1] ?? null
		if (word.startsWith("-") && word.length > 1) {
			i += shellOptionTakesValue(word) ? 2 : 1
			continue
		}
		return word
	}
	return null
}

function findDashCScript(args: string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		const word = args[i] ?? ""
		if (word === "-c" || word === "--command") return args[i + 1] ?? null
		if (word.startsWith("--command=")) return word.slice("--command=".length)
	}
	return null
}

function shellStdinOpaque(
	norm: NormalizedArgv,
	sub: string,
): WriteOperandEscape {
	const explicit = norm.args.some((word) => word === "-s" || word === "--stdin")
	const operand = explicit ? "-s" : "(stdin)"
	const reason = "stdin script is opaque"
	return { subCommand: sub, command: norm.argv0, operand, reason }
}

function shellScriptFileHit(
	norm: NormalizedArgv,
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
): WriteOperandEscape | null {
	const file = shellScriptFile(norm.args)
	if (file === null || file === "") return null
	const resolved = resolveOperandTarget(file, ctx.cwd, subEnv)
	if (!isOutsideWorkspace(ctx.contain, resolved)) return null
	return { subCommand: sub, command: norm.argv0, operand: file }
}

/** Shell invocations: `-c` scripts are scanned (forked context — a child
 * shell never leaks exports/cwd); `-s`/redirected-stdin/bare shells are
 * opaque (refused); a script FILE outside the workspace is refused (its
 * contents are a documented boundary — inside scripts run unscanned).
 * Piped-stdin shells (`... | bash`) are invisible per-sub-command and pass;
 * flag-only probes (`bash --version`) are safe no-ops and pass. */
function shellInvocationEscape(
	norm: NormalizedArgv,
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
	out: ScanOut,
): WriteOperandEscape | null {
	if (!SHELL_COMMANDS.has(norm.argv0)) return null
	const script = findDashCScript(norm.args)
	if (script !== null) {
		scanPartsShared(parseCommand(script).commands, forkScanCtx(ctx), out)
		return null
	}
	const dashS = norm.args.some((word) => word === "-s" || word === "--stdin")
	if (dashS || norm.args.length === 0 || /</.test(sub)) {
		return shellStdinOpaque(norm, sub)
	}
	return shellScriptFileHit(norm, sub, ctx, subEnv)
}

function opaqueEnvOpEscape(
	norm: NormalizedArgv,
	sub: string,
): WriteOperandEscape {
	return {
		subCommand: sub,
		command: "env",
		operand: norm.opaqueFlag ?? "-i",
		reason: "cleared environment is opaque",
	}
}

function opEscapeInArgv(
	norm: NormalizedArgv,
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
	out: ScanOut,
): WriteOperandEscape | null {
	if (norm.opaqueEnv) return opaqueEnvOpEscape(norm, sub)
	if (norm.argv0 === "eval") {
		scanPartsShared(parseCommand(norm.args.join(" ")).commands, ctx, out)
		return null
	}
	const shellHit = shellInvocationEscape(norm, sub, ctx, subEnv, out)
	if (shellHit !== null) return shellHit
	if (SHELL_COMMANDS.has(norm.argv0)) return null
	const tableHit = tableOperandEscape(norm, sub, ctx, subEnv)
	if (tableHit !== null) return tableHit
	return gitRepoEscape(norm, sub, ctx, subEnv)
}

function redirEscapeInSub(
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
): RedirectTarget | null {
	for (const target of redirectTargets(sub)) {
		if (usesPoisonedVar(target.word, subEnv)) return target
		const resolved = resolveOperandTarget(target.word, ctx.cwd, subEnv)
		if (isOutsideWorkspace(ctx.contain, resolved)) return target
	}
	return null
}

function readVarOperands(args: string[]): string[] {
	const takesValue = new Set(["-p", "-d", "-n", "-N", "-t", "-u"])
	let i = 0
	while (i < args.length) {
		const word = args[i] ?? ""
		if (word === "--") {
			i++
			break
		}
		if (word.startsWith("-") && word.length > 1) {
			i += takesValue.has(word) ? 2 : 1
			continue
		}
		break
	}
	return args.slice(i)
}

/** `read` binds names from input (unresolvable): poison its operands so
 * later uses fail closed. */
function poisonReadVars(norm: NormalizedArgv | null, env: ChainEnv): void {
	if (norm === null || norm.argv0 !== "read") return
	for (const name of readVarOperands(norm.args)) {
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			env.poison.add(name)
			env.overlay.delete(name)
		}
	}
}

/** Atomic paren groups walk in a fork (subshells never leak cwd or
 * exports); hits still propagate out. Returns whether it applied. */
function scanParenGroup(sub: string, ctx: ScanCtx, out: ScanOut): boolean {
	const trimmed = sub.trim()
	if (!trimmed.startsWith("(")) return false
	const inner = trimmed.replace(/^\(+/, "").replace(/\)+$/, "")
	scanPartsShared(parseCommand(inner).commands, forkScanCtx(ctx), out)
	return true
}

/** Argv scans with explicit first-wins (never ??=): the op scan recurses
 * into `-c`/eval scripts, recording hits as a side effect — a ??= would
 * evaluate the nullish check BEFORE the RHS and clobber a
 * recursion-recorded hit with the outer call's own null. */
function scanSubArgv(
	norm: NormalizedArgv,
	sub: string,
	ctx: ScanCtx,
	subEnv: ChainEnv,
	out: ScanOut,
): void {
	const cdHit = cdEscapeInArgv(norm, sub, ctx, subEnv)
	if (out.cd === null) out.cd = cdHit
	const opHit = opEscapeInArgv(norm, sub, ctx, subEnv, out)
	if (opHit !== null && out.op === null) out.op = opHit
	poisonReadVars(norm, ctx.env)
}

/** Check one sub-command (all three scans), then harvest its assignments
 * and track its cd for LATER sub-commands. */
function scanSubShared(sub: string, ctx: ScanCtx, out: ScanOut): void {
	if (sub.trim() === "" || scanParenGroup(sub, ctx, out)) return
	const words = splitCommandWords(sub)
	const norm = normalizeArgv(words)
	const subEnv = mergeChainEnv(ctx.env, norm?.local ?? newChainEnv())
	if (norm !== null) scanSubArgv(norm, sub, ctx, subEnv, out)
	const redirHit = redirEscapeInSub(sub, ctx, subEnv)
	if (out.redir === null) out.redir = redirHit
	if (norm !== null) trackCd(norm, ctx, subEnv)
	harvestSubAssignments(words, ctx.env)
}

/** Ordered walk with resplit fixpoint: a sub-command that re-splits is
 * promoted-subshell content (top-level operators always split), so its
 * parts walk forked. Re-splitting strictly shrinks the strings. */
function scanPartsShared(parts: string[], ctx: ScanCtx, out: ScanOut): void {
	for (const sub of parts) {
		const resplit = parseCommand(sub).commands
		if (resplit.length > 1) {
			scanPartsShared(resplit, forkScanCtx(ctx), out)
			continue
		}
		scanSubShared(sub, ctx, out)
	}
}

function scanWholeCommand(command: string, workspaceRoot?: string): ScanOut {
	const ctx = newScanCtx(workspaceRoot ?? process.cwd())
	prePoisonRawAssignments(command, ctx.env)
	const out = newScanOut()
	scanPartsShared(parseCommand(command).commands, ctx, out)
	return out
}

/**
 * Check a command for a directory change escaping the workspace root:
 * `cd`/`pushd` to an outside path, bare `cd` ($HOME), `cd` with an
 * unresolvable operand, or an opaque environment (`env -i`). Per-sub-command
 * argv analysis (unlike the redirect raw scan): `echo "cd /tmp"` and
 * heredoc bodies naming cd are dead text, correctly allowed.
 */
export function checkCdEscape(
	command: string,
	workspaceRoot?: string,
): CdEscape | null {
	return scanWholeCommand(command, workspaceRoot).cd
}

/**
 * Check a command for file-writing operands escaping the workspace root:
 * copy/move/link/install/rsync/scp destinations, `tee` outputs, `git`
 * repo pointers (`-C`, `--git-dir`, `--work-tree`, `GIT_DIR`), `tar`
 * archives/dirs, in-place `sed`/`perl` files, downloader outputs, and
 * shell script files. Reads (`cat /etc/x`) and remote scp (`h:/x`) pass.
 */
export function checkWriteOperandEscape(
	command: string,
	workspaceRoot?: string,
): WriteOperandEscape | null {
	return scanWholeCommand(command, workspaceRoot).op
}

// ─── allow/deny logic port (zoo-code/src/core/auto-approval/commands.ts) ────

/**
 * Detect dangerous parameter substitutions that could lead to command
 * execution. These patterns are never auto-approved (upstream) and are always
 * refused in the headless harness. Ported verbatim from the reference.
 */
export function containsDangerousSubstitution(source: string): boolean {
	// ${var@P} prompt-string expansion, ${var@Q} quote removal, ${var@E} escape
	// expansion, ${var@A} assignment statement, ${var@a} attribute flags.
	const dangerousParameterExpansion = /\$\{[^}]*@[PQEAa][^}]*\}/.test(source)

	// ${var=value} / ${var:=value} / ${var+value} / ${var:-value} / ${var:+value}
	// / ${var:?value} with octal / hex / unicode escapes that can embed commands.
	const parameterAssignmentWithEscapes =
		/\$\{[^}]*[=+\-?][^}]*\\[0-7]{3}[^}]*\}/.test(source) ||
		/\$\{[^}]*[=+\-?][^}]*\\x[0-9a-fA-F]{2}[^}]*\}/.test(source) ||
		/\$\{[^}]*[=+\-?][^}]*\\u[0-9a-fA-F]{4}[^}]*\}/.test(source)

	// ${!var} indirect expansion.
	const indirectExpansion = /\$\{![^}]+\}/.test(source)

	// <<<$(...) or <<<`...` here-strings with command substitution.
	const hereStringWithSubstitution = /<<<\s*(\$\(|`)/.test(source)

	// =(...) zsh process substitution that executes commands.
	const zshProcessSubstitution = /(?:(?<=^)|(?<=[\s;|&(<]))=\([^)]+\)/.test(source)

	// zsh glob qualifiers with code execution, e.g. *(e:whoami:), ?(e:rm -rf /:).
	const zshGlobQualifier = /[*?+@!]\(e:[^:]+:\)/.test(source)

	return (
		dangerousParameterExpansion ||
		parameterAssignmentWithEscapes ||
		indirectExpansion ||
		hereStringWithSubstitution ||
		zshProcessSubstitution ||
		zshGlobQualifier
	)
}

/**
 * Find the longest matching prefix from a list of prefixes for a given
 * command (case-insensitive, startsWith-based). Wildcard "*" matches any
 * command but is treated as length 1 for comparison. Ported verbatim.
 */
export function findLongestPrefixMatch(command: string, prefixes: string[]): string | null {
	if (!command || !prefixes?.length) {
		return null
	}

	const trimmedCommand = command.trim().toLowerCase()
	let longestMatch: string | null = null

	for (const prefix of prefixes) {
		const lowerPrefix = prefix.toLowerCase()
		if (lowerPrefix === "*" || trimmedCommand.startsWith(lowerPrefix)) {
			if (!longestMatch || lowerPrefix.length > longestMatch.length) {
				longestMatch = lowerPrefix
			}
		}
	}

	return longestMatch
}

/** Command approval decision types (upstream). */
export type CommandDecision = "auto_approve" | "auto_deny" | "ask_user" | "malformed_command"

/**
 * Decision for a single command using the longest-prefix-match rule (ported
 * verbatim). Both-list conflict: longer (more specific) match wins; a TIE goes
 * to deny. No match at all → "ask_user".
 */
export function getSingleCommandDecision(
	command: string,
	allowedCommands: string[],
	deniedCommands?: string[],
): CommandDecision {
	if (!command) return "auto_approve"

	const longestAllowedMatch = findLongestPrefixMatch(command, allowedCommands || [])
	const longestDeniedMatch = findLongestPrefixMatch(command, deniedCommands || [])

	if (longestAllowedMatch && !longestDeniedMatch) {
		return "auto_approve"
	}
	if (!longestAllowedMatch && longestDeniedMatch) {
		return "auto_deny"
	}
	if (longestAllowedMatch && longestDeniedMatch) {
		return longestAllowedMatch.length > longestDeniedMatch.length ? "auto_approve" : "auto_deny"
	}
	return "ask_user"
}

/**
 * Unified command validation implementing the upstream decision flow (ported
 * verbatim): any denied sub-command denies the whole command; dangerous
 * substitutions are never auto-approved (→ "ask_user"); malformed commands
 * (unterminated quotes) are rejected. See the module header for the verified
 * precedence.
 */
export function getCommandDecision(
	command: string,
	allowedCommands: string[],
	deniedCommands?: string[],
): CommandDecision {
	if (!command?.trim()) {
		return "auto_approve"
	}

	const { commands: subCommands, parseError } = parseCommand(command)

	if (parseError !== null) {
		return "malformed_command"
	}

	const decisions: CommandDecision[] = subCommands.map((cmd) => {
		const cmdWithoutRedirection = cmd.replace(/\d*>&\d*/, "").trim()
		return getSingleCommandDecision(cmdWithoutRedirection, allowedCommands, deniedCommands)
	})

	// Any denied sub-command denies the whole compound command (deny wins).
	if (decisions.includes("auto_deny")) {
		return "auto_deny"
	}

	if (containsDangerousSubstitution(command)) {
		return "ask_user"
	}

	if (decisions.every((decision) => decision === "auto_approve")) {
		return "auto_approve"
	}

	return "ask_user"
}

// ─── headless decision layer (our mapping, on top of the port) ──────────────

export type PermissionDecision = "allow" | "deny"

/** Details of a command refusal, for a clear model-facing error message. */
export interface CommandRefusal {
	/**
	 * - "dangerous": contains a dangerous shell substitution — always blocked,
	 *   not configurable (upstream never auto-approves these).
	 * - "malformed": shell syntax error (unterminated quote/heredoc).
	 * - "redirect_escape": an output redirect (`>`, `>>`, `2>`, `&>`) whose
	 *   resolved target escapes the workspace root — always blocked, NOT
	 *   configurable, closing the execute_command hole where shell redirects
	 *   could write outside the workspace (e.g. `/tmp`) even though every
	 *   file tool rejects those paths (issue #122).
	 * - "denied": matched the deny-list (deny wins over allow).
	 * - "not_allowed": allow-list configured but this sub-command matches
	 *   neither list; a headless harness has no human to ask, so it is denied.
	 * - "protected_store": recursive delete targeting the shared central store
	 *   or a parent of it — always blocked, NOT configurable (see
	 *   src/permissions/store-protection.ts).
	 * - "cd_escape": a directory change escaping the workspace root — always
	 *   blocked, NOT configurable (issue #136).
	 * - "write_escape": a file-writing operand escaping the workspace root —
	 *   always blocked, NOT configurable (issue #136).
	 */
	kind:
		| "dangerous"
		| "malformed"
		| "redirect_escape"
		| "denied"
		| "not_allowed"
		| "protected_store"
		| "cd_escape"
		| "write_escape"
	/** The sub-command that triggered the refusal (all kinds but dangerous). */
	subCommand?: string
	/** The deny-list pattern that matched (denied). */
	pattern?: string
	/** The parse error (malformed). */
	parseError?: UnterminatedQuote
	/** The resolved target that matched the store (protected_store). */
	target?: string
	/** The protected central store root (protected_store). */
	storeRoot?: string
	/** The redirect that escaped the workspace (redirect_escape). */
	redirect?: RedirectTarget
	/** The directory change that escaped the workspace (cd_escape). */
	cd?: CdEscape
	/** The file-writing operand that escaped (write_escape). */
	writeOperand?: WriteOperandEscape
}

/**
 * Check a command against the resolved permissions. Returns a refusal
 * descriptor when the command must not run, or `null` when it is allowed.
 *
 * Order (per the spec + upstream behavior):
 * 1. Dangerous substitution → unconditional refuse (not configurable).
 * 2. Malformed command (unterminated quote/heredoc) → refuse.
 * 3. Always-applied redirect-escape guard: an output redirect (`>`, `>>`,
 *    `2>`, `&>`) whose target escapes the workspace root — e.g. `> /tmp/x`,
 *    `> $HOME/out`, `2> ../outside.log` — is refused even with an empty
 *    allow/deny config, and is NOT overridable. This closes the documented
 *    execute_command hole (issue #122): every file tool hard-rejects
 *    outside-workspace paths via resolveWithinWorkspace, but a shell redirect
 *    previously slipped through the command-string allow/deny gate and wrote
 *    to `/tmp`. Runs before parsing so it also catches redirects embedded in
 *    unparseable fragments (e.g. a heredoc body's own `> /tmp` line).
 * 4. Each sub-command from `parseCommand` (so `echo hi && rm -rf /` is checked
 *    per sub-command, not as one opaque string), in one ordered walk that
 *    threads the cd-chain cwd and chain exports: FIRST the cd-escape guard
 *    (an outside-cd re-anchors every later relative path, so it refuses
 *    before anything else is resolved — issue #136), THEN the central-store
 *    protection (recursive delete targeting the shared store or a parent of
 *    it — always refused, even with empty allow/deny config, and NOT
 *    overridable by any permissions config), THEN the redirect-escape and
 *    write-operand guards per sub-command, then the deny-list, then the
 *    allow-list, with upstream's longest-prefix-match precedence.
 *
 * `options.workspaceRoot` anchors relative command targets for the
 * central-store and redirect-escape checks (the executor passes the command's
 * resolved `cwd`; default: process.cwd()). It has no effect on the
 * allow/deny lists.
 */
export function checkCommand(
 command: string,
 allowedCommands: string[],
 deniedCommands: string[],
 options?: { workspaceRoot?: string },
): CommandRefusal | null {
 if (!command?.trim()) {
 	return null
 }

 if (containsDangerousSubstitution(command)) {
 	return { kind: "dangerous" }
 }

 // Pre-parse scans (cd first, then redirect): both walk the raw command
 // (heredoc bodies included), so they still catch escapes that parseCommand
 // would classify as malformed (unterminated quote/heredoc). cd precedes
 // the redirect for the same reason it precedes it per sub-command: an
 // outside-cd re-anchors every later relative path.
 const cdEscape = checkCdEscape(command, options?.workspaceRoot)
 if (cdEscape !== null) {
 	return { kind: "cd_escape", subCommand: command, cd: cdEscape }
 }
 const redirectEscape = checkRedirectEscape(command, options?.workspaceRoot)
 if (redirectEscape !== null) {
 	return { kind: "redirect_escape", subCommand: command, redirect: redirectEscape }
 }

 const { commands: subCommands, parseError } = parseCommand(command)
 if (parseError !== null) {
 	return { kind: "malformed", parseError, subCommand: command }
 }

	// One ordered walk threads the cd-chain cwd, directory stack, and chain
	// exports across sub-commands (SEC-6): relative targets resolve against
	// the tracked cwd, containment always against the workspace root.
	const ctx = newScanCtx(options?.workspaceRoot ?? process.cwd())
	prePoisonRawAssignments(command, ctx.env)

	for (const sub of subCommands) {
		const cmd = sub.replace(/\d*>&\d*/, "").trim()
		if (!cmd) {
			continue
		}
		const refusal = checkOneSubCommand(cmd, ctx, allowedCommands, deniedCommands)
		if (refusal !== null) {
			return refusal
		}
	}

 return null
}

function checkSubStore(cmd: string, ctx: ScanCtx): CommandRefusal | null {
	const storeRefusal = checkCentralStoreDestruction(cmd, ctx.cwd, ctx.env)
	if (storeRefusal === null) return null
	return {
		kind: "protected_store",
		subCommand: cmd,
		target: storeRefusal.target,
		storeRoot: storeRefusal.storeRoot,
	}
}

function checkSubScans(cmd: string, ctx: ScanCtx): CommandRefusal | null {
	const out = newScanOut()
	scanSubShared(cmd, ctx, out)
	if (out.cd !== null) {
		return { kind: "cd_escape", subCommand: cmd, cd: out.cd }
	}
	const store = checkSubStore(cmd, ctx)
	if (store !== null) return store
	if (out.redir !== null) {
		return { kind: "redirect_escape", subCommand: cmd, redirect: out.redir }
	}
	if (out.op !== null) {
		return { kind: "write_escape", subCommand: cmd, writeOperand: out.op }
	}
	return null
}

function checkOneSubCommand(
	cmd: string,
	ctx: ScanCtx,
	allowedCommands: string[],
	deniedCommands: string[],
): CommandRefusal | null {
	const scans = checkSubScans(cmd, ctx)
	if (scans !== null) return scans
	return checkSingleCommand(cmd, allowedCommands, deniedCommands)
}

function checkSingleCommand(
	command: string,
	allowedCommands: string[],
	deniedCommands: string[],
): CommandRefusal | null {
	// EMPTY allow-list = default-ALLOW (deliberate, documented decision): the
	// operator has not opted into allow-list gating, so only the deny-list
	// applies. This preserves today's behavior for sessions that configure
	// nothing while still making deniedCommands always apply.
	if (allowedCommands.length === 0) {
		const deniedPattern = findLongestPrefixMatch(command, deniedCommands)
		if (deniedPattern !== null) {
			return { kind: "denied", subCommand: command, pattern: deniedPattern }
		}
		return null
	}

	// Allow-list configured: mirror the upstream longest-prefix-match decision.
	const decision = getSingleCommandDecision(command, allowedCommands, deniedCommands)
	if (decision === "auto_deny") {
		const pattern = findLongestPrefixMatch(command, deniedCommands) ?? findLongestPrefixMatch(command, allowedCommands)
		return { kind: "denied", subCommand: command, pattern: pattern ?? "(deny-list)" }
	}
	if (decision === "ask_user") {
		// Upstream would prompt a human here; a headless harness has none, so
		// anything not explicitly allowed is refused.
		return { kind: "not_allowed", subCommand: command }
	}
	return null // auto_approve
}

/** Allow/deny for a command against the resolved lists (headless semantics). */
export function decideCommand(
	command: string,
	allowedCommands: string[],
	deniedCommands: string[],
	options?: { workspaceRoot?: string },
): PermissionDecision {
	return checkCommand(command, allowedCommands, deniedCommands, options) === null ? "allow" : "deny"
}
