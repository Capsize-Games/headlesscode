# Workspace extensions

Extensions are immutable workspace bundles stored under
`.agents/headlesscode/extensions/<id>/<sha256>/`. An ID can have multiple
revisions. The digest identifies the manifest and every file in that revision;
calls always name both the ID and digest.

In a session whose selected tools already include workspace writing and
command execution, `extension_manage` can list, validate, create, and inspect
extensions. Listing returns metadata only. Validation checks a bundle and
computes its digest without writing it. Creation uses the normal tool intent
and result path, applies the session's protected-file policy to every write,
and stores a content-addressed revision. Inspecting an MCP extension starts
its entrypoint to read its advertised tool names and schemas.

For example, ask a coding session: "Create a reusable Node tool that counts
the entries in a JSON object, then call it on this input." The agent creates
a manifest and text files with `extension_manage`, reads the returned digest,
and uses that exact digest with `extension_call`. No dependency installation
is part of extension creation.

A minimal Node tool bundle has this shape:

```json
{
  "manifest": {
    "schemaVersion": 1,
    "id": "count-entries",
    "kind": "tool",
    "description": "Counts the entries in a JSON object",
    "entrypoint": "index.mjs",
    "inputSchema": { "type": "object" }
  },
  "files": {
    "index.mjs": "export function run(input) { return { count: Object.keys(input).length } }"
  }
}
```

Use `extension_call` with an ID and exact digest to use an extension. A skill
returns its captured `SKILL.md` and text references as tool data. A Node tool
entrypoint exports `run(input)` or a default function and returns finite JSON.
An MCP entrypoint is a Node program that speaks MCP over stdio; choose one of
its advertised tools with `tool_name`. Extension contents never change the
session's tool schemas or system prompt, and discovering a bundle does not
execute it.

Node and MCP entrypoints are staged from the pinned file snapshot and run as
owned child processes on supported POSIX hosts, with bounded input, output,
protocol data, and time. Executable extensions are unavailable on Windows
because this runtime cannot guarantee descendant process-tree teardown there.
The runtime supplies a minimal environment and enforces the session's command
policy. This is not a separate operating-system sandbox: local sessions run
with the invoking user's host authority. A contained session uses the
OpenShell boundary already established for that session; extension support
does not create another boundary or widen its policy. Do not put credentials
or other secrets in extension files.

Workspace changes are carried to RSI workers only after they are part of the
selected Git snapshot. The mutation snapshot includes tracked workspace
extensions and `src/extensions`, while excluding `src/rsi`, the configured RSI
evaluation paths, test files, and adversarial fixtures. The RSI Dockerfile
removes `src/rsi` and test files from the worker image. These source and
packaging checks do not constitute a built-image or live-worker qualification.
