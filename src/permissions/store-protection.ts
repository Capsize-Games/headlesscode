/**
 * Default-on protection for the shared central data store against destructive
 * commands run through the `execute_command` TOOL.
 *
 * Background (plans/protect-shared-store-from-destructive-commands.md): a
 * worker deleted the real `~/.local/share/headlesscode` with `rm -rf` as an
 * ad-hoc verification step — three separate times. The command allow/deny
 * system is deliberately opt-in (`permissions.json` / flags / env), so a
 * session that configures nothing has ZERO default protection. The central
 * store (src/project-store.ts) is a categorically different resource: it is
 * SHARED across every project on the machine, so a single misbehaving
 * workspace must not be able to destroy it. This check is therefore
 * always-applied (even with an empty `deniedCommands` list) and NOT
 * overridable by per-workspace permissions config — a config file a worker
 * could write must never authorize deleting the shared store.
 *
 * Honest scope: this is PATTERN-BASED detection, not a hermetic sandbox. It
 * catches recursive `rm` invocations (`rm -rf`, `rm -r`, `rm -fr`, `-R`,
 * `--recursive`, in any flag order/bundle) whose resolved target is the store
 * root, a PARENT of it, or a DESCENDANT of it (`rm -rf <store>/<subdir>`). It
 * also follows symlinks when resolving the target (via `fs.realpathSync`,
 * falling back to the lexical path when the target doesn't exist yet — e.g.
 * `ln -s <store> /tmp/x && rm -rf /tmp/x` resolves through the symlink). It
 * deliberately does NOT try to enumerate every way to destroy a file — a
 * script, `python -c "shutil.rmtree(...)"`, `find ... -delete`, `command rm`,
 * `sudo rm`, or a non-recursive `rm` of a single file inside the store are all
 * out of scope for this version. It is a speed bump against the exact class
 * of mistake that already happened, not a proof of safety. See SEC-5/SEC-6 in
 * SECURITY.md for the full honest-scope writeup, including the residual
 * cd-chain caveat (only a leading `cd <dir> &&` prefix chain updates the
 * effective cwd used for later sub-commands; `cd` inside a subshell, via a
 * variable, or via `pushd` is not tracked).
 *
 * Matching rule (per the plan): a command's target is refused when the
 * RESOLVED path equals the store root, is an ancestor of it, or is a
 * descendant of it. Resolution handles `~` / `~/`, `$VAR` / `${VAR}` env
 * expansion, quoting, symlink following, and relative-vs-absolute paths
 * (relative targets anchor on the command's working directory — the executor
 * passes the resolved `cwd`, and `checkCommand` additionally tracks a leading
 * `cd` chain across `&&`-joined sub-commands). A trailing `/*` glob is treated
 * as the directory itself (the "delete the contents" idiom targets the same
 * resource).
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { projectStoreRoot } from "../project-store.js"

/**
 * Split a command string into shell argv words, honoring single quotes, double
 * quotes and backslash escapes. `~` and `$VAR`/`${VAR}` are KEPT verbatim in
 * the words so the path expander can process them (quote stripping only).
 * Deliberately a minimal approximation of shell word splitting — good enough
 * for the pattern this module detects, not a general shell parser.
 */
export function splitCommandWords(command: string): string[] {
	const words: string[] = []
	let current = ""
	let inWord = false
	let i = 0
	while (i < command.length) {
		const ch = command[i]
		if (ch === "'") {
			inWord = true
			i++
			while (i < command.length && command[i] !== "'") {
				current += command[i++]
			}
			i++ // closing quote
		} else if (ch === '"') {
			inWord = true
			i++
			while (i < command.length && command[i] !== '"') {
				if (command[i] === "\\" && i + 1 < command.length && '\\"$`'.includes(command[i + 1])) {
					current += command[i + 1]
					i += 2
				} else {
					current += command[i++]
				}
			}
			i++ // closing quote
		} else if (ch === "\\") {
			inWord = true
			if (i + 1 < command.length) {
				current += command[i + 1]
				i += 2
			} else {
				i++
			}
		} else if (/\s/.test(ch)) {
			if (inWord) {
				words.push(current)
				current = ""
				inWord = false
			}
			i++
		} else {
			inWord = true
			current += ch
			i++
		}
	}
	if (inWord) {
		words.push(current)
	}
	return words
}

