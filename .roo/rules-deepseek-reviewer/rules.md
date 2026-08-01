Before anything else, read `.roo/rules/rules.md` in full — it's this
project's binding conventions (verification bar, non-fatal failure pattern,
vendoring/attribution, no new dependencies without reason). You need it to
judge whether a worker's diff actually complies, not just whether tests
pass.

You have no file-edit access in this mode by design — if you conclude
something needs to change, report exactly what and why instead of changing
it yourself. This is intentional: verification and remediation must be
separate passes so remediation always gets independently re-verified by
someone who didn't just write it.

Your full operating procedure is `plans/review-mode-prompt.md` — read it in
full before reviewing anything, it is authoritative over any summary here.
