/** A path that escapes the workspace root (issue #64). */
export class PathTraversalError extends Error {
	constructor(requested: string, root: string) {
		super(`Path escapes the workspace root (${root}): ${requested}`)
		this.name = "PathTraversalError"
	}
}
