import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "extensions-live-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reverse_text",
      description: "Reverse text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "reverse_text") {
    throw new Error(`unknown tool: ${request.params.name}`);
  }
  const text = request.params.arguments?.text ?? "";
  const reversed = text.split("").reverse().join("");
  return {
    content: [{ type: "text", text: reversed }],
    structuredContent: { marker: "EXTENSION_MCP_CHECK_OK", reversed }
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
