# Code intelligence tools: go-to-definition, outline, find-references, import graph — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. This
adds real code-navigation tools the model currently doesn't have, motivated
by a concrete observation: `read_file` is used extensively (confirmed via
real session data today), the model has no way to jump straight to a
symbol's definition or see a file's structure without reading it in full,
and it currently falls back to `grep`-via-`execute_command` for symbol
lookup, which returns noisy, unstructured output the model has to parse
itself (import lines, comments, similar names all mixed in with the real
definition).

Match this project's established style: no test framework (plain `tsx`-run
test files, hand-rolled `assert`, `All N tests passed` trailer); `npx tsc
--noEmit` and `npm test` must stay green; re-run every e2e suite under
`scripts/e2e*/run.sh`.

**This is a real port/build job, not a small task — four related tools
sharing one underlying analysis module. Read the whole document before
writing code.**

## Why one shared module, not four independent tools

All four tools need the same foundational capability: parse the project's
real TypeScript source (respecting its actual `tsconfig.json` — this
repo's own config has `paths` aliases like `vscode` →
`src/vendor/zoo-code/shim/vscode.ts` that MUST resolve correctly, or symbol
resolution will be wrong for a meaningful chunk of this codebase) and
answer structural questions about it. Building four independent
implementations would either duplicate that setup four times or, worse,
drift into four subtly different and inconsistent analyses. Build ONE
module (e.g. `src/codeintel/`) that owns parsing/program-loading, and four
thin tool handlers on top of it.

**This project already depends on `typescript` (`^5.6.0`, `package.json`)
— use its real Compiler API (`ts.createProgram`,
`ts.parseJsonConfigFileContent`, the type checker's symbol resolution) for
real, correct answers, not a regex/heuristic approximation.** Do not invent
your own JS/TS parser. Verify the actual API surface you need against the
installed `typescript` version's real type definitions before writing
code — do not assume a specific method signature from general familiarity
with older or newer TS API versions; APIs like this have changed release to
release.

**This makes these tools inherently TypeScript/JavaScript-aware.** A
request against a non-TS/JS file (e.g. a Python file in a project this
harness might run against, or a Markdown file) must return a clear,
honest "not supported for this file type" result — never a crash, never a
silently wrong answer pretending to be a real one.

## What to build

### 1. Shared module: `src/codeintel/program.ts` (or similar)

Load a `ts.Program` for the target workspace, respecting its real
`tsconfig.json` (use `ts.findConfigFile` + `ts.readConfigFile` +
`ts.parseJsonConfigFileContent` — do not hand-roll tsconfig parsing).
Cache the loaded program for a session's lifetime (rebuilding a full TS
program is expensive — do NOT reload it on every tool call; invalidate/
rebuild only when a file the program covers has actually changed, e.g.
after an edit tool writes to a `.ts` file in this workspace — check how
other parts of this project track "did a file change" for a pattern to
follow, or use file mtimes).

### 2. `outline` tool

Given a file path, return every top-level (and reasonably-nested, your
call on depth) function/class/interface/type/const declaration with its
name, kind, and line number — signatures only, no bodies. Use the TS AST
(`ts.forEachChild` over the source file), not regex. Format the result
compactly (this is explicitly meant to be cheap to read, not another wall
of text) — something like `14 function foo(x: string): void` per line, one
line per symbol.

### 3. `go_to_definition` tool

Given a file path + line number (+ optionally a symbol name if disambiguation
is needed on a line with multiple symbols — check whether the TS
`LanguageService`'s `getDefinitionAtPosition` needs a specific character
offset, not just a line, and design the tool's real parameter shape around
what the API actually needs, not around what would be convenient to
guess), resolve to the definition's real file:line using the type
checker's actual symbol resolution — not a text search. Handle: symbol
defined in a `.d.ts`/vendored/`node_modules` location (return that real
location, don't refuse just because it's outside `src/`), symbol with no
resolvable definition (ambient/`any`-typed/genuinely unresolvable — a
clear "could not resolve" result, not a crash), and multiple candidate
definitions (e.g. an overloaded function) — return all of them, don't
silently pick one.

