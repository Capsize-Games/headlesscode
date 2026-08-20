/**
 * Browser control plane — launching a top-level session from the dashboard and
 * answering its escalated questions.
 *
 * Two capabilities, both deliberately thin wrappers around what already exists:
 *
 *  1. `launchSession` spawns the SAME CLI invocation `scripts/run-worker.sh`
 *     uses (`npx tsx src/cli.ts --task ... --mode ... --workspace ...`) as a
 *     DETACHED background process — `detached: true` + `unref()` — so the
 *     dashboard HTTP handler returns immediately and the session keeps running
 *     after the server's own process group is long gone. The child inherits
 *     the dashboard process's environment, which is exactly why
 *     `HEADLESSCODE_OPENROUTER_API_KEY` must be exported (e.g. `set -a; source .env`) when
 *     the dashboard itself is started — this endpoint does NOT re-source
 *     `.env` the way the CLI's other entry points do.
 *
 *  2. `answerSessionDecision` writes `.harness.decision-answer` in the
 *     session's workspace root — functionally identical to
 *     `scripts/headlesscode-answer.sh`, but without a subprocess for a
 *     one-line file write. The worker's `ask_followup_question` poll picks it
 *     up, deletes both markers, and resumes (see src/tools/executor.ts).
 *
 * Session id determinism: the launch endpoint generates the session id HERE
 * (a UUID, same generator HeadlessSession uses internally) and passes it to
 * the CLI via `--session-id` (added in src/cli.ts → HeadlessSessionConfig),
 * so the browser can open the session's live event view immediately instead
 * of polling for "whatever session showed up after we launched".
 *
 * The CLI string is split into argv and spawned WITHOUT a shell (spawn's
 * default), so the user's task text never passes through shell quoting —
 * no injection surface for a form-POST endpoint. `detached: true` still puts
 * the child in its own process group, matching the executor.ts idiom.
 *
 * This module is pure fs + child_process — no HTTP, so it's unit-testable
 * without spinning up the dashboard server (see the server.ts wrapper).
 */

import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"

/** Marker basenames, relative to the session's workspace root (src/tools/executor.ts idiom). */
const NEEDS_DECISION_FILENAME = ".harness.needs-decision"
const DECISION_ANSWER_FILENAME = ".harness.decision-answer"
/** Mid-session message injection marker (see src/engine/loop.ts's checkInjectedMessage). */
const INJECT_MESSAGE_FILENAME = ".harness.inject-message"

/** The default mode for a browser-launched top-level session. */
export const DEFAULT_LAUNCH_MODE = "multi-agent-orchestrator-headless"

/** Request body for POST /api/session/start. */
export interface SessionStartRequest {
	/** Workspace/repo root the session runs against. */
	repo?: string
	/** The user's typed prompt. */
	task?: string
	/** Mode slug (default: multi-agent-orchestrator-headless). */
	mode?: string
}

/** Request body for POST /api/session/:id/answer. */
export interface SessionAnswerRequest {
	answer?: string
}

export interface LaunchSessionResult {
	sessionId: string
	pid: number
	workspace: string
	mode: string
}

/** `chown` target for newly-created worktree files, e.g. "1000:1000". Unset = skip. */
export const WORKTREE_OWNER_ENV = "HEADLESSCODE_DASHBOARD_WORKTREE_OWNER"

/**
 * Return a stable, disposable worktree path for `sourceRepo` under
 * `worktreeRoot`, creating it (a fresh branch off the source repo's
 * current HEAD) the first time this pair is seen. Reused on every
 * subsequent call for the same source repo — NOT reset between
 * sessions, so it accumulates history like a real feature branch
 * rather than behaving as a throwaway per-launch sandbox.
 *
 * Container-deployment note: a worktree's `.git` is a
 * `gitdir: <host-absolute-path>` pointer back into the source repo's
 * `.git/worktrees/<name>` — the caller MUST mount `sourceRepo` at its
 * real host-absolute path (not a container-local alias) for that
 * pointer to resolve. `worktreeRoot` has no such constraint.
 *
 * `git worktree add` writes into BOTH the new worktree dir AND the
 * source repo's own `.git` (a new `worktrees/<name>` admin dir, a new
 * `refs/heads/<branch>`) — when this process runs as root (a
 * container's default; running as the host UID instead breaks the
 * image's own baked root-owned paths — see the compose file's
 * comment), those end up root-owned on the host, breaking ordinary
 * host-side git commands on `sourceRepo` afterward. `ownerEnv`
 * (`HEADLESSCODE_DASHBOARD_WORKTREE_OWNER`, e.g. "1000:1000") chowns
 * every path this call touched back to the host user; unset = skip
 * (today's behavior, for a deployment that doesn't need it).
 */
