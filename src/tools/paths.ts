/**
 * Path-safety guard (issue #128 leaf).
 *
 * resolveWithinWorkspace + PathTraversalError/SymlinkEscapeError lived in
 * src/tools/executor.ts, which the codeintel handlers, browser handler, and
 * vision tool need — pulling the whole executor back in and closing import
 * cycles. This leaf depends only on node builtins, so everyone can share the
 * guard cycle-free; src/tools/executor.ts re-exports the same names.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { PathTraversalError } from "./path-traversal-error.js"
import { SymlinkEscapeError } from "./symlink-escape-error.js"

/**
 * Resolve `p` against the workspace root and reject anything that escapes it.
 *
 * Two layers of containment (issue #64):
 *  1. Lexical: path.resolve + a prefix check — the classic `../` traversal
 *     guard. This alone is NOT sufficient: every `fsp` call in the file tools
 *     FOLLOWS symlinks, so an agent can `ln -s ~/.ssh <ws>/sshlink` and then
 *     read AND write outside the workspace through it. The protected-files
 *     guard is bypassed the same way — it only ever sees the
 *     workspace-relative lexical path.
 *  2. Symlink-following (assertNoSymlinkEscape): the real path of the deepest
 *     resolvable ancestor must stay inside the workspace root's own real
 *     path. An escaping symlink — as a directory component, as the target
 *     itself, or as a dangling symlink a later write would create THROUGH —
 *     is refused with SymlinkEscapeError. The ancestor walk keeps writes to
 *     not-yet-existing paths working (realpath on a nonexistent path throws).
 *
 * Documented boundary: a path is usable only if every existing component of
 * it really lives inside the workspace. A symlink that escapes is refused
 * even when it points somewhere "useful" (e.g. a node_modules symlinked to a
 * sibling checkout) — the model can still reach such paths through
 * execute_command, which has its own permission gate.
 */
export function resolveWithinWorkspace(root: string, p: string): string {
	const rootAbs = path.resolve(root)
	const target = path.resolve(rootAbs, p)
	if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
		throw new PathTraversalError(p, rootAbs)
	}
	assertNoSymlinkEscape(rootAbs, target, p)
	return target
}

/**
 * Reject a `target` whose real location (after following symlinks) escapes
 * `rootAbs`. Called by resolveWithinWorkspace after the lexical check.
 *
 * Walk up from `target` until an existing path is found, realpath it, and
 * require the result to stay inside the root's own realpath. Three cases
 * realpath can't answer directly, each handled explicitly:
 *  - Path doesn't exist yet (a write to a new file): walk up to the deepest
 *    existing ancestor — its real location decides where the write lands.
 *  - A component is a DANGLING symlink: realpath fails, but a write through
 *    it would create the target AT THE SYMLINK'S DESTINATION, so follow the
 *    chain (re-running the containment check on each hop) instead of walking
 *    past it.
 *  - A symlink cycle (realpath throws ELOOP): unresolvable — the kernel
 *    refuses reads/writes through it too, so nothing can escape; walk up.
 */
function assertNoSymlinkEscape(
	rootAbs: string,
	target: string,
	requested: string,
): void {
	const rootReal = realpathOrSelf(rootAbs)
	const seen = new Set<string>()
	let probe: string | null = target
	while (probe !== null) {
		probe = hopProbe(probe, seen, rootReal, rootAbs, requested)
	}
}

/** One containment hop: next probe to check, or null when verified. */
function hopProbe(
	probe: string,
	seen: Set<string>,
	rootReal: string,
	rootAbs: string,
	requested: string,
): string | null {
	if (seen.has(probe)) return parentOrNull(probe)
	seen.add(probe)
	let real: string
	try {
		real = fs.realpathSync(probe)
	} catch {
		return followDanglingOrWalkUp(probe)
	}
	throwIfEscaped(real, rootReal, rootAbs, requested)
	return null
}

/** Throw unless real stays inside the root's realpath. */
function throwIfEscaped(
	real: string,
	rootReal: string,
	rootAbs: string,
	requested: string,
): void {
	if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
		throw new SymlinkEscapeError(requested, rootAbs, real)
	}
}

/** Parent dir, or null at the filesystem root (nothing left to check). */
function parentOrNull(probe: string): string | null {
	const parent = path.dirname(probe)
	return parent === probe ? null : parent
}

/** lstat, or undefined when the path cannot be stated. */
function lstatOrUndefined(probe: string): fs.Stats | undefined {
	try {
		return fs.lstatSync(probe)
	} catch {
		return undefined
	}
}

/**
 * Next probe when realpath fails: a DANGLING symlink's destination (a
 * later write would create the target there) or the parent (missing
 * path, ELOOP cycle) — null at the filesystem root.
 */
function followDanglingOrWalkUp(probe: string): string | null {
	if (lstatOrUndefined(probe)?.isSymbolicLink()) {
		return path.resolve(path.dirname(probe), fs.readlinkSync(probe))
	}
	return parentOrNull(probe)
}

/** realpath of `p`, falling back to the lexical path when it can't resolve. */
function realpathOrSelf(p: string): string {
	try {
		return fs.realpathSync(p)
	} catch {
		return p
	}
}
