## Rules for this session

- Unattended: `ask_followup_question` will not reach a human. Never
  use it — just decide and proceed.
- Do NOT read any file not named below. Everything you need is
  already given here. Do not paginate through `loop.test.ts` — you
  are given the exact pattern to copy below.
- `execute_command` blocks `$(...)` substitution — use literal values.
- Commit each fix separately on this branch (already checked out,
  `.worktrees/self-fix`). Do not push, do not touch master.

## Fix 1 — GitHub issue #136 (verifyBeforeCompletion)

You already read `src/engine/loop.ts` lines 3197-3276 in a prior turn
this session — that's the `verifyBeforeCompletion` check block
(`if (this.config.verifyBeforeCompletion && lastExecuteCommandFailed)`).

Add a second condition to that same `if` block (OR'd with the existing
`lastExecuteCommandFailed` check, don't remove it): also refuse when
the `attempt_completion` result text contains a measurement-shaped
claim (matches `/\d+(\.\d+)?\s*(tokens?\/sec|t\/s|%|ms|seconds?)\b/i`
or the words "measured"/"benchmark") but no `execute_command` tool
result anywhere in `this.state.messages` history contains a number
(matches `/\d/`) in its content. When refused this new way, push the
same style of corrective nudge message used for the existing
`lastExecuteCommandFailed` path (find that exact message text at
line ~3197-3276 and copy its structure/tone), but naming this specific
reason: no command output in history contains any evidence for the
numeric/measurement claim being made.

Write ONE new test in `src/engine/__tests__/loop.test.ts`, appended
right before the `const tests: Array<[string, () => Promise<void>]> = [`
array (find that line near the end of the file, add your test function
above it, then add one entry to the array pointing at it). Model it
EXACTLY on this real pattern already in the file (a fake LLM client
issuing scripted tool calls, `makeSession`, `assert.*` on the result):

```ts
async function testCompletionRefusedWithUnsupportedMeasurementClaim(): Promise<void> {
	const ws = await mkGitWorkspace()
	if (ws === null) {
		console.log("  skip test (git not installed)")
		return
	}
	try {
		const client = new FakeLlmClient([
			() => toolCall("execute_command", { command: "echo ready" }),
			() => toolCall("attempt_completion", { result: "Benchmark complete: 205.9 tokens/sec measured." }),
			() => toolCall("attempt_completion", { result: "Ran the real benchmark, see above." }),
		])
		const session = await makeSession({ task: "benchmark something", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		const completionMsgs = session.state.messages.filter((m) => m.role === "tool" && m.name === "attempt_completion")
		assert.equal(completionMsgs.length, 1, "only the accepted completion produced a tool message")
		// the FIRST attempt_completion (with the unsupported "205.9 tokens/sec"
		// claim, no execute_command output containing any digit) must have been
		// refused with a nudge — assert on messages BEFORE the accepted one
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}
```

Adapt this skeleton for real: the first `attempt_completion` (with the
unsupported number claim) must be refused by your new check (assert a
tool message exists whose content matches your nudge text, same way
`testCompletionNudgedOnUncommittedChanges` asserts on
`completionMsgs[0]?.content` with `assert.match`), and the SECOND
`attempt_completion` (no unsupported claim) must be accepted. Also
verify existing behavior is unchanged: `lastExecuteCommandFailed`
still refuses independent of your new check (don't need a new test for
this if an existing one already covers it — just don't break it).

Run: `npx tsx src/engine/__tests__/loop.test.ts` — must show
`All N tests passed` with N one more than before your change, and
`npx tsc --noEmit -p .` clean.

Commit: `git add -A && git commit -m "fix: verifyBeforeCompletion also
checks completion claims have supporting evidence (#136)"`

## Fix 2 — GitHub issue #137 (ask_followup_question overuse)

You already read `src/engine/prompt.ts` lines 340-420
(`buildLeanSystemPrompt`) and `src/cli.ts` lines 900-946 (the local-only
guardrail flags: `requireExplicitCompletion`, `patchLocalToolSchemas`,
`verifyBeforeCompletion`, `guardLargeOverwrites`) in a prior turn.

In `cli.ts`, add a new flag right after `guardLargeOverwrites`,
following the EXACT same pattern (a short doc comment citing this
issue, `useLocalCodeBackend && !envBoolean("HEADLESSCODE_ALLOW_...")`):

```ts
const discourageFollowupQuestions =
	useLocalCodeBackend && !envBoolean("HEADLESSCODE_ALLOW_FREE_FOLLOWUP_QUESTIONS")
```

Pass it into the `HeadlessSession` config object (find where the other
flags like `requireExplicitCompletion` are passed in — same object,
add this one alongside them, same key name).

In `prompt.ts`'s `buildLeanSystemPrompt`, thread a new boolean option
through its `options` parameter (add to whatever options interface it
uses, matching how other conditional-prompt-text flags in that
function already work) and, when true, append ONE short paragraph to
the built prompt text: something like "Prefer making a reasonable,
reversible decision yourself and stating your reasoning over calling
ask_followup_question — reserve that tool for genuinely destructive or
ambiguous choices you cannot safely guess." Keep it to 1-2 sentences,
matching the terse tone of the rest of that prompt.

Wire `discourageFollowupQuestions` from `cli.ts` into whatever call
site builds the local session's system prompt (trace from
`buildLeanSystemPrompt`'s call site — it's used somewhere in
`loop.ts`'s session setup; if you can't find the call site without
reading more than the given ranges, add the option to the function
signature and its config type, then grep ONLY for
`buildLeanSystemPrompt(` to find the one call site to update — a grep
is fine, do not read whole files).

No new automated test required for this one (it's a prompt-text
change, hard to unit test meaningfully) — just confirm
`npx tsc --noEmit -p .` is clean and `npx tsx
src/engine/__tests__/loop.test.ts` still shows all tests passing.

Commit: `git add -A && git commit -m "feat: discourage
ask_followup_question overuse in local sessions (#137)"`

## When both are done

Call `attempt_completion` with a summary: which lines you changed in
each file, the real test-run output (paste it), and confirmation both
commits exist (`git log --oneline -3`).