export function ensureWorktree(worktreeRoot: string, sourceRepo: string): string {
	const resolvedRepo = path.resolve(sourceRepo)
	const slug = path.basename(resolvedRepo).replace(/[^a-zA-Z0-9._-]+/g, "-") || "repo"
	const hash = createHash("sha1").update(resolvedRepo).digest("hex").slice(0, 8)
	const wtPath = path.join(worktreeRoot, `${slug}-${hash}`)
	if (fs.existsSync(path.join(wtPath, ".git"))) {
		return wtPath
	}
	fs.mkdirSync(worktreeRoot, { recursive: true })
	const branchLeaf = `${slug}-${hash}`
	const branch = `headlesscode-session/${branchLeaf}`
	execFileSync("git", ["-C", resolvedRepo, "worktree", "add", "-b", branch, wtPath], {
		stdio: "ignore",
		timeout: 60_000,
	})
	chownWorktreeArtifacts(wtPath, resolvedRepo)
	return wtPath
}

/**
 * chown `target` (recursive) to `HEADLESSCODE_DASHBOARD_WORKTREE_OWNER`, if
 * configured. Shared by `ensureWorktree`'s one-time setup chown and the
 * CLI's own post-session chown (see cli.ts, right after `session.run()`
 * returns) — worktree creation isn't the only thing that leaves root-owned
 * files behind when the whole process runs as root: the SESSION ITSELF
 * writes into the worktree throughout the run (file edits, its own
 * .headlesscode/{events,usage,reports}, git's own index as it stages
 * things) — see the doc comment on ensureWorktree for the container-as-
 * root rationale this all follows from. `label` is only used in the
 * non-fatal failure log line.
 */
export function chownPathForHostUser(target: string, label: string): void {
	const owner = process.env[WORKTREE_OWNER_ENV]?.trim()
	if (!owner || !fs.existsSync(target)) {
		return
	}
	try {
		execFileSync("chown", ["-R", owner, target], { stdio: "ignore", timeout: 30_000 })
	} catch (error) {
		process.stderr.write(
			`[worktree] chown ${owner} ${target} failed (non-fatal; ${label} may need manual chown): ` +
				`${error instanceof Error ? error.message : String(error)}\n`,
		)
	}
}

/**
 * `chownPathForHostUser(workspaceRoot, ...)` alone misses one thing: a
 * worktree's own `.git` is a plain-text `gitdir: <path>` pointer into the
 * SOURCE repo's `.git/worktrees/<name>/` admin dir (index, HEAD, etc.),
 * which git keeps updating for the life of the worktree (e.g. its own
 * `index` file changes as the session's `git` commands stage things) —
 * that admin dir lives OUTSIDE workspaceRoot entirely, so it needs its
 * own chown. No-ops (same as chownPathForHostUser) when the owner env
 * isn't configured or `workspaceRoot` isn't actually a worktree (a plain
 * `.git` directory, not a file, when a session runs directly against a
 * real repo instead of ensureWorktree's disposable copy).
 */
export function chownWorktreeWorkspace(workspaceRoot: string): void {
	chownPathForHostUser(workspaceRoot, `session workspace ${workspaceRoot}`)
	const gitPath = path.join(workspaceRoot, ".git")
	let stat: fs.Stats
	try {
		stat = fs.statSync(gitPath)
	} catch {
		return
	}
	if (!stat.isFile()) {
		return
	}
	const contents = fs.readFileSync(gitPath, "utf-8").trim()
	const match = /^gitdir:\s*(.+)$/.exec(contents)
	if (match) {
		chownPathForHostUser(match[1], `git-worktree admin dir for ${workspaceRoot}`)
	}
}

/** chown everything `ensureWorktree`'s `git worktree add` call just created, if configured. */
function chownWorktreeArtifacts(wtPath: string, sourceRepo: string): void {
	const targets = [
		wtPath,
		// The parent .git/worktrees/ dir itself gets created (root-owned)
		// on this repo's FIRST worktree ever — chown the whole thing, not
		// just this call's <name> subdirectory, so an earlier root-owned
		// parent doesn't linger.
		path.join(sourceRepo, ".git", "worktrees"),
		// The branch lives under refs/heads/headlesscode-session/<leaf>,
		// with a matching reflog under logs/ — chown both whole
		// headlesscode-session/ dirs since every worktree this function
		// creates shares them.
		path.join(sourceRepo, ".git", "refs", "heads", "headlesscode-session"),
		path.join(sourceRepo, ".git", "logs", "refs", "heads", "headlesscode-session"),
	]
	for (const target of targets) {
		chownPathForHostUser(target, `host-side git commands on ${sourceRepo}`)
	}
}

/**
 * Validate a session-start body. Returns a human-readable error string when
 * the body is unusable, undefined when it's acceptable.
 */
