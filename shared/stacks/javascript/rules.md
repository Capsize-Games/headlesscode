# JavaScript / Node.js conventions

Applies to any project with a `package.json`. A TypeScript project also
matches this stack, so keep to package-level advice that stays valid when
the `typescript` rules fire too.

## Package manager

- Identify the project's real package manager from its lockfile BEFORE
  running install/add commands: `package-lock.json` → npm, `yarn.lock` →
  yarn, `pnpm-lock.yaml` → pnpm. Using the wrong one creates a second
  lockfile and silent dependency drift — never `npm install` in a
  yarn/pnpm project (or vice versa) just because npm happens to be
  available.
- Use the matching add command (`npm add` / `yarn add` / `pnpm add`) for
  new dependencies; don't hand-edit `package.json` and then run a bare
  install.
- In a monorepo, check `workspaces` (npm/yarn) / `pnpm-workspace.yaml`
  before assuming where to run install or which `package.json` a script
  belongs to.

## Scripts

- Run the project's own `scripts` from `package.json` (`npm run <x>` /
  `yarn <x>` / `pnpm <x>`) instead of inventing equivalent commands — the
  project's test/lint/build scripts encode its real toolchain and config.
- Use the project's lint script (e.g. `scripts.lint`) rather than assuming
  a specific linter or config; a project may pin a linter with specific
  rules/exclusions a generic invocation gets wrong.
- For one-off tools, prefer the local toolchain via `npx` (or the
  detected manager's equivalent) over installing anything globally.

## Node runtime

- Check `package.json`'s `engines.node` and any `.nvmrc` before assuming a
  Node version for anything version-sensitive; if the project pins a
  version, use that version rather than the system default.
