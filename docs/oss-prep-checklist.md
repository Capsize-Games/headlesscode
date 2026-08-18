# OSS-prep checklist — pre-public-push actions

Internal maintenance doc (excluded from the npm package and the Docker build
context, like the rest of `docs/`). Tracks the oss-prep audit findings
(`HYG-*`) that are either done, or deliberately deferred until the repo is
about to go public.

## Done

- **HYG-1/2/3** (#98, #99, #100): `package.json` publish blockers fixed, npm
  bin works from a clean install, `npm pack` allowlist (`files`) cuts the
  published tarball to the runtime `src/` + a handful of root docs — verified
  zero `plans/`, `recon/`, `scripts/`, `docs/`, `.roo/` in the packed file
  list. This PR (#103/#104) also removed a **stale duplicate `files` key** in
  `package.json` that still listed `src`, `scripts`, `docs`, `plans` — JSON
  parsers take the last occurrence so it was already dead, but it was a
  landmine for anyone "cleaning up" the file by keeping the first block
  instead of the second.
- **HYG-4** (#101): added the owner's copyright line in `LICENSE` alongside
  Zoo Code's (Apache §4(c) permits adding your own without replacing
  upstream's).
- **HYG-5** (#102): `SECURITY.md` + `CONTRIBUTING.md` added.
- **HYG-7** (#104): `recon/` deleted outright — zero code references it
  (`grep -r "recon/" src/ scripts/` is empty), it was pure one-off local-LLM
  eval scratch output (`.meta.json`/`.summary.txt` logs) with the owner's
  absolute `/home/joe` paths baked into `phase0-report.md`, and it was
  already excluded from both the npm tarball and the Docker build context.
  Nothing of value was lost; it's still in git history if ever needed.

## Deferred — do this immediately before flipping the repo to public

- **HYG-6** (#103): `plans/` is **not** deleted by this PR. Unlike `recon/`,
  it is the live working directory this very multi-agent workflow writes to
  every round (`plans/parallel-tasks/*.md` work orders, `plans/issues/`
  filing ledger) — deleting it from `master` right now would break every
  concurrently-running worktree/agent that reads or writes it. The original
  remediation ("move the whole tree to an archive branch before first public
  push") is explicitly time-gated to that event, not to general oss-prep
  cleanup, so it is intentionally left for whoever throws the
  public-visibility switch. At that point:
  1. `git branch archive/plans-pre-oss <current master sha>` (or push a tag)
     so the internal history is preserved somewhere non-public.
  2. `git rm -r plans/` on the branch that becomes the public default, in a
     dedicated commit.
  3. Confirm `plans/issues/.filed.json` and `plans/issues/INDEX.md`
     specifically are gone — they're the private filing ledger that reveals
     the real remote org/issue numbering — before the branch is ever pushed
     anywhere public. (`package.json`'s `files` allowlist already keeps them
     out of the npm tarball and `.dockerignore` already keeps them out of the
     Docker build context, so this step is only about the git tree itself
     becoming visible on a public GitHub remote.)
  4. Optionally keep only the self-contained `plans/issues/*.md` specs if
     there's a reason to publish the audit methodology — everything else
     (`.worktrees` paths, worktree state dumps, other private project refs)
     should not survive the move.
