# MCP servers

HeadlessCode can connect to MCP servers configured by the user and make their
tools available to modes that include the `mcp` tool group. The client supports
stdio and Streamable HTTP transports. It reads the user-owned
`~/.config/capsize-agent/mcp.json` manifest, or the path in
`HEADLESSCODE_MCP_CONFIG`.

Sessions created with an explicit `tools` list treat it as a strict allowlist;
they do not connect MCP servers or add MCP tools. This keeps restricted QA and
review sessions from gaining capabilities outside their configured tool set.

```json
{
  "mcpServers": {
    "example": {
      "command": "/absolute/path/to/server",
      "args": ["--stdio"],
      "env": {"TOKEN": "${EXAMPLE_TOKEN}"}
    }
  }
}
```

An HTTP server can instead use `{ "type": "http", "url": "http://127.0.0.1:.../mcp" }` and optional headers. `${NAME}` placeholders are expanded from the HeadlessCode process environment; unset names become empty strings. Keep local services bound to loopback/stdio and do not put credentials directly in a checked-in workspace file.

HeadlessCode intentionally does not load project `.mcp.json` files because they
can ask the agent to execute arbitrary local commands. Configuration is limited
to 12 servers and 100 tools per server. A server startup failure does not block
other servers; failures are included in the system prompt and logger. Tool
errors are returned as tool errors. Server clients are closed when the session
ends, including setup-error paths.

This is tool-call support only. MCP resources, prompts, OAuth setup, per-tool
approval, and interactive controls for enabling servers are not implemented.
Configured server tools may read or change data according to that server's
capabilities. HeadlessCode's own default command execution also runs with the
user's privileges; see [Security](../SECURITY.md).
