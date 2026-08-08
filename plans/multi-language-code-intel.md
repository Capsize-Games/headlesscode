# Multi-language code intelligence (generic LSP backend) — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop.

Match this project's established style: no test framework (plain `tsx`-run
test files, hand-rolled `assert`, `All N tests passed` trailer); `npx tsc
--noEmit` and `npm test` must stay green; re-run every e2e suite under
`scripts/e2e*/run.sh`.

**This is a real, substantial build — not a small task. Read the whole
document before writing code.** Consider splitting your own work into
sequential commits: (1) the backend interface + TypeScript backend
refactor (mechanical, low-risk, proves the seam works before anything else
depends on it), (2) the generic LSP client + process lifecycle, (3) Python
support wired through it, (4) executor/prompt integration replacing the
TS-only gate.

## The problem, observed live

`src/codeintel/` (`outline`, `go_to_definition`, `find_references`,
`import_graph`, `rename_symbol`) is fully built and works well — but it is
**hard-wired to TypeScript**. Every analyzer function
(`src/codeintel/outline.ts`, `find-references.ts`, `go-to-definition.ts`,
`import-graph.ts`, `rename-symbol.ts`) takes a concrete `CodeIntel` struct
(`src/codeintel/program.ts`) whose fields are `ts.Program` /
`ts.LanguageService` directly — there is no abstraction seam, `ts.*` is
threaded straight through every call. Registration is gated the same way:
`src/tools/executor.ts`'s `registerTypeScriptGatedTools` only registers
these six tools (`outline`, `go_to_definition`, `find_references`,
`import_graph`, `rename_symbol`, `run_tests`) when
`isTypeScriptWorkspace(workspaceRoot)` (`src/tools/language-detect.ts`) is
true. **A Python-only or Rust-only or Go-only workspace gets NONE of them —
not hidden from the prompt, actually absent from the executor.**

This was confirmed live on `airunner` (a real, mixed Python-server /
TypeScript-client repo): a worker doing Python server-side work had zero
code-intel tools usable for the files it actually needed (all under
`server/src/airunner_services/`, `.py`), and fell back to `grep`-via-
`execute_command` for every symbol lookup — exactly the "trial and error"
pattern this harness has been fighting elsewhere. The fix is not "add a
second hard-wired Python backend" — it's "build the seam this codebase
never had, so ANY language with a real language server can plug in."

## Architecture: `CodeIntelBackend` + a generic LSP client

### 1. Define the language-neutral interface

New file `src/codeintel/backend.ts` (or similar) — extract the CURRENT
return shapes from `outline.ts`/`find-references.ts`/`go-to-definition.ts`/
`import-graph.ts`/`rename-symbol.ts` (read them first; `find-references.ts`'s
`ReferenceSite` — `{ fileName, line, character, start, isWriteAccess,
snippet }` — is a good model for the shape the interface should standardize
on) into a `CodeIntelBackend` interface:

```ts
interface CodeIntelBackend {
  readonly language: string
  outline(file: string): Promise<OutlineEntry[]>
  goToDefinition(file: string, position: SymbolPosition): Promise<DefinitionSite[]>
  findReferences(file: string, position: SymbolPosition): Promise<ReferenceSite[]>
  importGraph(): Promise<ImportEdge[]>
  renameSymbol(file: string, position: SymbolPosition, newName: string): Promise<RenameResult>
  dispose(): Promise<void>
}
```

(Exact field names are yours to finalize against what the existing handlers
in `src/codeintel/handlers.ts` already produce — the goal is that
`handlers.ts` stops calling `intel.languageService.*` directly and instead
calls `backend.findReferences(...)` etc., with ZERO behavior change for the
TypeScript case.)

### 2. Wrap the existing TypeScript implementation, unchanged underneath

