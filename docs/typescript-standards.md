# TypeScript code standards (headlesscode)

No fleet-wide TS size/complexity standard exists — HQ `standards/CAPSIZE_PROJECT_STANDARDS.md`
§4/§8 only fixes the toolchain (Prettier + ESLint via `typescript-eslint`,
`tsc --noEmit`), and `capsize-commons/typescript/eslint.config.js` only adds
`no-explicit-any` and `consistent-type-imports`. This file defines the
headlesscode instantiation. The measurable rules are enforced by
`npm run check-standards` (`scripts/check-code-standards.mjs`); run it before
every commit. CI runs it against the committed baseline: no new violations.

## Formatting (Prettier direction)

Tabs for indentation, double quotes, no semicolons, 80-column width,
trailing commas in multiline literals. A `.prettierrc`/`eslint.config.js`
adoption is still open; until then match the surrounding code exactly.

## Size limits (enforced)

| Unit | Limit | Rule id |
|---|---|---|
| Line length | 80 characters | `line-length` |
| File | 250 lines | `file-lines` |
| Class | 200 lines (declaration span) | `class-lines` |
| Function / method | 20 lines (body span) | `function-lines` |

When a limit is reached, split the logic — extract a helper, move a class
into its own file. Counts are source lines including blanks and comments.

## Structure and types (enforced)

- One class per file (`one-class`), except the vendored tree.
- Full type annotations on every function and method signature, parameters
  and return type both (`explicit-return-type` checks the return side;
  `strict` + review cover the rest).
- No `any`: no `any` annotations, no `as any`, no `any[]` (`no-any`).
- No suppression comments: no `eslint-disable`, `@ts-ignore`,
  `@ts-expect-error`, `# noqa`, `# type: ignore` (`no-suppress`).
  Narrow or guard instead.

## Scope

Checked: all `src/**/*.ts` except `src/vendor/**` (vendored upstream, kept
verbatim). Tests follow the same rules — a 400-line test file is still a
400-line file; split the fixture or the suite.

## Baseline ratchet

`scripts/code-standards-baseline.json` records violations that predate
enforcement. The check passes only when the current violation set is a subset
of the baseline (nothing new). Keys are content-anchored (file path + rule +
hash of the offending line or declaration), not line-numbered, so inserting
lines above a violation never trips the gate — but editing a flagged line
does count as new: fix it instead. When you fix a file, regenerate the
baseline (`npm run check-standards -- --write-baseline`) in the same change
so the ratchet tightens. Never add entries to the baseline by hand.

Arrow functions in expression position (inline callbacks) are exempt from
`explicit-return-type`, matching `explicit-function-return-type` with
`allowExpressions`: inference is the idiom there.

## Architecture (enforced via `npm run check-architecture`)

Fewest lines for the most complexity — no repetition, no knots:

| Finding | Rule id | Limit / meaning |
|---|---|---|
| Import cycles | `cycle` | none tolerated; the full cycle path is reported |
| Duplicated blocks | `clone` | 10+ identical normalized lines (imports/exports/comments excluded) |
| Cyclomatic complexity | `complexity` | > 10 per function |
| Nesting depth | `nesting` | > 4 control levels per function |
| Parameter count | `params` | > 5 parameters (bundle into an options object) |
| `console.*` in library code | `console` | tests and `cli.ts` entry points exempt |
| `process.exit` in library code | `process-exit` | tests and `cli.ts` entry points exempt; libraries throw |

Same content-anchored baseline ratchet
(`scripts/architecture-baseline.json`): no new findings; regenerate in the
same change when you fix a file.

## Tests-first refactoring

No refactor without covering tests first: the test for a class or function
must exist and pass before that unit is reshaped, and
`npm run coverage -- --min <floor>` must not regress. See the worker brief
in the quality-campaign issues.
