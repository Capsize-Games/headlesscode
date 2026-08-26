/**
 * Central per-project data store (plans/central-project-store-and-shared-instructions.md).
 *
 * Every per-project, cross-session data artifact that previously lived under a
 * workspace-relative `<workspaceRoot>/.headlesscode/` directory (codebase-search
 * index, mode-models.json, permissions.json) — and required manual seeding per
 * directory and per new worktree — now lives under ONE central, git-worktree-aware
 * location:
 *
 *   ~/.local/share/headlesscode/            (XDG data-dir convention; overridable
 *                                            via $HEADLESSCODE_DATA_DIR for tests)
 *     projects/
 *       <project-key>/
 *         codesearch/index.jsonl(.meta.json)
 *         mode-models.json
 *         permissions.json
 *         project.json                      (metadata: real path, kind, first-seen)
 *     checkpoints/                          (moved from ~/.headlesscode/checkpoints)
 *     shared/                               (Part B: modes.yaml + rules(-<mode>)/)
 *     settings.json                         (Part C: cross-project operational defaults)
 *
 * Project identity is resolved via git, NOT the raw workspace path:
 *
 *   - inside a git repo, `git rev-parse --git-common-dir` (resolved to an
 *     absolute path, then its parent) is the identity source. From INSIDE A
 *     WORKTREE this resolves to the MAIN repo's `.git`, so every worktree of a
 *     repo collapses onto the SAME central store as the main checkout — the
 *     property that makes the old spawn-script index/mode-models seeding
 *     obsolete (worktrees share the store for free).
 *   - a plain non-git directory falls back to its resolved (symlinks-followed)
 *     realpath.
 *
 * The identity string is hashed (sha256, truncated) into `<project-key>` — a
 * directory name, not a security boundary. `project.json` is written alongside
 * recording the real path the key was derived from, so a human inspecting
 * `projects/` can tell which directory is which without re-deriving the hash.
 *
 * One-time migration: the first run against a workspace that still has an
 * old-style `<workspaceRoot>/.headlesscode/` (index / mode-models.json /
 * permissions.json) moves that content into the central store — verified before
 * the source is removed, so real index data (a large repo's ~700MB) is never
 * orphaned or half-copied. Checkpoints move from `~/.headlesscode/checkpoints`
 * and the global modes/rules move from `~/.roo/` the same way. A human can
 * trigger all migrations explicitly via `headlesscode migrate`.
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

/**
 * The central data root. `$HEADLESSCODE_DATA_DIR` overrides it (used by tests
 * to redirect everything under a temp dir; also a legit per-machine escape
 * hatch). Default: the XDG data-dir convention `~/.local/share/headlesscode`.
 */
export function projectStoreRoot(): string {
	const override = process.env.HEADLESSCODE_DATA_DIR?.trim()
	return override ? path.resolve(override) : path.join(os.homedir(), ".local", "share", "headlesscode")
}

/** The shared-instructions subtree (Part B): `<root>/shared`. */
export function sharedInstructionsRoot(): string {
	return path.join(projectStoreRoot(), "shared")
}

export interface ProjectIdentity {
	/**
	 * Absolute filesystem path the project key is derived from: the parent of
	 * the resolved `--git-common-dir` (the MAIN repo root) for git repos, or
	 * the resolved realpath of the workspace root for plain directories.
	 */
	keySource: string
	/** "git" when inside a git repo (worktrees collapse to the main repo), "plain" otherwise. */
	kind: "git" | "plain"
}

/** The `<project-key>/project.json` metadata schema (see writeProjectMetadata). */
export interface ProjectMetadata {
	/** Absolute filesystem path the project key was derived from. */
	path: string
	kind: ProjectIdentity["kind"]
	/** ISO-8601 timestamp of first recorded contact (absent in pre-Part-B files). */
	firstSeen?: string
	/** ISO-8601 timestamp of the most recent contact (touched on every resolve). */
	lastSeen?: string
	/** True only when a human deliberately ran `headlesscode init` on this project. */
	registered: boolean
}

/**
 * Resolve the project identity source for a workspace root. Purely
 * filesystem-derived — zero registration, any directory works on first contact.
 */
