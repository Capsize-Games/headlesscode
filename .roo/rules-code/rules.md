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
- **Need a file's import/export relationships before editing it?**
  `import_graph` over manually reading imports and cross-referencing by
  hand.

If a tool returns "not supported" (non-TS/JS file) or "could not resolve,"
that's a real, final answer for that file/symbol — fall back to
`read_file`/grep, don't retry.

## Once you have a line number, prefer `read_file`'s `indentation` mode

- When a `codebase_search` result, grep match, error stack trace, or
  definition lookup gives you a specific line number, prefer `read_file` in
  `indentation` mode anchored on that line (`{ path, mode: "indentation",
  indentation: { anchor_line: N } }`) over a broad `slice` read. It extracts
  the containing function/class/logical block — complete and syntactically
  valid, no mid-function truncation — instead of pulling up to 2,000 lines
  of surrounding file you then have to scroll through.
- This is guidance, not a hard rule. A `slice` read is still the right tool
  for initial file orientation (seeing the overall structure before you know
  which line matters), for reading a small config/data file in full, and for
  a specific contiguous line range. Indentation mode is the better choice
  when you already know the anchor: a targeted extraction beats a whole-file
  dump, and it keeps the session's context (and cost) down.
