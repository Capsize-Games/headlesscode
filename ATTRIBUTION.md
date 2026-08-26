# ATTRIBUTION

The following material in this repository is derived from
**[Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code)** —
`Zoo-Code-Org/Zoo-Code`, a Roo Code fork — and is used under the
**Apache License, Version 2.0**:

- **Prompt text** — the system prompt builder
  (`src/vendor/zoo-code/src/core/prompts/system.ts`) and every prompt section
  under `src/vendor/zoo-code/src/core/prompts/sections/` (TOOL USE, RULES,
  OBJECTIVE, CAPABILITIES, MODES, SYSTEM INFORMATION, USER'S CUSTOM
  INSTRUCTIONS, etc.), plus the built-in mode role definitions in
  `src/vendor/zoo-code/types/mode.ts`.
- **Tool schemas** — the OpenAI `ChatCompletionTool` JSON schema definitions in
  `src/vendor/zoo-code/src/core/prompts/tools/native-tools/` (21 tools) and the
  OpenAI ↔ Anthropic converters (`converters.ts`).
- **Mode/rules loading logic** — `.roomodes` parsing/merging
  (`src/vendor/zoo-code/src/core/config/CustomModesManager.ts`),
  `.roo/rules-<slug>/`, `.roo/rules/`, and `AGENTS.md` splicing
  (`src/vendor/zoo-code/src/core/prompts/sections/custom-instructions.ts`),
  and the `.roo` directory discovery service
  (`src/vendor/zoo-code/src/services/roo-config/`).
- **Types and constants** — `ModeConfig`/`DEFAULT_MODES` and the tool/group
  type definitions under `src/vendor/zoo-code/types/`.
- **Checkpoints** — the shadow-git auto-commit mechanism
  (`src/vendor/zoo-code/src/services/checkpoints/ShadowCheckpointService.ts`,
  `RepoPerTaskCheckpointService.ts`, `types.ts`, `excludes.ts`, `index.ts`),
  which snapshots the workspace into a hidden git repo (via `simple-git`)
  after every tool-executing turn so edits can be reverted; see
  `docs/checkpoints.md`.
- **Diff-based editing** — the multi-search-replace fuzzy diff engine
  (`src/vendor/zoo-code/src/core/diff/strategies/multi-search-replace.ts`,
  a verbatim copy of `zoo-code/src/core/diff/strategies/multi-search-replace.ts`),
  plus its pure helpers `zoo-code/src/utils/text-normalization.ts` and the
  line-number helpers extracted from
  `zoo-code/src/integrations/misc/extract-text.ts`, and the
  `DEFAULT_DIFF_FUZZY_THRESHOLD` constant from
  `zoo-code/packages/types/src/global-settings.ts`. These back the headless
  harness's `apply_diff` tool (the tool schemas for `apply_diff` /
  `search_replace` / `edit_file` were already vendored under
  `src/vendor/zoo-code/src/core/prompts/tools/native-tools/`).

Source: **https://github.com/Zoo-Code-Org/Zoo-Code**
License: **Apache-2.0** · Copyright **2026 Zoo Code**.
Inspection commit: `ca9b60fbc7b72a27352b0e2084271c28f2419f94`.

A verbatim copy of the Apache License 2.0 is provided in
[`LICENSE`](./LICENSE). The full inventory of vendored files, local shims, and
excluded files is in
[`src/vendor/zoo-code/VENDOR-NOTES.md`](./src/vendor/zoo-code/VENDOR-NOTES.md).

This notice is provided in addition to — and does not modify — the terms of the
Apache License 2.0.
