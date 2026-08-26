#!/usr/bin/env bash
#
# setup.sh — create a throwaway fixture repo for the headlesscode Phase 1
# end-to-end test.
#
# Creates a brand-new git repo in a temp dir (mktemp -d
# /tmp/headlesscode-e2e-fixture-XXXXXX) containing a small project that stands
# in for "issue #29"-style work:
#
#   - README.md, package.json
#   - src/greet.js     (buggy: greet() returns "" instead of "Hello, " + name)
#   - src/greet.test.js (plain node assert test; fails while the bug is unfixed)
#   - .roomodes          (one custom mode, so custom-mode loading is exercised)
#   - .roo/rules-code/   (mode-specific rules, spliced for --mode code)
#   - .roo/rules/        (generic rules, always spliced)
#   - AGENTS.md          (agent rules, spliced when useAgentRules is on)
#
# The mock OpenRouter server (scripts/e2e/mock-openrouter.mjs) derives the fix
# from this repo's src/greet.js, so the e2e runner can assert the fix landed
# byte-for-byte in the worktree.
#
# Usage: scripts/e2e-fixture/setup.sh
#
# Prints the fixture repo path on stdout (the only stdout output); all other
# logging goes to stderr.

set -euo pipefail

log() { printf '%s\n' "$*" >&2; }

FIXTURE="$(mktemp -d /tmp/headlesscode-e2e-fixture-XXXXXX)"
log "fixture repo: $FIXTURE"

# `git init -b main` needs git >= 2.28; fall back to the default branch name
# on older gits (the branch name does not matter for the test).
if ! git init -q -b main "$FIXTURE" 2>/dev/null; then
	git init -q "$FIXTURE"
fi

cd "$FIXTURE"

# ── Project files ────────────────────────────────────────────────────────────

cat > README.md <<'EOF'
# greet-fixture

Throwaway fixture repo for the headlesscode Phase 1 end-to-end test.

Simulates issue #29: `greet()` in `src/greet.js` returns an empty string
instead of greeting the given name.

- Source: `src/greet.js`
- Test:   `node src/greet.test.js` (also wired up as `npm test`)
EOF

cat > package.json <<'EOF'
{
	"name": "greet-fixture",
	"version": "0.1.0",
	"private": true,
	"description": "Throwaway fixture repo for the headlesscode e2e test (issue #29)",
	"scripts": {
		"test": "node src/greet.test.js"
	}
}
EOF

mkdir -p src

cat > src/greet.js <<'EOF'
/**
 * greet.js — fixture project for the headlesscode end-to-end test.
 *
 * Issue #29: greet() always returns an empty string instead of greeting
 * the given name.
 */
function greet(name) {
	return "" // BUG (issue #29): should be "Hello, " + name
}

module.exports = { greet }
EOF

cat > src/greet.test.js <<'EOF'
/**
 * greet.test.js — plain node assert test (run via `node src/greet.test.js`).
 * Fails while issue #29 is unfixed; passes after greet() is corrected.
 */
const assert = require("node:assert")
const { greet } = require("./greet.js")

assert.strictEqual(greet("World"), "Hello, World")
assert.strictEqual(greet("Alice"), "Hello, Alice")
assert.strictEqual(greet(""), "Hello, ")

console.log("greet tests passed")
EOF

# ── Mode + rules files (exercised end-to-end by the vendored prompt builder) ─

mkdir -p .roo/rules-code .roo/rules

cat > .roomodes <<'EOF'
customModes:
  - slug: issue-fixer
    name: 🔧 Issue Fixer (fixture)
    roleDefinition: |-
      You are a headless issue-fixing specialist. You analyze the task, read the
      relevant source, implement the fix with write_to_file, verify it with
      execute_command, and report via attempt_completion.
    whenToUse: Use when a fixture issue must be resolved end-to-end.
    description: Resolve fixture issue #29.
    groups:
      - read
      - edit
      - command
    source: project
EOF

cat > .roo/rules-code/rules.md <<'EOF'
# Rules for code mode (fixture)

- MODE RULE (code): when fixing a bug, read the target file first, then patch
  it with write_to_file, then verify it with execute_command.
- MODE RULE (code): never modify files outside the workspace.
- MODE RULE (code): for orientation ("where is X" / "how does Y work"), try
  codebase_search before whole-file reads; codebase_search complements
  read_file — use search to locate, then read_file to inspect.
EOF

cat > .roo/rules/rules.md <<'EOF'
# Generic rules (fixture)

- GENERIC RULE: always run `node src/greet.test.js` to verify the fix before
  calling attempt_completion.
- GENERIC RULE: keep changes minimal and focused on the issue.
EOF

cat > AGENTS.md <<'EOF'
# Agent rules (fixture)

- AGENT RULE: this repo is a throwaway fixture for the headlesscode end-to-end
  test; treat every task as issue #29.
- AGENT RULE: verify every fix by running the project's test script.
EOF

# ── Commit ───────────────────────────────────────────────────────────────────

git add -A
# commit.gpgsign=false: this is a throwaway repo; never depend on (or prompt
# for) the invoking user's GPG signing setup.
git -c user.name="Headlesscode E2E" -c user.email="e2e@headlesscode.invalid" \
	-c commit.gpgsign=false \
	commit -q -m "fixture: greet-fixture with issue #29 (initial)"
log "committed: $(git rev-parse --short HEAD) on $(git branch --show-current)"

# The fixture repo path is the only thing printed to stdout.
printf '%s\n' "$FIXTURE"
