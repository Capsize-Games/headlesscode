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
