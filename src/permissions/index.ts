/**
 * Permissions module — command allow/deny + protected-file enforcement config
 * and matching for the headless harness.
 *
 * - `config.ts`         — resolution precedence (CLI flags > env > .headlesscode/permissions.json > defaults)
 * - `commands.ts`       — parseCommand + containsDangerousSubstitution + allow/deny decisions (ported from Zoo Code)
 * - `protected-files.ts`— default protected patterns + glob matching
 */

export * from "./config.js"
export * from "./commands.js"
export * from "./protected-files.js"
