import { PathTraversalError } from "./path-traversal-error.js"

/**
 * A path whose REAL location (after following symlinks) escapes the
 * workspace even though its lexical path stays inside it (issue #64).
 * Subclasses PathTraversalError so existing callers that catch the base
 * class (e.g. the dashboard's HTTP layer, which maps it to a 400) keep
 * treating it the same way.
 */
export class SymlinkEscapeError extends PathTraversalError {
	constructor(requested: string, root: string, resolvedTo: string) {
		super(requested, root)
		this.name = "SymlinkEscapeError"
		this.message = `Path escapes the workspace root through a symlink (${root}): `
			+ `${requested} — it resolves to ${resolvedTo}`
	}
}
