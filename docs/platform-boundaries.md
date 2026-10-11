# Package and platform boundaries

This audit resolves [#2](https://github.com/Capsize-Games/headlesscode/issues/2).
It was measured on 2026-10-11 against `95fbc38991fae638cff58926b5101d9620807d9d`
(v1.6.4). HeadlessCode retains its independent package, npm lockfile, release
cadence, and product interfaces. No dependency migration is proposed.

## Measured package inventory

| Boundary | Current implementation | Decision |
|---|---|---|
| Runtime and package manager | One root ESM package; Node >=22.19; npm; lockfile version 3; no workspace declaration | Retain the committed npm workflow |
| TypeScript execution | Locked TypeScript 5.9.3 and tsx 4.23.1; source runs directly through tsx | Retain; no frontend build tuple to converge |
| Dashboard | `src/dashboard/server.ts` uses Node HTTP and `src/dashboard/page.ts` renders the page | Retain the current runtime and product routes |
| React / React DOM / Vite | None in the root manifest or resolved lockfile | React 18/19 and Vite compatibility are not applicable to this package |
| Vendored prompt/tool code | Portable Zoo Code source under `src/vendor/`; its smoke check runs in `npm test` | Preserve its imports and upstream notices |
| Benchmark fixtures | Nested fixture manifests under `src/rsi/benchmark-fixtures/` | Test inputs, not independently released frontend clients or a workspace family |
| Distribution | Root CLI entry points and source tarball; repository CI and tag publishing | Keep the harness and its dashboard on the same release |

The runtime lock also resolves Undici 8.11.2, MCP SDK 1.32.1, and Zod 3.25.76.
Manifest ranges and installed versions are distinct; these are resolved versions
from the audited lockfile, not suggested upgrades.

The inventory is reproducible without traversing generated or vendored dependency
trees:

```sh
git ls-files '*package.json' '*lock*' '*vite*' '*workspace*'
node -e 'const p=require("./package.json"),l=require("./package-lock.json"); console.log(p.engines,p.workspaces,l.lockfileVersion); for(const n of ["typescript","tsx","undici","@modelcontextprotocol/sdk","zod","react","react-dom","vite"]) console.log(n,l.packages["node_modules/"+n]?.version??null)'
```

## Shared-package adoption matrix

The available published package names are `@capsizellc/commons` and
`@capsizellc/ui`. Registry metadata, downloaded package manifests, and exported
entry points were inspected separately from local source.

| Candidate | Verified package contract | HeadlessCode decision and reason |
|---|---|---|
| Commons environment helpers | Published 0.1.1 exports `env`; declares Node >=22 and MIT | Retain local configuration parsers. Provider credentials, finite resource caps, and supervisor paths require their existing validation and error contracts |
| Commons result union | Published 0.1.1 exports `result` | Retain `ToolResult`, `SessionResult`, and fleet outcomes. Their tool content, terminal status, budget accounting, and retry semantics are product contracts |
| Commons logging | Published 0.1.1 exports `logging` | Retain `src/engine/logger.ts`: silent level, stdout/stderr routing, append-to-file behavior, and current line format are consumed by workers and diagnostics |
| Commons HTTP helper | Published 0.1.1 exports `http` | Retain provider adapters. Streaming, caller cancellation, cache routing, provider identity, retries, and generation billing reconciliation require adapter-specific behavior |
| Commons object/string utilities | Published 0.1.1 exports `object` and `string` | Retain current code; this audit found no demonstrated reduction that warrants a new runtime dependency |
| UI components and token CSS | Published UI 0.1.2 exports the React entry point, `tokens.css`, and `tailwind-preset`; React and React DOM peers are ^19.0.0 | Retain the dashboard implementation in this change. Introducing React for this audit would change the runtime/build boundary; any future dashboard work must follow the shared UI and owner licensing rules |

Local Commons source declares 0.1.5, but `npm view
@capsizellc/commons@0.1.5` returned E404. The public registry's latest version was
0.1.1. A local source version is not a consumable release pin. The 0.1.1 tarball
declares MIT but contains no separate license file; any future redistribution
must preserve the applicable notice. The UI 0.1.2 tarball includes the Capsize
proprietary license. Its publication does not grant permission to redistribute
it as part of this Apache-2.0 project. This audit changes no licenses.

The independent npm boundary follows the fleet policy's separation of version
authority from shared release cadence. Related coordination issues are
[hq#30](https://github.com/Capsize-Games/hq/issues/30),
[hq#31](https://github.com/Capsize-Games/hq/issues/31),
[hq#33](https://github.com/Capsize-Games/hq/issues/33), and
[hq#37](https://github.com/Capsize-Games/hq/issues/37). A common TypeScript or Node
version alone is not a reason to move the coding harness into a frontend
workspace.

## Validation and future adoption gate

Registry tarball integrity matched the downloaded bytes:

| Artifact | SHA-512 integrity |
|---|---|
| Commons 0.1.1 | `sha512-EG3VWaqRKL9lSWQPVp2f2/XN22BTAGFlooYq/75rQepeAR7QVHmCvvGEcDRYZWsmlXHJWUHeHu4P5yBgK19wGg==` |
| UI 0.1.2 | `sha512-rRSvG734afi1geGsLvSzjce/P+z2vJ+RbC9V4ir04IeI/7OnEcdqpS2dkZBL9t72nIjVyvnhlBihOtAZ2VJTMg==` |

A clean scratch npm consumer installed Commons 0.1.1 with lifecycle scripts
disabled. All seven JavaScript entry points (root, env, result, logging, http,
string, object) imported successfully through ESM and CommonJS with matching
export names. This checks the published import surface, not behavioral parity
with HeadlessCode. UI React execution was not tested; no UI adoption is proposed.

Before adopting a shared helper, use an exact published version and verify its
artifact, license, and runtime exports. Add a parity check for the actual
HeadlessCode contract, then run a clean `npm ci`, typecheck, full test suite, and
relevant worker/dashboard checks. Review the lockfile and rollback pin in that
specific PR. Provider, MCP, session, worker, telemetry, and vendored prompt
contracts remain local unless that change supplies compatibility evidence.