/**
 * True when `words` describe a recursive `rm`: the program is `rm` and any
 * option is `-r`/`-R` (in any short-flag bundle, e.g. `-rf`, `-fr`, `-Rf`) or
 * the long `--recursive`. Flags are scanned across ALL words (GNU rm permutes
 * options and operands), stopping at a literal `--`. Case-insensitive for the
 * short flag (POSIX `-R` is the traditional spelling).
 */
export function isRecursiveDelete(words: string[]): boolean {
	if (words.length === 0 || path.basename(words[0]) !== "rm") {
		return false
	}
	for (let i = 1; i < words.length; i++) {
		const w = words[i]
		if (w === "--") {
			break
		}
		if (w === "--recursive") {
			return true
		}
		if (w.startsWith("-") && w.length > 1 && !w.startsWith("--")) {
			// Short-flag bundle: -r, -rf, -fr, -Rf, -rfi, ...
			if (w.slice(1).toLowerCase().includes("r")) {
				return true
			}
		}
	}
	return false
}

/**
 * The operand (path) words of a recursive `rm`: every word that is not an
 * option, honoring a `--` end-of-options marker (everything after `--` is an
 * operand even if it starts with `-`).
 */
export function deleteTargets(words: string[]): string[] {
	const targets: string[] = []
	let afterDoubleDash = false
	for (let i = 1; i < words.length; i++) {
		const w = words[i]
		if (afterDoubleDash) {
			targets.push(w)
			continue
		}
		if (w === "--") {
			afterDoubleDash = true
			continue
		}
		if (w.startsWith("-") && w.length > 1) {
			continue // option bundle / long option
		}
		targets.push(w)
	}
	return targets
}

/** Expand a leading `~` / `~/` to the home directory. `~user` forms are left
 * alone (they are not expanded by this module — vanishingly rare in the
 * command class under guard, and resolving them needs a passwd lookup). */
export function expandHome(p: string): string {
	if (p === "~") {
		return os.homedir()
	}
	if (p.startsWith("~/")) {
		return path.join(os.homedir(), p.slice(2))
	}
	return p
}

/** Expand `$VAR` and `${VAR}` from `env` (default: process.env). An unset
 * variable stays literal (the shell would turn it into an empty word, but
 * keeping it literal errs toward refusing — safe direction). */
export function expandEnv(p: string, env: NodeJS.ProcessEnv = process.env): string {
	return p
		.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => env[name] ?? m)
		.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => env[name] ?? m)
}

/**
 * Chain-local variable bindings harvested from earlier sub-commands
 * (`export NAME=value`, bare `NAME=value`): the runtime shell would expand
 * them, so the gate must too — otherwise every `export OUT=dir && ... $OUT`
 * chain is a false positive. `poison` holds names bound to unresolvable
 * values (command substitutions, input, globs): uses of those fail closed.
 */
export interface ChainEnv {
	overlay: Map<string, string>
	poison: Set<string>
}

export function newChainEnv(): ChainEnv {
	return { overlay: new Map(), poison: new Set() }
}

function isValidEnvName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