### 4. `find_references` tool

Given a file path + line/position identifying a symbol, return every real
usage site as compact `file:line` entries (plus a short snippet of the
line itself, so the model doesn't have to read each file just to see
context) — use the language service's real reference-finding
(`findReferences`/`getReferencesAtPosition` — verify the actual API name
and return shape live against the installed TS version), not grep. Cap the
result count with a clear "N more references not shown, narrow your
search" message for a symbol with a huge number of usages (e.g.
something generic like a common utility function) — don't let one query
dump hundreds of lines back into the model's context, which would defeat
the entire point of this tool.

### 5. `import_graph` tool

Given a file path, return (a) what it imports (resolved to real file
paths, not just the raw import specifiers) and (b) what imports it
(reverse lookup — requires either scanning the whole program's import
graph once and caching it, or a targeted search; your call on approach,
but don't rescan the whole project on every call if it's avoidable — reuse
the cached `ts.Program` from the shared module). Static analysis of
`ts.ImportDeclaration`/`ts.ExportDeclaration` nodes — deterministic, no
type-checking needed for this one specifically (imports are syntactic, not
type-dependent), so this can be cheaper than the other three.

### 6. Wire into the executor + tool schemas

New vendored-style tool schemas (follow the exact pattern of existing
native tools in `src/vendor/zoo-code/src/core/prompts/tools/native-tools/`
for schema SHAPE/conventions, even though these are new tools with no real
Zoo Code upstream to port from — be explicit in your report that these are
new, not ported, same as `browser_action` was). Register real handlers in
`src/tools/executor.ts`'s `IMPLEMENTED_TOOLS`, following existing
precedent for where or how new tools get added to that set.

## What NOT to do

- Do not write your own TS/JS parser — use the real Compiler API.
- Do not silently return wrong/best-guess answers for non-TS files — clear
  "not supported" result.
- Do not reload/re-parse the whole TS program on every single tool call —
  cache it, invalidate deliberately.
- Do not let `find_references` dump unbounded results — cap and say so.
- Do not build a general-purpose language-server protocol implementation —
  these four specific tools, nothing more.

## Tests

- `src/codeintel/__tests__/` covering each tool against small fixture
  TypeScript files with known structure (a file with several functions/
  classes for outline; a symbol with a known definition site and several
  known usage sites for go-to-definition/find-references; a small import
  chain for the import graph) — assert exact expected results, not just
  "didn't crash."
- A test proving `tsconfig.json` path aliases resolve correctly (use this
  project's own `vscode`/`@roo-code/types` aliases as the real fixture —
  they already exist, exercise them for real).
- A test proving a non-TS file produces the clear "not supported" result,
  not a crash.
- A test proving `find_references` caps its output on a symbol with many
  usages.
- A test proving the program cache is actually reused across multiple
  calls (not rebuilt every time) — e.g. via a call counter on whatever
  program-loading function you write, mirroring how other tests in this
  project prove caching behavior with real call counters rather than just
  reading the code and assuming it's cached.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. Run each of the four tools for real against THIS repo's own source
   (e.g. `outline` on `src/engine/loop.ts`, `go_to_definition` on a call to
   `truncateHistory`, `find_references` on `resolveModelForMode`,
   `import_graph` on `src/tools/executor.ts`) and quote the real output in
   your report — prove these work on a real, non-trivial codebase, not
   just tiny fixtures.

## What to report back

- Files changed/added.
- The real TS Compiler API methods you ended up using for each tool
  (definition resolution, reference finding) — quote the actual API
  surface, since this document deliberately didn't prescribe exact method
  names/signatures given API drift across TS versions.
- Real output from running all four tools against this repo's own source
  (item 4 above).
- Confirmation of tsc/test/e2e results.
- Any deviation from this spec, and why.
- Anything you noticed while doing this that looks like a related bug or
  gap, even if unfixed.