export function resolveProjectIdentity(workspaceRoot: string): ProjectIdentity {
	const root = path.resolve(workspaceRoot)
	// 1. Git repo → `--git-common-dir` (worktree-aware: resolves to the main
	//    repo's .git from inside a worktree), parent = identity source.
	try {
		const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
			cwd: root,
			encoding: "utf-8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim()
		if (out !== "") {
			const commonDir = path.isAbsolute(out) ? out : path.resolve(root, out)
			return { keySource: realpathOrResolve(path.dirname(commonDir)), kind: "git" }
		}
	} catch (err) {
		// Not a git repo (or git missing) — fall through to the plain fallback.
		// Issue #83: "not a git repository" (exit 128) is the ordinary,
		// expected case for a plain directory and would spam every non-repo
		// workspace's log for no reason — only warn on a genuinely surprising
		// failure (git binary missing, permission denied, unexpected exit
		// code), so a real broken git invocation is still visible instead of
		// silently mis-keying the project.
		const status = (err as NodeJS.ErrnoException & { status?: number }).status
		const code = (err as NodeJS.ErrnoException).code
		if (code === "ENOENT" || (status !== undefined && status !== 128)) {
			process.stderr.write(
				`[project-store] git identity lookup failed for ${root} (falling back to plain-directory identity): ${err instanceof Error ? err.message : String(err)}\n`,
			)
		}
	}
	// 2. Plain directory → resolved absolute realpath of the workspace root.
	return { keySource: realpathOrResolve(root), kind: "plain" }
}

/** realpath when possible, else the plain resolved path (e.g. for a nonexistent root). */
function realpathOrResolve(p: string): string {
	try {
		return fs.realpathSync(p)
	} catch {
		return path.resolve(p)
	}
}

/** Derive `<project-key>` from the identity source (sha256, truncated to 16 hex chars). */
export function projectKeyFor(identitySource: string): string {
	return crypto.createHash("sha256").update(identitySource, "utf-8").digest("hex").slice(0, 16)
}

const projectDirCache = new Map<string, string>()

/** Migration log default: stderr (never pollutes stdout data streams). */
const defaultMigrationLog = (msg: string): void => {
	process.stderr.write(`[headlesscode-migrate] ${msg}\n`)
}

export interface MigrateOptions {
	/** Log sink for migration messages (default: stderr). */
	log?: (msg: string) => void
}

/**
 * Resolve the central data dir for a workspace: `<root>/projects/<project-key>`.
 * Cached per process per (resolved) workspace root, so the git exec + project.json
 * write happen at most once per session. Also performs the one-time legacy
 * `.headlesscode/` migration on first resolution (see migrateLegacyProjectData) —
 * SKIPPED under a $HEADLESSCODE_DATA_DIR override, exactly like the
 * checkpoint/shared-instructions auto-migrations: the override means "never move
 * real data", and the test suites run with an override against real workspace
 * roots (e.g. the run_tests end-to-end test runs with cwd = this repo). Under an
 * override the legacy files are still READ via the pre-migration-grace fallback
 * paths in mode-models/permissions/codesearch-index instead.
 */
export function resolveProjectDataDir(
	workspaceRoot: string,
	options: { registered?: boolean } = {},
): string {
	const root = path.resolve(workspaceRoot)
	const cached = projectDirCache.get(root)
	if (cached !== undefined) {
		return cached
	}
	const { keySource, kind } = resolveProjectIdentity(root)
	const key = projectKeyFor(keySource)
	const dir = path.join(projectStoreRoot(), "projects", key)
	projectDirCache.set(root, dir)
	// The project dir is always ensured (callers write index/mode-models/
	// permissions directly into it).
	try {
		fs.mkdirSync(dir, { recursive: true })
	} catch {
		// Non-fatal: a read-only store root falls back to legacy reads.
	}
	// Neither the metadata write nor the migration touches the store under a
	// $HEADLESSCODE_DATA_DIR override (the override means "test/scratch — don't
	// leave real store entries behind"; direct test runs construct executors
	// against throwaway /tmp workspaces, and without this guard every one of
	// them would litter the real ~/.local/share/headlesscode with a
	// projects/<hash>/project.json stub). The same applies when the resolved
	// keySource itself lives under the OS temp dir AND the store is the REAL
	// one: production code paths never create real workspaces under
	// os.tmpdir() (grep src/ for mkdtemp — only test files do), so it's a
	// reliable "ephemeral test/scratch" signal — BUT only when the write would
	// land in the real store. A test that sandboxes HOME under os.tmpdir()
	// (e.g. the init CLI's end-to-end registration test, which drops the
	// override to exercise the real no-override registration path) has both
	// its workspace AND its store under the temp dir; writing project.json
	// into that throwaway store is harmless and must keep working. The project
	// dir is always created (callers need somewhere to write
	// permissions.json/mode-models.json/index files); the guard only decides
	// whether a project.json gets stamped in and the legacy migration runs.
	if (!storeOverridden() && (isUnderSystemTmpDir(projectStoreRoot()) || !isUnderSystemTmpDir(keySource))) {
		writeProjectMetadata(dir, keySource, kind, { registered: options.registered })
		migrateLegacyProjectData(root, keySource, dir)
	}
	return dir
}

