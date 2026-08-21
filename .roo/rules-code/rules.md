# Rules for code mode

## Orient with `codebase_search` before whole-file reads

- Before reading whole files to answer "where is X?" or "how does Y work?",
  try `codebase_search` first when the workspace has an index. It searches
  semantically across the whole repo and returns `file:startLine-endLine`
  citations with snippets — the cheapest way to locate relevant code, and
  it avoids blind whole-file reads and grep/`curl`-via-`execute_command`
  exploration.
- If `codebase_search` returns "no codebase index found", that is a real
  signal that this workspace/worktree is not indexed — fall back to
  `read_file`/`list_files`/grep as before. It is not a transient error: do
  not retry the search, and do not build the index yourself mid-session
  (indexing is a separate, explicit, paid `headlesscode index` step).
- `codebase_search` complements, not replaces, `read_file`: once search
  tells you WHERE something is, `read_file` (slice, or indentation mode at
  the cited anchor line) is still how you actually see the full code to
  understand and edit it.

## Prefer code-intelligence tools over grep/read-and-scan

TypeScript/JavaScript files only. Each of these beats the generic fallback
next to it — reach for the specific tool, not the general one:

- **Need a file's structure without reading it whole?** `outline` over a
  full `read_file`.
- **Need where a symbol is actually defined?** `go_to_definition` over
  grep/`execute_command` text search — it's real compiler symbol
  resolution, not a text match, so it's correct on overloads, re-exports,
  and aliased imports where grep gives false hits or misses.
- **Need every real usage site of a symbol (a rename/change impact
  check)?** `find_references` over grep — same reasoning: grep finds text
  matches, this finds actual references.
- **Need to rename a symbol across multiple files?** `rename_symbol` over
  composing N separate `apply_diff`/`search_replace` edits — it reuses the
  same real reference resolution as `find_references` and applies every
  site atomically (all-or-nothing with rollback), replacing the
  read-every-file + edit-every-file round trip. Scope: TS/JS files inside
  the workspace only.
- **Need a file's import/export relationships before editing it?**
  `import_graph` over manually reading imports and cross-referencing by
  hand.

## Verify targeted tests, not the full suite, while iterating

- After editing a file, run the SPECIFIC test file(s) for what you changed
  via `run_tests` (it picks the direct `__tests__/` sibling and any test
  that imports the changed file through the real import graph) — or
  `npx tsx <test-file>` directly. Reserve the full `npm test` for the final
  confidence run right before `attempt_completion`; a passing selective run
  is NOT full-suite green.

## Use `set_indentation` for a pure indentation/whitespace-only fix

- **Need to fix ONE line's leading indentation and nothing else about
  it?** `set_indentation` (a line number + a tab count) over `edit_file`
  — edit_file requires typing the full line out twice, once in
  `old_string` and once in `new_string`, differing only in leading
  whitespace, which is easy to get subtly wrong (issue #141). Give it the
  real line number (confirm with `read_file` first if unsure) and the
  exact tab count you want the line to end up with — it replaces whatever
  indentation was there, it does not add to it.
- Only handles TAB-based indentation. If the file uses spaces, use
  `edit_file` instead.

## Execute the verification step your todo list names — don't re-derive it

- If your todo list's next item is "run baseline tests" or "verify coverage",
  call `run_tests` FIRST. One test run answers "is coverage intact" in a
  single shot; endless greps/reads of individual mappings cannot — and they
  burn the iteration budget (live failure: a 250-iteration round spent ~200
  read-only grep iterations re-verifying what one test run would have shown).
- Re-answering the same question with a slightly rephrased grep is a
  verification loop, not progress. The harness nudges you after 8 consecutive
  read-only iterations and hard-stops with a bounded failure after 75
  (`HEADLESSCODE_READ_ONLY_STALL_LIMIT`) — treat that nudge as a command to
  take a progress action: an edit, a `run_tests` call, or `attempt_completion`.

If a tool returns "not supported" (non-TS/JS file) or "could not resolve,"
that's a real, final answer for that file/symbol — fall back to
`read_file`/grep, don't retry.

## Reach for `describe_image` when a task references an image

- **Need to know what an image in the workspace actually shows** (a
  screenshot checked into the repo, a diagram, a design mockup, a broken-page
  capture)? `describe_image` with `{path}` returns a detailed text
  description from a cloud vision model — visible text verbatim, layout, UI
  states, what looks wrong — so you can act on images without ever seeing
  them. It costs a small real amount (an LLM API call); use it deliberately,
  not speculatively.
- **Do NOT call it for screenshots you took yourself with `browser_action`**
  — those are already auto-described in the screenshot result (and in that
  flow the description is what reaches you, never the raw PNG).
- Each call makes a real paid LLM request — when in doubt whether an image is
  even relevant, prefer reading the task/commit message first, then describe
  the image only if it matters.

## Once you have a line number, prefer `read_file`'s `indentation` mode

- When a `codebase_search` result, grep match, error stack trace, or
  definition lookup gives you a specific line number, prefer `read_file` in
  `indentation` mode anchored on that line (`{ path, mode: "indentation",
  indentation: { anchor_line: N } }`) over a broad `slice` read. It extracts
  the containing function/class/logical block — complete and syntactically
  valid, no mid-function truncation — instead of pulling hundreds of
  surrounding lines you then have to scroll through.
- A no-arg `slice` read returns only the first 600 lines by default
  (configurable via `HEADLESSCODE_READ_LIMIT`) — for a file longer than
  that, page the rest with explicit `offset`/`limit` rather than assuming
  the whole file came back.
- This is guidance, not a hard rule. A `slice` read is still the right tool
  for initial file orientation (seeing the overall structure before you know
  which line matters), for reading a small config/data file in full, and for
  a specific contiguous line range. Indentation mode is the better choice
  when you already know the anchor: a targeted extraction beats a whole-file
  dump, and it keeps the session's context (and cost) down.
