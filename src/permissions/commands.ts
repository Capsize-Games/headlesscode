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

import { checkCentralStoreDestruction, expandEnv, expandHome, splitCommandWords } from "./store-protection.js"

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

	let processedCommand = command.replace(/\d*>&\d*/g, (match) => {
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
 * working directory. Applies the same `~`/`$VAR` expansion and `/*`-glob
 * truncation as the central-store check (store-protection.ts's
 * resolveCommandTarget), so `/tmp` and `/tmp/x` behave identically to `~` and
 * `$TMPDIR` — a relative target like `> out.txt` anchors inside the workspace.
 *
 * A word the shell could expand (e.g. `$TMPDIR/x.txt`) resolves through the
 * SAME expansions the central-store check applies (expandHome/expandEnv), so
 * `> $TMPDIR/x` with TMPDIR set to /tmp refuses like the literal `/tmp/x` it
 * expands to. An UNKNOWN variable stays literal — the shell would expand it
 * to an empty word (the redirect would then hit a missing-operand error),
 * which cannot write outside the workspace, so resolving it literally is the
 * safe direction.
 */
export function resolveRedirectTarget(target: string, workspaceRoot: string): string {
	const expanded = expandEnv(expandHome(target))
	return path.resolve(workspaceRoot, expanded)
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
 * Check ONE sub-command (already split by parseCommand) for an output
 * redirect whose resolved target escapes the workspace root. Returns the
 * first offending redirect, or `null` when every redirect target stays inside
 * the workspace. `workspaceRoot` anchors relative targets (defaults to
 * process.cwd()).
 */
export function checkRedirectEscape(subCommand: string, workspaceRoot?: string): RedirectTarget | null {
	const root = path.resolve(workspaceRoot ?? process.cwd())
	for (const target of redirectTargets(subCommand)) {
		if (isOutsideWorkspace(root, resolveRedirectTarget(target.word, root))) {
			return target
		}
	}
	return null
}

/** Human-readable operator for the model-facing refusal message. */
export function describeRedirect(target: RedirectTarget): string {
	const compact =
		target.operator.includes("&") || target.operator.includes("|") || /^\d*>>/.test(target.operator)
	return compact ? `${target.operator}${target.word}` : `${target.operator} ${target.word}`
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
	 */
	kind: "dangerous" | "malformed" | "redirect_escape" | "denied" | "not_allowed" | "protected_store"
	/** The sub-command that triggered the refusal (denied/not_allowed/protected_store/redirect_escape). */
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
 *    per sub-command, not as one opaque string): FIRST the central-store
 *    protection (recursive delete targeting the shared store or a parent of it
 *    — always refused, even with empty allow/deny config, and NOT overridable
 *    by any permissions config), THEN the redirect-escape guard per
 *    sub-command, then the deny-list, then the allow-list, with upstream's
 *    longest-prefix-match precedence.
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

 // Pre-parse redirect-escape scan: redirectTargets walks the raw command
 // (heredoc bodies included), so it still catches redirects that parseCommand
 // would classify as malformed (unterminated quote/heredoc).
 const redirectEscape = checkRedirectEscape(command, options?.workspaceRoot)
 if (redirectEscape !== null) {
 	return { kind: "redirect_escape", subCommand: command, redirect: redirectEscape }
 }

 const { commands: subCommands, parseError } = parseCommand(command)
 if (parseError !== null) {
 	return { kind: "malformed", parseError, subCommand: command }
 }

	// Track a leading `cd <dir> && ...` chain's effective cwd across
	// sub-commands (SEC-6): `cd /tmp && rm -rf x` must resolve `x` against
	// /tmp, not the pre-cd workspace root, or a relative-path rm evades the
	// central-store check. Only a plain `cd <path>` sub-command updates the
	// tracked cwd (best-effort — `cd` inside a subshell, via a variable, or
	// via `pushd`/`popd` is not tracked; see store-protection.ts header).
	let effectiveCwd = path.resolve(options?.workspaceRoot ?? process.cwd())

	for (const sub of subCommands) {
		const cmd = sub.replace(/\d*>&\d*/, "").trim()
		if (!cmd) {
			continue
		}
		// Always-applied central-store protection: runs before (and
		// independently of) the allow/deny lists, so the empty-allow-list
		// default-ALLOW branch can never bypass it and no permissions.json
		// entry can override it.
		const storeRefusal = checkCentralStoreDestruction(cmd, effectiveCwd)
		if (storeRefusal !== null) {
			return {
				kind: "protected_store",
				subCommand: cmd,
				target: storeRefusal.target,
				storeRoot: storeRefusal.storeRoot,
			}
		}
		// Per-sub-command redirect-escape guard (the pre-parse scan above is
		// the same check on the whole command; this names the offending
		// sub-command for the refusal message). Anchored to the tracked
		// cd-chain cwd for the same reason as the store-destruction check
		// above — a relative redirect after `cd /tmp && ...` must resolve
		// against /tmp, not the pre-cd workspace root.
		const subRedirect = checkRedirectEscape(cmd, effectiveCwd)
		if (subRedirect !== null) {
			return { kind: "redirect_escape", subCommand: cmd, redirect: subRedirect }
		}
		const refusal = checkSingleCommand(cmd, allowedCommands, deniedCommands)
		if (refusal !== null) {
			return refusal
		}
		const cdTarget = matchLeadingCd(cmd)
		if (cdTarget !== null) {
			effectiveCwd = path.resolve(effectiveCwd, expandEnv(expandHome(cdTarget)))
		}
	}

 return null
}

/**
 * When `cmd` is a plain `cd <path>` (optionally quoted, no other words), return
 * the raw path argument; otherwise null. Deliberately narrow — `cd` combined
 * with anything else on the same sub-command word (e.g. `cd /tmp; ls`, already
 * split by parseCommand into separate sub-commands) or with no argument
 * (`cd` alone, which goes to $HOME) is not tracked.
 */
function matchLeadingCd(cmd: string): string | null {
	const m = cmd.match(/^cd\s+(.+)$/)
	if (!m) {
		return null
	}
	let arg = m[1].trim()
	if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
		arg = arg.slice(1, -1)
	}
	return arg || null
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