/** True when `p` resolves inside the OS temp directory (os.tmpdir()). */
export function isUnderSystemTmpDir(p: string): boolean {
	const tmp = realpathOrResolve(os.tmpdir())
	const rel = path.relative(tmp, p)
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/** Project metadata file name inside each `<project-key>/` dir. */
export const PROJECT_METADATA_FILE = "project.json"

/** Options controlling a project.json upsert. */
export interface WriteProjectMetadataOptions {
	/**
	 * True ONLY from `headlesscode init` (a human deliberately registering the
	 * project). Never downgraded by later contact: once true, it stays true
	 * until `headlesscode projects prune` removes the store entry.
	 */
	registered?: boolean
}

/**
 * Upsert `<project-key>/project.json`: a fresh write on first contact
 * (firstSeen = lastSeen = now, registered only when the caller opts in) and a
 * touch on every later contact (lastSeen = now; firstSeen and registered
 * preserved — registered is only ever promoted to true, never demoted back).
 */
export function writeProjectMetadata(
	dir: string,
	keySource: string,
	kind: ProjectIdentity["kind"],
	options: WriteProjectMetadataOptions = {},
): void {
	try {
		const metaPath = path.join(dir, PROJECT_METADATA_FILE)
		const now = new Date().toISOString()
		let existing: Record<string, unknown> = {}
		if (fs.existsSync(metaPath)) {
			try {
				const parsed = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as Record<string, unknown>
				if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
					existing = parsed
				}
			} catch {
				// Malformed existing file — fall through and rewrite fresh.
			}
		}
		const registered = options.registered === true || existing.registered === true
		const firstSeen = typeof existing.firstSeen === "string" ? existing.firstSeen : now
		fs.mkdirSync(dir, { recursive: true })
		fs.writeFileSync(
			metaPath,
			JSON.stringify({ path: keySource, kind, firstSeen, lastSeen: now, registered }, null, 2) + "\n",
			"utf-8",
		)
	} catch (err) {
		// Non-fatal: metadata is a human-convenience, never load-bearing.
		// Issue #83: still log it — a silently failing metadata write would
		// otherwise be invisible in harness.log.
		process.stderr.write(
			`[project-store] failed to write project metadata under ${dir} (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`,
		)
	}
}

/** Loose-parse `<project-key>/project.json`; undefined when absent, {} when malformed. */
function readProjectMetadata(dir: string): Partial<ProjectMetadata> | undefined {
	const metaPath = path.join(dir, PROJECT_METADATA_FILE)
	let raw: string
	try {
		raw = fs.readFileSync(metaPath, "utf-8")
	} catch {
		return undefined
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {}
		}
		return parsed as Partial<ProjectMetadata>
	} catch {
		return {}
	}
}

/** One row of `headlesscode projects list` / GET /api/projects. */
export interface ProjectListEntry {
	/** `<project-key>` — the store directory name. */
	key: string
	/** Real filesystem path from project.json; undefined when the file is missing/unparseable. */
	path: string | undefined
	kind: ProjectIdentity["kind"] | undefined
	firstSeen: string | undefined
	lastSeen: string | undefined
	registered: boolean
	/** Live fs.existsSync(path) check; false when path is undefined. */
	exists: boolean
	/** GitHub "owner/name" from the repo's origin remote (e.g.
	 * "owner/repo"); undefined when unparseable. */
	gitOwnerName: string | undefined
}