`TypeScriptCodeIntelBackend` implements `CodeIntelBackend` by calling the
EXISTING `program.ts`/`outline.ts`/etc. functions internally — this should be
almost entirely mechanical (move the `ts.*`-touching code as-is behind the
new interface, don't rewrite the actual analysis). This is the safest first
commit: if `npm test` stays green after this step alone with no other
change, the seam is proven correct before anything else builds on it.

### 3. Build a generic LSP-client backend

New file(s) under `src/codeintel/lsp/`. This is the actual "any codebase"
part. Add `vscode-jsonrpc` and `vscode-languageserver-protocol` (or
equivalent minimal LSP client libraries — check current npm versions,
they're maintained by Microsoft and widely used) as real dependencies.

`LspCodeIntelBackend` spawns a language server as a child process, speaks
LSP over stdio (JSON-RPC 2.0, `Content-Length` framed — this is exactly what
those two packages exist to handle, don't hand-rolled it), does the
`initialize`/`initialized` handshake, opens the target file with
`textDocument/didOpen`, and implements the interface via the standard
requests:

- `outline` → `textDocument/documentSymbol`
- `goToDefinition` → `textDocument/definition`
- `findReferences` → `textDocument/references`
- `renameSymbol` → `textDocument/rename` (well-supported by most real
  servers — this one is close to a direct mapping)
- `importGraph` → **no standard LSP request for this.** Either (a) skip it
  for LSP-backed languages initially and have `import_graph` simply not
  register for a workspace whose ONLY backend is LSP-based (document this
  gap explicitly, don't silently return empty/wrong results), or (b)
  implement a lightweight per-language import-statement scan (regex or a
  minimal parser) as a separate, backend-agnostic helper — your call, but
  whichever you pick, a model calling `import_graph` on a Python-only repo
  must get either a real answer or a clear "not supported for this
  language yet" error, never a silent wrong one.

Process lifecycle: one persistent server process per `(workspaceRoot,
language)` pair, cached the same way `program.ts`'s `CodeIntelCache` already
caches per workspace root — reuse the pattern, don't invent a second caching
scheme. Handle: startup failure (binary not found/crashes on init) →
`dispose()` cleanly and treat as "no backend for this language" (fail
closed, matching the TS side's existing all-or-nothing registration
philosophy, just scoped per-language instead of per-workspace); the
process dying mid-session → restart once, then fail closed for the rest of
the session rather than retry forever; explicit teardown at session end (the
harness already tears down other per-session resources — checkpoints,
executors — follow that lifecycle hook, don't leak child processes).

### 4. Language → server registry, with Python working out of the box

A small table, e.g.:

```ts
const LANGUAGE_SERVERS: Record<string, { command: string[]; rootMarkers: string[] }> = {
  python: { command: ["pyright-langserver", "--stdio"], rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"] },
  // rust: { command: ["rust-analyzer"], rootMarkers: ["Cargo.toml"] },
  // go:   { command: ["gopls"], rootMarkers: ["go.mod"] },
}
```

**Bundle `pyright` as a real dependency** (it ships an npm package with a
`pyright-langserver` binary) so Python support works for every user with zero
extra install — this directly closes the exact gap that motivated this
plan. Leave the registry easy to extend (a comment showing the pattern for
one more language, e.g. Rust or Go, is enough — don't build out servers you
can't test).

### 5. Generalize language detection and executor registration

`src/tools/language-detect.ts`'s `detectWorkspaceLanguages` already returns a
`Set<string>` (confirmed: it's not a TS-only boolean internally, just
consumed via `isTypeScriptWorkspace` which checks `.has("typescript")`) —
extend its detection to also recognize Python (`*.py`, `pyproject.toml`,
`setup.py`, `requirements.txt`) and whatever else you wire a registry entry
for.

Replace `registerTypeScriptGatedTools` in `src/tools/executor.ts` with
something that, for a workspace with MULTIPLE detected languages (airunner:
both `typescript` AND `python`), registers backends for EACH detected
language that has one available, and dispatches each tool call to the right
backend **based on the TARGET FILE's extension**, not the workspace's
"primary" language — a single session working on a mixed repo must be able
to call `find_references` on a `.py` file and get the Python backend, then
call it again on a `.ts` file in the same session and get the TypeScript
backend. `handlers.ts`'s existing `resolveTarget` (path-safety +
`isSupportedSource` check) is the natural place to add "which backend owns
this extension" resolution.

`src/engine/prompt.ts`'s `appendCodeIntelTools`/`appendCodeIntelEditTools`
gating in `src/engine/loop.ts` (`this.executor.has("outline")` /
`this.executor.has("rename_symbol")`) needs no change if registration now
correctly reflects "at least one backend is available" — verify this stays
true rather than assuming it.

`run_tests` is currently gated alongside the TypeScript tools
(`registerTypeScriptGatedTools`) but has nothing to do with language
detection — check whether that coupling was intentional or incidental; if
incidental, decouple it (a Python-only workspace should still get
`run_tests` if it's otherwise applicable) as a small, separately-justified
change, not folded silently into the language-detection refactor.

### One thing NOT in scope

`call_graph` (`src/codeintel/call-graph.ts`) exists but is not a model-facing
tool today — only `src/codemap/extract.ts` calls it internally. Leave it
alone; this plan is about the SIX registered tools, not adding a seventh.

## Required verification (static/read-only per this repo's Testing Boundary)

- A real Python fixture workspace (tiny — a few `.py` files with a function
  defined once and called from two other files): `find_references` and
  `go_to_definition` via the pyright-backed path return correct, real
  results — not a mock. This is the load-bearing test; don't fake the LSP
  round-trip for it.
- The existing TypeScript fixture tests (`src/codeintel/__tests__/`) still
  pass unchanged after the `TypeScriptCodeIntelBackend` wrap — zero behavior
  change for the language that already worked.
- A MIXED workspace (both a `.ts` file and a `.py` file, both with real
  symbols): one session calls `find_references` on each and gets the RIGHT
  backend's answer for each — proves per-file dispatch, not per-workspace.
- A language with no configured backend (anything not `typescript`/`python`)
  and no LSP server on PATH: the six tools simply aren't registered for
  that workspace, exactly like today's TS-only behavior, no crash, no
  confusing partial registration.
- A server that fails to start (rename the `pyright-langserver` binary
  path to something that doesn't exist, or similar): session starts and
  completes normally without those tools, WARN logged, never a hard failure.

## Closing out

Once implemented and verified: `npx tsc --noEmit`, `npm test` (all files
green), re-run `scripts/e2e*/run.sh`. Open a PR against `master` with a real
before/after (the airunner Python-file `find_references` call failing with
"tool not available" before your change, succeeding with real results
after) and reference this plan file in the PR description.
