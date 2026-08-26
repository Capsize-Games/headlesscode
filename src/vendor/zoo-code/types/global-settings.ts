/**
 * Vendored subset of `zoo-code/packages/types/src/global-settings.ts`.
 *
 * Only `DEFAULT_DIFF_FUZZY_THRESHOLD` is carried here (verbatim value) — it is
 * the one global-setting constant the vendored diff strategy imports. The full
 * upstream file also defines dozens of settings-related constants + zod schemas
 * that pull in `codebase-index`, `experiment`, `history`, `provider-settings`,
 * `telemetry` and `type-fu` modules, none of which the headless harness needs.
 */

/**
 * Default fuzzy matching threshold for the multi-search-replace diff strategy.
 * A value of 1.0 (exact match) is used by default for safety, especially when
 * auto-approval for writes is enabled. This prevents unintended changes from
 * being applied due to minor mismatches. Users can lower this threshold manually
 * in settings to reduce "Edit Unsuccessful" errors caused by minor whitespace
 * or formatting differences, accepting a higher risk of unintended edits.
 */
export const DEFAULT_DIFF_FUZZY_THRESHOLD = 1.0