/**
 * Enumerate every directory in `<root>/projects/`. A dir with a missing or
 * unparseable project.json still yields an entry (registered:false,
 * exists:false, everything else undefined) — those are exactly the
 * pre-Part-A litter already on disk, and they must be visible/prunable too,
 * not silently skipped. Does NOT compute directory sizes (walking 2500+ dirs
 * recursively would make `list` slow on a polluted store); callers that want
 * sizes compute them lazily only for the entries they print.
 */
function gitRemoteOwnerName(projectPath: string | undefined): string | undefined {
	if (!projectPath) return undefined
	try {
		const url = execFileSync("git", ["-C", projectPath, "remote", "get-url", "origin"], {
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim()
		if (!url) return undefined
		// git@host:owner/name.git  |  https://host/owner/name.git
		const ownerName = url.startsWith("git@")
			? url.slice(url.indexOf(":") + 1)
			: url.includes("://")
				? url.slice(url.indexOf("://") + 3).split("/").slice(1).join("/")
				: url
		return ownerName.replace(/\.git$/, "") || undefined
	} catch {
		return undefined
	}
}

export function listProjectEntries(): ProjectListEntry[] {
	const root = path.join(projectStoreRoot(), "projects")
	let dirNames: string[]
	try {
		dirNames = fs.readdirSync(root)
	} catch {
		// Store root doesn't exist yet (or is unreadable) — nothing to list.
		return []
	}
	const entries: ProjectListEntry[] = []
	for (const name of dirNames) {
		const dir = path.join(root, name)
		try {
			if (!fs.statSync(dir).isDirectory()) {
				continue
			}
		} catch {
			continue
		}
		const meta = readProjectMetadata(dir)
		const projectPath = meta?.path
		entries.push({
			key: name,
			path: projectPath,
			kind: meta?.kind,
			firstSeen: meta?.firstSeen,
			lastSeen: meta?.lastSeen,
			registered: meta?.registered === true,
			exists: projectPath !== undefined && fs.existsSync(projectPath),
			gitOwnerName: gitRemoteOwnerName(projectPath),
		})
	}
	return entries
}

/** Old workspace-relative config dir name (also referenced from spawn scripts' docs). */
export const LEGACY_WORKSPACE_CONFIG_DIR = ".headlesscode"

/** Legacy `.headlesscode/<rel>` → central `<dest>` migration pairs. */
const LEGACY_MIGRATION_ENTRIES: Array<{ rel: string; dest: string }> = [
	{ rel: "codesearch", dest: "codesearch" },
	{ rel: "mode-models.json", dest: "mode-models.json" },
	{ rel: "permissions.json", dest: "permissions.json" },
]

/**
 * One-time migration of old-style workspace-relative `.headlesscode/` content
 * (codebase index, mode-models.json, permissions.json) into the central store.
 * Idempotent: skips an entry when the central target already exists or the
 * legacy source is absent. Checks BOTH the given workspace root and the
 * identity-derived main-repo root, so a session in a fresh worktree migrates the
 * MAIN checkout's legacy data (the only place it can be — worktrees share the
 * store). Content is moved only after the copy is verified intact (see
 * moveVerified); a failed move leaves the source in place.
 */
export function migrateLegacyProjectData(
	workspaceRoot: string,
	identityKeySource: string,
	centralDir: string,
	options: MigrateOptions = {},
): void {
	const log = options.log ?? defaultMigrationLog
	const candidates = new Set<string>([path.resolve(workspaceRoot)])
	try {
		candidates.add(path.resolve(identityKeySource))
	} catch {
		// keep just the workspace root
	}
	for (const candidate of candidates) {
		const legacyRoot = path.join(candidate, LEGACY_WORKSPACE_CONFIG_DIR)
		if (!fs.existsSync(legacyRoot)) {
			continue
		}
		for (const { rel, dest } of LEGACY_MIGRATION_ENTRIES) {
			const src = path.join(legacyRoot, rel)
			if (!fs.existsSync(src)) {
				continue
			}
			const target = path.join(centralDir, dest)
			if (fs.existsSync(target)) {
				continue
			}
			moveVerified(src, target, `${legacyRoot}/${rel}`, log)
		}
		// Drop the legacy dir only when nothing is left inside it.
		try {
			if (fs.readdirSync(legacyRoot).length === 0) {
				fs.rmdirSync(legacyRoot)
			}
		} catch (err) {
			// non-fatal: leftover empty legacy dir is harmless clutter, but
			// issue #83 wants it visible rather than silently swallowed.
			log(`could not remove legacy dir ${legacyRoot}: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
}

/**
 * Move `src` to `dest`, verifying the content landed intact before the source is
 * removed. rename() when both are on the same filesystem (the common case — the
 * checkpoints store and the central store are both under $HOME); on EXDEV (a
 * real cross-device move of a multi-hundred-MB index) fall back to a recursive
 * copy that compares sizes before unlinking the source. On any verification
 * failure the source is left in place and the error propagates — an interrupted
 * migration must never silently lose real index data.
 */
export function moveVerified(src: string, dest: string, label: string, log: (msg: string) => void = defaultMigrationLog): void {
	fs.mkdirSync(path.dirname(dest), { recursive: true })
	try {
		fs.renameSync(src, dest)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EXDEV") {
			throw err
		}
		copyVerified(src, dest)
		fs.rmSync(src, { recursive: true, force: true })
	}
	log(`migrated ${label} -> ${dest}`)
}

/** Recursive copy that verifies size equality file-by-file before returning. */
function copyVerified(src: string, dest: string): void {
	const st = fs.lstatSync(src)
	if (st.isDirectory()) {
		fs.mkdirSync(dest, { recursive: true })
		for (const entry of fs.readdirSync(src)) {
			copyVerified(path.join(src, entry), path.join(dest, entry))
		}
	} else if (st.isSymbolicLink()) {
		fs.symlinkSync(fs.readlinkSync(src), dest)
	} else if (st.isFile()) {
		fs.copyFileSync(src, dest)
		if (fs.statSync(src).size !== fs.statSync(dest).size) {
			throw new Error(`migration copy verification failed: size mismatch for '${src}'`)
		}
	}
}

/**
 * True when the store root was overridden via $HEADLESSCODE_DATA_DIR (tests,
 * per-machine scratch). Auto-migrations that touch REAL home-directory data
 * (`~/.headlesscode/checkpoints`, `~/.roo/`) must skip entirely under an
 * override — the override means "don't touch real data", and the explicit
 * `headlesscode migrate` subcommand remains the human-triggered path for real
 * machines.
 */
export function isStoreOverridden(): boolean {
	return (process.env.HEADLESSCODE_DATA_DIR ?? "").trim() !== ""
}

function storeOverridden(): boolean {
	return isStoreOverridden()
}

let checkpointMigrationAttempted = false

/**
 * Consolidate the checkpoint store: `~/.headlesscode/checkpoints` →
 * `<root>/checkpoints`. The old location holds real, large data (2.5GB on the
 * project owner's machine), so this is a verified MOVE, never a copy-and-orphan.
 * Runs automatically once per process on the first `defaultCheckpointDir()`
 * call and is also exposed via `headlesscode migrate` for explicit
 * human-triggered runs. Safe when both locations already exist (the old one is
 * left alone rather than silently merged).
 */
export function migrateCheckpointStore(options: MigrateOptions & { legacyDir?: string } = {}): void {
	const log = options.log ?? defaultMigrationLog
	const legacyDir = options.legacyDir ?? path.join(os.homedir(), ".headlesscode", "checkpoints")
	const targetDir = path.join(projectStoreRoot(), "checkpoints")
	if (!fs.existsSync(legacyDir)) {
		return
	}
	if (fs.existsSync(targetDir)) {
		return
	}
	moveVerified(legacyDir, targetDir, legacyDir, log)
}

/**
 * Auto-migrate `~/.headlesscode/checkpoints` once per process (called from
 * defaultCheckpointDir). Skipped entirely when the store is overridden via
 * $HEADLESSCODE_DATA_DIR (tests/scratch must never move REAL home data).
 */
export function ensureCheckpointMigration(): void {
	if (storeOverridden()) {
		return
	}
	if (checkpointMigrationAttempted) {
		return
	}
	checkpointMigrationAttempted = true
	try {
		migrateCheckpointStore()
	} catch {
		// Non-fatal: a failed migration leaves the legacy dir in place; the
		// service still works against whichever location exists.
	}
}

/**
 * Migrate the global shared-instructions content out of `~/.roo/` (the
 * Zoo-Code-branded location) into `~/.local/share/headlesscode/shared/`:
 * `custom_modes.yaml` → `modes.yaml`, `rules/` → `rules/`,
 * `rules-<mode>/` → `rules-<mode>/`. Only the LOOKUP PATH changes — the YAML
 * format and the rules-directory-scanning convention are unchanged. Part of the
 * same one-time migration family as the workspace data + checkpoints; exposed
 * via `headlesscode migrate` and auto-run on first custom-modes load.
 */
export function migrateSharedInstructions(options: MigrateOptions & { legacyRoot?: string } = {}): void {
	const log = options.log ?? defaultMigrationLog
	const legacyRoot = options.legacyRoot ?? path.join(os.homedir(), ".roo")
	const targetRoot = sharedInstructionsRoot()
	if (!fs.existsSync(legacyRoot)) {
		return
	}
	const pairs: Array<[string, string]> = [["custom_modes.yaml", "modes.yaml"], ["rules", "rules"]]
	let legacyEntries: string[] = []
	try {
		legacyEntries = fs.readdirSync(legacyRoot)
	} catch {
		return
	}
	for (const entry of legacyEntries) {
		if (entry.startsWith("rules-")) {
			pairs.push([entry, entry])
		}
	}
	for (const [rel, dest] of pairs) {
		const src = path.join(legacyRoot, rel)
		if (!fs.existsSync(src)) {
			continue
		}
		const target = path.join(targetRoot, dest)
		if (fs.existsSync(target)) {
			continue
		}
		moveVerified(src, target, path.join(legacyRoot, rel), log)
	}
}

let sharedInstructionsMigrationAttempted = false

/**
 * Auto-migrate `~/.roo/` shared content once per process (called from
 * loadCustomModes). Skipped entirely when the store is overridden via
 * $HEADLESSCODE_DATA_DIR (tests/scratch must never move REAL home data).
 */
export function ensureSharedInstructionsMigration(): void {
	if (storeOverridden()) {
		return
	}
	if (sharedInstructionsMigrationAttempted) {
		return
	}
	sharedInstructionsMigrationAttempted = true
	try {
		migrateSharedInstructions()
	} catch {
		// Non-fatal: a failed migration leaves ~/.roo/ in place.
	}
}

/** Read the central settings.json (Part C: cross-project operational defaults). */
export interface CentralSettings {
	embedding?: {
		/** Default OpenRouter embedding model id (overridable per build via env/--model). */
		model?: string
		/** Provider pin for embedding requests (OpenRouter provider name, e.g. "DeepInfra"). */
		provider?: string
		/** Allow fallbacks to other providers when the pinned one is unavailable. */
		allowFallbacks?: boolean
	}
}

/** Loose-parse `<root>/settings.json`; {} when absent/malformed (never throws). */
export function loadCentralSettings(): CentralSettings {
	const file = path.join(projectStoreRoot(), "settings.json")
	let raw: string
	try {
		raw = fs.readFileSync(file, "utf-8")
	} catch {
		return {}
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {}
		}
		const embedding = parsed.embedding
		if (embedding === null || typeof embedding !== "object" || Array.isArray(embedding)) {
			return { ...(parsed as CentralSettings) }
		}
		const out: CentralSettings = { ...(parsed as CentralSettings) }
		const emb = embedding as Record<string, unknown>
		out.embedding = {
			...(typeof emb.model === "string" && emb.model.trim() !== "" ? { model: emb.model } : {}),
			...(typeof emb.provider === "string" && emb.provider.trim() !== "" ? { provider: emb.provider } : {}),
			...(typeof emb.allowFallbacks === "boolean" ? { allowFallbacks: emb.allowFallbacks } : {}),
		}
		return out
	} catch {
		return {}
	}
}
