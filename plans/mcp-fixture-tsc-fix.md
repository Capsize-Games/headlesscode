# Fix mcp-tool-support's stalled tsc error — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop.
`plans/mcp-tool-support.md`'s worker stopped with a real `tsc` error and its
worktree/branch were correctly retained rather than merged
(`.worktrees/mcp`, branch `issues/mcp-2026-08-01`). An independent review
(`plans/review-todays-batch.md`) reproduced the exact same error and
confirmed the stop was legitimate. This task fixes it and finishes the merge.

Match this project's established style: no test framework (plain `tsx`-run
test files, `All N tests passed` trailer); `npx tsc --noEmit` and `npm test`
must stay green; re-run every e2e suite under `scripts/e2e*/run.sh`.

## The bug, already root-caused — this is a small, precise fix

`npx tsc --noEmit` in `.worktrees/mcp` fails at
`src/mcp/__tests__/fixtures/mcp-test-server.ts:37,48` (and the same pattern
again at line 48 for a second tool registration): `type 'string' is not
assignable to type 'AnySchema'` / `'text' does not exist in type
'AnySchema'`.

**Root cause:** `@modelcontextprotocol/sdk`'s high-level `McpServer.registerTool`
API expects `inputSchema` as a **Zod raw shape** (e.g. `{ text: z.string() }`,
using the `zod` package already in this project's dependencies —
`package.json` already has `"zod": "^3.25.76"`), NOT a raw JSON-Schema object
like `{ type: "object", properties: {...}, required: [...] }`. The fixture
file currently passes the JSON-Schema shape (which is what the LOW-LEVEL
`Server` API's protocol-level `tools/list` responses use, a different layer
of the same SDK) to the high-level convenience wrapper, which is a type
mismatch, not a logic error.

## What to build

In `.worktrees/mcp/src/mcp/__tests__/fixtures/mcp-test-server.ts`: change
both `registerTool` calls' `inputSchema` from the JSON-Schema object shape to
a Zod raw shape:

```ts
import { z } from "zod"

// ...
server.registerTool(
	"reverse",
	{
		description: "Reverse a string",
		inputSchema: { text: z.string() },
	},
	async (args: { text: string }) => {
		return { content: [{ type: "text", text: [...args.text].reverse().join("") }] }
	},
)
```

Apply the same shape change to the `capitalize` tool registration. **Verify
this actually fixes it and matches the SDK's real expected type** — don't
just trust this document's snippet, confirm against the SDK's own type
definitions (`node_modules/@modelcontextprotocol/sdk/dist/**/mcp.d.ts` or
similar) that `ZodRawShape` is indeed what `registerTool`'s second-argument
`inputSchema` field expects, since getting the exact SDK version's real type
right matters more than pattern-matching this snippet.

**Check whether the SAME mismatch exists anywhere in the real
(non-fixture) implementation** — `src/mcp/client.ts` or wherever the
production MCP client code lives in this worktree. The fixture is a test
double for a real MCP server, but if the actual production code (e.g.
anywhere it might construct or validate tool schemas) has the same JSON-
Schema-vs-Zod-shape confusion, fix that too, not just the fixture — that
would be a real production bug hiding behind what looked like "just a test
fixture typo."

## What NOT to do

- Do not change anything about the actual MCP protocol/transport logic —
  this is purely a type-shape fix in how a tool's input schema is declared
  to the SDK's high-level API.
- Do not weaken or remove the fixture's existing test coverage (the
  deliberately-broken `capitalize` tool, the marker-file dispose() check,
  etc.) — fix the schema declaration, keep everything else as-is.

## Verification checklist

1. `npx tsc --noEmit` clean in `.worktrees/mcp` (this is the specific thing
   that was broken — confirm it's actually fixed, don't assume).
2. `npm test` — all suites green, including the MCP client tests that
   depend on this fixture actually starting up correctly.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. Merge to master following this project's established procedure: commit
   in the worktree, `--no-ff` merge to master, push, remove the worktree +
   branch — same as every other task this session.

## What to report back

- Confirmation of the exact SDK type you verified `inputSchema` against.
- Whether the same mismatch existed anywhere in production code (not just
  the fixture), and what you found.
- Confirmation of tsc/test/e2e results.
- Confirmation the merge completed and the worktree/branch were cleaned up.