export function validateSessionStartBody(body: unknown): string | undefined {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		return "body must be a JSON object"
	}
	const { task, repo, mode } = body as Record<string, unknown>
	if (typeof task !== "string" || task.trim() === "") {
		return "missing or empty 'task' — provide the prompt text to run"
	}
	if (repo !== undefined && (typeof repo !== "string" || repo.trim() === "")) {
		return "'repo' must be a non-empty string path"
	}
	if (mode !== undefined && (typeof mode !== "string" || mode.trim() === "")) {
		return "'mode' must be a non-empty string slug"
	}
	return undefined
}

/** Split a CLI command string into argv (whitespace-separated, no shell). */
function splitCli(cli: string): string[] {
	return cli.split(/\s+/).filter((part) => part.length > 0)
}

/**
 * Launch a top-level HeadlessSession as a detached background process,
 * mirroring scripts/run-worker.sh's launch semantics (nohup-style, no
 * blocking on the child). Resolves once the child has been spawned — NOT
 * when it finishes, which is the whole point of detached/unref.
 */
export async function launchSession(
	options: {
		/** Repo root the session runs against (the dashboard's --repo, or a body override). */
		workspace: string
		task: string
		mode?: string
		/**
		 * CLI invocation template, e.g. "npx tsx src/cli.ts". Tests point it
		 * at a tiny fake script for fast, deterministic assertions.
		 */
		cli?: string
		/** Directory the CLI runs in (default: process.cwd() — the dashboard's cwd). */
		repoRoot?: string
	},
): Promise<LaunchSessionResult> {
	const sessionId = randomUUID()
	const mode = options.mode?.trim() ? options.mode.trim() : DEFAULT_LAUNCH_MODE
	const workspace = path.resolve(options.workspace)
	const cli = options.cli ?? "npx tsx src/cli.ts"
	// The dashboard may have been started from a different cwd than this repo;
	// the CLI runs with repoRoot as cwd so `npx tsx` finds src/cli.ts no
	// matter where the dashboard process was launched from.
	const repoRoot = path.resolve(options.repoRoot ?? process.cwd())

	const argv = [...splitCli(cli), "--task", options.task, "--mode", mode, "--workspace", workspace, "--session-id", sessionId]

	// NOTE (control-plane): the child inherits this process's environment —
	// HEADLESSCODE_OPENROUTER_API_KEY and OPENROUTER_BASE_URL (the e2e mock) included. The
	// dashboard is expected to have sourced .env at startup (see cli.ts's
	// dashboard help); this endpoint deliberately does not re-source it.
	const child = spawn(argv[0], argv.slice(1), {
		cwd: repoRoot,
		detached: true,
		stdio: "ignore",
		env: process.env,
	})

	// Detach fully: the child must neither keep the dashboard's event loop
	// alive nor die when the dashboard exits. It becomes its own process
	// group leader (detached: true) and keeps running independently.
	child.unref()

	return { sessionId, pid: child.pid ?? 0, workspace, mode }
}

/**
 * Answer a blocked session's pending `ask_followup_question` by writing
 * `<workspaceRoot>/.harness.decision-answer` (the marker
 * `ask_followup_question` polls for — see src/tools/executor.ts). Mirrors
 * scripts/headlesscode-answer.sh, in-process (no subprocess for a one-line
 * write; the two implementations must stay in sync).
 */
export async function answerSessionDecision(workspaceRoot: string, answer: string): Promise<void> {
	await fsp.writeFile(path.join(workspaceRoot, DECISION_ANSWER_FILENAME), answer, "utf-8")
}

/**
 * Inject a new user message into a RUNNING session by writing
 * `<workspaceRoot>/.harness.inject-message` (JSON: `{ text, injectedAt }`).
 * The loop's checkInjectedMessage (src/engine/loop.ts) picks it up before its
 * next LLM call, appends `text` as a plain user-role message, and deletes the
 * marker — the model sees it as if the user had just typed it, NOT as a tool
 * result or interruption. Mirrors answerSessionDecision's marker protocol;
 * deliberately a SEPARATE code path from answering an escalated question.
 *
 * Policy: ONE pending message per session — a second injection while the
 * first is still pending OVERWRITES it (overwrite-with-latest, no queue).
 */
export async function injectSessionMessage(workspaceRoot: string, text: string): Promise<void> {
	const marker = JSON.stringify({ text, injectedAt: new Date().toISOString() }) + "\n"
	await fsp.writeFile(path.join(workspaceRoot, INJECT_MESSAGE_FILENAME), marker, "utf-8")
}

/** Marker filenames, exported for tests. */
export const DECISION_MARKERS = {
	needsDecision: NEEDS_DECISION_FILENAME,
	decisionAnswer: DECISION_ANSWER_FILENAME,
} as const
