/**
 * `headlesscode init`'s .gitignore hygiene: ensure a target repo's
 * `.gitignore` excludes `.headlesscode/` so workspace-relative session
 * artifacts (events, reports, usage, scratch, memory) can never be
 * accidentally committed by a human `git add -A` after a first run.
 */

import * as fs from "node:fs"
import * as path from "node:path"

export type GitignoreActionResult =
	| { action: "created"; path: string }
	| { action: "appended"; path: string }
	| { action: "unchanged"; path: string }

/**
 * True when a `.gitignore` already covers `.headlesscode`. Accepts any of the
 * four common spellings (`.headlesscode/`, `/.headlesscode/`, `.headlesscode`,
 * `/.headlesscode`) plus a bare `*` — the same slash-normalizing,
 * segment-matching idiom src/codesearch/files.ts's fallback matcher uses.
 */
function gitignoreCoversHeadlesscode(content: string): boolean {
	for (const line of content.split("\n")) {
		const trimmed = line.trim()
		if (trimmed === "" || trimmed.startsWith("#")) {
			continue
		}
		const p = trimmed.replace(/^\/+/, "").replace(/\/+$/, "")
		if (p === ".headlesscode" || p === "*") {
			return true
		}
	}
	return false
}

/**
 * Ensure `<workspace>/.gitignore` ignores `.headlesscode/`:
 *   - file absent → created with the entry;
 *   - file present but not covering it → entry appended (existing content
 *     preserved byte-for-byte, no reformatting or reordering);
 *   - already covered → untouched.
 *
 * Never touches the filesystem when the workspace is not a real directory
 * (a missing workspace is `init`'s job to fail on, not this helper's to
 * silently create a `.gitignore` for).
 */
export function ensureWorkspaceGitignore(workspaceRoot: string): GitignoreActionResult {
	const gitignorePath = path.join(workspaceRoot, ".gitignore")
	try {
		if (!fs.statSync(workspaceRoot).isDirectory()) {
			return { action: "unchanged", path: gitignorePath }
		}
	} catch {
		return { action: "unchanged", path: gitignorePath }
	}

	let existing = ""
	let existed = false
	try {
		existing = fs.readFileSync(gitignorePath, "utf-8")
		existed = true
	} catch {
		// Missing .gitignore — start from empty.
	}

	if (gitignoreCoversHeadlesscode(existing)) {
		return { action: "unchanged", path: gitignorePath }
	}

	const entry = "# headlesscode session artifacts (events, reports, usage, scratch, memory)\n/.headlesscode/\n"
	const content = existing === "" || existing.endsWith("\n") ? existing + entry : existing + "\n" + entry
	fs.writeFileSync(gitignorePath, content, "utf-8")
	return { action: existed ? "appended" : "created", path: gitignorePath }
}
