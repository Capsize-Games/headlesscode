# Minimal MCP client support (stdio servers only) — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop (ported
from a VS Code extension called Zoo Code). The full original source is also
available for reference (read-only, do not edit) at `zoo-code/` in this repo.

Match this project's established style: no test framework (plain `tsx`-run
test files, `All N tests passed` trailer); `npx tsc --noEmit` and `npm test`
must stay green; re-run every e2e suite under `scripts/e2e*/run.sh`.

**This is a real port job, not a small task. Read the scoping section below
carefully — it deliberately cuts real scope out of Zoo Code's actual MCP
implementation, and you should not try to build the full thing.**

## The problem

`access_mcp_resource` (and dynamically-generated per-MCP-server tools via
`mcp_server.ts`'s `getMcpServerTools`) are vendored tool-schema generators
with no real backing — `src/vendor/zoo-code/src/services/mcp/McpHub.ts` is
currently a 36-line SHIM (read its own header comment: "The real McpHub
manages MCP server connections through the VS Code API... This stub
satisfies the type surface... Wiring real MCP transports is deferred").
`use_mcp_tool`/`access_mcp_resource` are both in `executor.ts`'s stub set.
The real `McpHub.ts` in `zoo-code/src/services/mcp/` is **2,524 lines** and
handles SSE + stdio transports, global vs. project config, OAuth for remote
servers, connection lifecycle, and VS Code-specific secret storage
(`SecretStorageService.ts`) — do not attempt to port all of that.

## Scoping — what this task actually builds (v1 boundary, deliberate)

**In scope:** local **stdio-transport** MCP servers only (an MCP server run
as a local child process communicating over stdin/stdout — the simplest,
most common case, and the one that needs no OAuth/network-auth complexity).
Config-driven: a new `<workspaceRoot>/.headlesscode/mcp-servers.json` (or
reuse whatever config-file idiom fits — follow the fail-loudly-on-malformed-
input pattern already established for `permissions.json`/`mode-models.json`)
listing server name -> command + args to launch it.

**Explicitly OUT of scope for this task** (real gaps, deliberately deferred,
not accidentally missed):
- Remote/SSE MCP servers and any OAuth flow (`McpOAuthClientProvider.ts`,
  `SecretStorageService.ts` in the real implementation) — VS Code's secret
  storage has no headless equivalent, and OAuth flows need a browser-based
  human-in-the-loop step that doesn't fit an unattended headless worker.
- MCP server marketplace/discovery UI — no UI concept fits here.
- Global vs. project config layering — one config file, one scope, for
  this v1.
- Dynamic reconnection/hot-reload of server config mid-session — a
  session's MCP server set is fixed at session start.

If you find, while reading the real `McpHub.ts`, that stdio-only support is
still substantially more complex than this scoping implies, say so plainly
in your report with specifics rather than silently cutting further corners
or forcing a bad fit.

## What to build

**1. A minimal stdio MCP client.** Use the official `@modelcontextprotocol/sdk`
npm package if it's a reasonable, well-maintained dependency for stdio
transport specifically (check its actual API before assuming — this project
otherwise avoids heavy dependencies, but reimplementing the MCP wire
protocol from scratch instead of using the reference SDK for JUST the
transport/handshake layer would be a worse tradeoff; use your judgment and
justify the choice in your report). New `src/mcp/client.ts` (or similar):
spawn each configured server as a child process, perform the MCP
initialization handshake, list its available tools/resources.

**2. Wire into tool selection.** `getMcpServerTools`-equivalent: for each
connected server, generate real `ChatTool` entries (following
`src/vendor/zoo-code/src/core/prompts/tools/native-tools/mcp_server.ts`'s
existing naming/dedup logic for the shape, even though its `McpHub`
dependency needs your new client instead of the stub) so the model actually
sees real MCP-provided tools alongside the built-in ones, not just the
generic `access_mcp_resource` schema.

**3. Wire into the executor.** `use_mcp_tool`/`access_mcp_resource` handlers
in `src/tools/executor.ts` (move both from the stub set to
`IMPLEMENTED_TOOLS`, following the precedent of prior tools added to that
set) actually calling through to the connected server via your new client,
returning real results (or a clear error if the server/tool doesn't exist
or the call fails — never a crash).

**4. Session lifecycle.** Spawn configured MCP servers at session start
(only when `mcp-servers.json` exists — zero config = zero behavior change,
same idiom as every other optional feature in this project), tear them down
cleanly at session end (extend `ToolExecutor.dispose()`'s existing
child-process-cleanup pattern — it already hard-kills backgrounded
`execute_command` children at session end, follow that same discipline for
MCP server processes so nothing orphans).

## What NOT to do

- Do not implement SSE/remote transport or OAuth — explicitly out of scope,
  see above.
- Do not build a marketplace/discovery UI.
- Do not let an MCP server's failure to start/crash mid-session take down
  the whole coding session — non-fatal, logged, the model just doesn't have
  that server's tools for the rest of the session (matching the
  non-fatal-degradation idiom already used for memory/checkpoints
  elsewhere in `loop.ts`).
- Do not leave orphaned child processes on session end.

## Tests

- `src/mcp/__tests__/client.test.ts`: connect to a tiny real fixture MCP
  server (a minimal stdio server you write for test purposes, following
  whatever the MCP SDK's own testing conventions are, or a fake process
  that speaks just enough of the protocol) — list tools, call a tool, get a
  result.
- A test proving zero-config (no `mcp-servers.json`) is a complete no-op —
  no process spawned, no behavior change.
- A test proving a server that fails to start doesn't crash the session
  (non-fatal degradation).
- A test proving session end actually kills spawned MCP server processes
  (mirror the existing `execute_command` orphan-reaping test's approach —
  check `src/engine/__tests__/loop.test.ts` for
  `"execute_command: session end reaps backgrounded children"` as the
  pattern to follow).

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. A real manual smoke test against an actual local MCP server (even a
   trivial reference/example one) if you have anything available to test
   against; if not, say so plainly and describe what you verified instead
   (protocol-level unit tests against a fixture stdio process).

## What to report back

- Files changed/added.
- Whether you used the official MCP SDK or a hand-rolled minimal client,
  and why.
- Confirmation of tsc/test/e2e results.
- Whether a real MCP server was tested against, or why not.
- Any deviation from this spec's scoping, and why — especially if the real
  `McpHub.ts` revealed the stdio-only scope is still more complex than
  expected.