function valueHasSpecials(value: string): boolean {
	return /[$`\\*?[\]()<>|&;#\s]/.test(value)
}

/** Record one NAME=value binding: static values overlay, dynamic values
 * poison. An empty harvest never clears poison (it may be a mangled
 * `NAME=$(...)` whose substitution parseCommand promoted away). */
function harvestBinding(env: ChainEnv, name: string, value: string): void {
	if (!isValidEnvName(name)) return
	if (valueHasSpecials(value)) {
		env.poison.add(name)
		env.overlay.delete(name)
		return
	}
	if (value !== "") env.poison.delete(name)
	env.overlay.set(name, value)
}

function splitAssignment(word: string): [string, string] | null {
	const eq = word.indexOf("=")
	if (eq <= 0) return null
	const name = word.slice(0, eq)
	if (!isValidEnvName(name)) return null
	return [name, word.slice(eq + 1)]
}

/** Harvest `export A=1 B=2` / bare `A=1 B=2` assignments from split words.
 * `A=1 cmd` (env prefix + command) harvests NOTHING — prefixes are
 * temporary, not bindings. Bare `export NAME` (no `=`) is a no-op. */
export function harvestSubAssignments(words: string[], env: ChainEnv): void {
	if (words[0] === "export") {
		for (const word of words.slice(1)) {
			const binding = splitAssignment(word)
			if (binding !== null) harvestBinding(env, binding[0], binding[1])
		}
		return
	}
	const bindings = words.map(splitAssignment)
	if (bindings.some((binding) => binding === null)) return
	for (const binding of bindings) {
		if (binding !== null) harvestBinding(env, binding[0], binding[1])
	}
}

/** Pre-poison names assigned from dynamic values in the RAW command. The
 * ordered walk sees `NAME=` (empty) for `NAME=$(...)` — the substitution
 * was promoted to its own sub-command — so without this pass a later
 * static-looking harvest would clear poison that must stick. */
export function prePoisonRawAssignments(command: string, env: ChainEnv): void {
	const re = /(?:^|[;&|]|\s)(?:export\s+)?([A-Za-z_]\w*)=([^\s;&|]*)/g
	let match: RegExpExecArray | null
	while ((match = re.exec(command)) !== null) {
		if (valueHasSpecials(match[2] ?? "")) {
			env.poison.add(match[1] ?? "")
			env.overlay.delete(match[1] ?? "")
		}
	}
}

function isKnownVar(name: string, env: ChainEnv): boolean {
	if (env.poison.has(name) || name === "") return false
	if (env.overlay.has(name)) return true
	return process.env[name] !== undefined
}

function poisonedDefaultOp(
	match: string,
	op: string,
	fallback: string,
): string {
	if (op === ":+" || op === "+") return fallback
	return match
}

function knownDefaultOp(
	name: string,
	op: string,
	fallback: string,
	env: ChainEnv,
): string {
	if (op === ":+" || op === "+") return fallback
	return env.overlay.get(name) ?? process.env[name] ?? ""
}

function unsetDefaultOp(
	name: string,
	op: string,
	fallback: string,
	env: ChainEnv,
): string {
	if (op === ":=" || op === "=") {
		harvestBinding(env, name, fallback)
		return fallback
	}
	if (op === ":-" || op === "-") return fallback
	return ""
}

function defaultOpValue(
	match: string,
	name: string,
	op: string,
	fallback: string,
	env: ChainEnv,
): string {
	if (env.poison.has(name)) return poisonedDefaultOp(match, op, fallback)
	if (isKnownVar(name, env)) return knownDefaultOp(name, op, fallback, env)
	return unsetDefaultOp(name, op, fallback, env)
}

/** Expand `${V:-D}` / `${V:=D}` / `${V:+A}` / `${V:?M}` (and bare `-`/`=`/
 * `+`/`?`) plus `${#V}`. `:=` on a truly-unset var assigns (as at
 * runtime); on a poisoned var the match is left for the poison guard —
 * `:=` never assigns over a set var, poisoned ones included. */
function expandOperandDefaults(word: string, env: ChainEnv): string {
	const pattern = /\$\{([A-Za-z_]\w*)(:-|:=|:\+|:\?|-|=|\+|\?)([^}]*)\}/g
	const expand = (m: string, n: string, o: string, f: string): string =>
		defaultOpValue(m, n, o, f, env)
	const withDefault = word.replace(pattern, expand)
	return withDefault.replace(/\$\{#[A-Za-z_]\w*\}/g, "")
}

/** Strip references to unknown/poisoned vars. Truly-unset vars expand to
 * empty at runtime, so stripping is EXACT (not an approximation): `>$U/x`
 * really writes `/x`, while bare `>$U` really errors (safe). Special vars
 * ($$, $?, $1...) are shell-provided, never stripped. */
function stripUnknownRefs(word: string, env: ChainEnv): string {
	const keepKnown = (m: string, name: string): string => {
		return isKnownVar(name, env) ? m : ""
	}
	const braced = word.replace(/\$\{([A-Za-z_]\w*)\}/g, keepKnown)
	return braced.replace(/\$([A-Za-z_]\w*)/g, keepKnown)
}

/** True when the word references a poisoned (unresolvable-valued) var.
 * Unlike truly-unset vars (which expand to empty — stripped exactly), a
 * poisoned var holds an UNKNOWN value, so any gated use fails closed. */
export function usesPoisonedVar(word: string, env: ChainEnv): boolean {
	const names: string[] = []
	word.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g, (_m, name: string) => {
		names.push(name)
		return _m
	})
	word.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
		names.push(name)
		return _m
	})
	return names.some((name) => env.poison.has(name))
}

/** The expanded-but-unresolved word: env + defaults + stripping, before
 * `~` and resolve. Lets `cd` distinguish "expanded to empty" (→ $HOME,
 * refused fail-closed) from literal `.` (stays, allowed). */
