#!/bin/bash
# Quality gate for workers and the RSI loop: full unit suite, both ratchet
# checkers, and the coverage floor. Fails fast on the first red gate.
# Override the floor with RSI_COVERAGE_FLOOR (default 24 = measured 24.59%
# line coverage on the commit that introduced this gate, minus headroom).
set -u
cd "$(dirname "$0")/.." || exit 1
FLOOR="${RSI_COVERAGE_FLOOR:-24}"
npm test || exit $?
npm run check-standards || exit $?
npm run check-architecture || exit $?
npm run coverage -- --min "$FLOOR"
