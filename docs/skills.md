# Skills

HeadlessCode reads skills in the [Agent Skills `SKILL.md`
format](https://agentskills.io/specification). A skill is a directory named
for its `name` field, containing `SKILL.md` with YAML frontmatter fields
`name` and `description`, followed by Markdown instructions. Names use
lowercase letters, numbers, and single hyphens, up to 64 characters.
Descriptions contain 1 to 1024 characters. The optional `compatibility`,
`metadata`, and `allowed-tools` fields are validated as specified; they do not
grant tools or permissions. Additional UTF-8 text files may sit alongside the
manifest for references and scripts. Binary and oversized optional resources
are excluded from the session snapshot and reported as discovery warnings.

Discovery is capped at 512 entries per skill root, 128 skills, and 4 MiB of
captured text per session.

## Discovery and trust

At session start, HeadlessCode snapshots skills from these roots, in order:

1. Roots explicitly enabled with `headlesscode skills enable`.
2. `<HEADLESSCODE_DATA_DIR>/skills` (or
   `~/.local/share/headlesscode/skills` when the variable is unset).
3. `~/.agents/skills`.

Project skills in `<workspace>/.agents/skills` are not enabled automatically.
Enable that directory explicitly with `headlesscode skills enable
.agents/skills`. Additional local roots can be enabled by passing their path.
The enable command records absolute paths in the central store's
`skills-enabled.json`. The `import` command copies validated skills into the
HeadlessCode-managed root without running scripts or hooks.

When names collide, the first root above wins; skill directories are sorted by
name within each root. Invalid manifests, duplicate names, symlinks, and
oversized files are reported as discovery problems. The initial model catalog
contains only each skill's name, description, and source.

## Activation and references

The model loads a relevant skill with the `skill` tool. The result contains
only the captured Markdown instructions, source, and a SHA-256 digest. Files
are captured once per session, so a later edit cannot change the instructions
or references that session receives. Text references are loaded separately
with `read_skill_reference`, after activation, and paths must stay inside the
selected skill directory. A reference is limited to 20,000 characters. Each
file is limited to 64 KiB; a skill snapshot is limited to 512 KiB and 200
files.

Skills provide supplemental instructions only. HeadlessCode does not execute
skill scripts or hooks automatically. A skill cannot add tools, change the
active mode or security profile, widen permissions, or bypass the session's
evidence and execution controls. Any requested actions still go through the
ordinary tool executor.

## Commands

- `headlesscode skills list` shows discovered names, descriptions, and sources.
- `headlesscode skills inspect <name>` prints captured instructions and their
  digest.
- `headlesscode skills validate` reports invalid manifests and duplicate
  names in the discovered roots.
- `headlesscode skills enable <skill-root>` explicitly trusts a local root for
  future sessions.
- `headlesscode skills import <local-skill-directory>` copies one skill or
  each immediate skill subdirectory into the HeadlessCode-managed root. Repeat
  imports with identical content are safe; a same-name import with different
  content fails and leaves the existing skill in place.
