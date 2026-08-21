## Rules

- Unattended: never use ask_followup_question.
- Do not read files beyond what's given here — everything needed is
  below. Do not paginate through large files.
- Commit when done (this worktree/branch already checked out). Do not
  push, do not touch master.

## Fix GitHub issue #139 (small, scoped)

`gh issue view 139 --repo Capsize-Games/headlesscode` for full context
if you want it, but the fix itself is fully specified below — you
should not need it.

The real current code, `src/cli.ts` lines 875-876:

```ts
const codeModeBackend = process.env.HEADLESSCODE_CODE_MODE_BACKEND ?? "openrouter"
const useLocalCodeBackend = options.mode === "code" && codeModeBackend === "ollama"
```

Problem: when `HEADLESSCODE_CODE_MODE_BACKEND=ollama` is set but
`options.mode` is anything other than `"code"` (e.g. a custom mode
like `issue-filer`), the session silently runs on cloud OpenRouter
instead — no warning, no log line, nothing. Verified live 2026-08-21:
an `--mode issue-filer` session ran on cloud DeepSeek with this env
var set, with zero indication to the operator that the local backend
was requested but not applied.

Fix: add a `console.error` (not `console.log` — this should be
visible even if stdout is piped/filtered, matching how other
early-exit warnings in this file work, e.g. search for existing
`process.stderr.write` calls in this file for the exact style to
match) warning line right after line 876, firing ONLY when the env var
was explicitly set to `"ollama"` but `options.mode !== "code"` (so it
doesn't fire for the common case of just not setting the env var at
all). Something like:

```ts
if (codeModeBackend === "ollama" && options.mode !== "code") {
	process.stderr.write(
		`[headlesscode] NOTE: HEADLESSCODE_CODE_MODE_BACKEND=ollama is set, but --mode is "${options.mode}", not "code" — the local backend only applies to code mode today (see issue #139). This session will use the cloud OpenRouter model instead.\n`,
	)
}
```

Place this check right after the `useLocalCodeBackend` line so it
always fires when relevant, regardless of what happens later in the
function.

## Verification

- `npx tsc --noEmit -p .` clean.
- `npx tsx src/engine/__tests__/loop.test.ts` — all existing tests
  still pass (no new test required for this one, it's cli.ts stderr
  output, not something the existing loop.test.ts harness exercises —
  don't try to force a test into that file for this).
- Manually verify the warning actually prints: run
  `HEADLESSCODE_CODE_MODE_BACKEND=ollama npx tsx src/cli.ts --mode
  architect --task "test" --dry-run` (± exact flags — check `--help`
  if `--dry-run` isn't right, the point is triggering the code path
  without a real API key) and confirm the new stderr line appears.
  Paste the real output in your final report.

Commit message: `fix: warn when HEADLESSCODE_CODE_MODE_BACKEND=ollama
is set but --mode isn't code, instead of silently using cloud (#139)`

## Report back

What you changed (file:line), the real tsc/test output, and the real
manual-verification output showing the warning firing.