export function expandOperandWord(
	word: string,
	env: ChainEnv = newChainEnv(),
): string {
	const merged = { ...process.env }
	for (const [name, value] of env.overlay) merged[name] = value
	const expanded = expandEnv(expandOperandDefaults(word, env), merged)
	return stripUnknownRefs(expanded, env)
}

/**
 * Resolve a raw operand word to an absolute path: chain-overlay + process
 * env expansion (`${V:-D}` defaults honored, `:=` assigns), unknown-var
 * stripping (exact — unset vars expand to empty), `~` expansion, then
 * `path.resolve` against the command's working directory. TOTAL: unknown
 * input degrades to a stripped path whose containment check fails closed.
 */
export function resolveOperandTarget(
	word: string,
	cwd: string,
	env: ChainEnv = newChainEnv(),
): string {
	return path.resolve(cwd, expandHome(expandOperandWord(word, env)))
}

/**
 * Resolve a raw target word to an absolute path: env expansion, `~`
 * expansion, then `path.resolve` against the command's working directory
 * (relative targets anchor there). A trailing `/*` glob is dropped — deleting
 * "the store's contents" via `rm -rf <store>/*` targets the store itself.
 */
export function resolveCommandTarget(
	target: string,
	workspaceRoot: string,
	env: ChainEnv = newChainEnv(),
): string {
	let expanded = resolveOperandTarget(target, workspaceRoot, env)
	if (expanded.endsWith("/*")) {
		expanded = expanded.slice(0, -2)
	}
	return expanded
}

/**
 * Best-effort symlink resolution: `fs.realpathSync` when the path exists,
 * otherwise the lexical path unchanged (a not-yet-existing target can't be
 * resolved through a symlink, and that's fine — a `rm -rf` of a nonexistent
 * path is a no-op anyway). Never throws.
 */
function tryRealpath(p: string): string {
	try {
		return fs.realpathSync(p)
	} catch {
		return p
	}
}

/**
 * True when the resolved `target` is the central store root, an ancestor of
 * it, or a DESCENDANT of it. Checked both lexically (path.resolve) and
 * against the symlink-resolved realpath — the same convention
 * `resolveWithinWorkspace` documents for the harness's own path safety, plus
 * realpath so `ln -s <store> /tmp/x && rm -rf /tmp/x` is caught too. The
 * store root comes from project-store.ts's own resolver (projectStoreRoot),
 * never a second copy of that path logic.
 */
export function isCentralStoreOrParent(target: string): boolean {
	const storeRoot = projectStoreRoot()
	const candidates = new Set([path.resolve(target), tryRealpath(path.resolve(target))])
	for (const t of candidates) {
		if (t === storeRoot) {
			return true
		}
		// Ancestor: storeRoot is inside t.
		if (storeRoot.startsWith(t.endsWith(path.sep) ? t : t + path.sep)) {
			return true
		}
		// Descendant: t is inside storeRoot.
		if (t.startsWith(storeRoot.endsWith(path.sep) ? storeRoot : storeRoot + path.sep)) {
			return true
		}
	}
	return false
}

/** What a refused destructive command hit, for the model-facing message. */
export interface StoreDestructionRefusal {
	/** The resolved absolute target that matched (store root or an ancestor). */
	target: string
	/** The protected central store root (projectStoreRoot()). */
	storeRoot: string
}

/**
 * Check ONE sub-command (already split by parseCommand) for a recursive
 * delete targeting the central store or a parent of it. Returns a refusal
 * descriptor when it must be blocked, or `null` when it is not a
 * store-targeting destructive command. `workspaceRoot` anchors relative
 * targets (defaults to process.cwd()).
 */
export function checkCentralStoreDestruction(
	subCommand: string,
	workspaceRoot?: string,
	env: ChainEnv = newChainEnv(),
): StoreDestructionRefusal | null {
	const words = splitCommandWords(subCommand)
	if (!isRecursiveDelete(words)) {
		return null
	}
	const root = path.resolve(workspaceRoot ?? process.cwd())
	for (const target of deleteTargets(words)) {
		const hit = storeTargetHit(target, root, env)
		if (hit !== null) return hit
	}
	return null
}

function storeTargetHit(
	target: string,
	root: string,
	env: ChainEnv,
): StoreDestructionRefusal | null {
	if (usesPoisonedVar(target, env)) {
		return { target, storeRoot: projectStoreRoot() }
	}
	const resolved = resolveCommandTarget(target, root, env)
	if (!isCentralStoreOrParent(resolved)) return null
	return { target: resolved, storeRoot: projectStoreRoot() }
}
