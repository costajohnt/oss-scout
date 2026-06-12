/**
 * Library entry point for @oss-scout/mcp.
 *
 * Importing this module has NO side effects: it does not start a server,
 * read a token, or call process.exit (#148). The executable lives in
 * `bin.ts`, which the published `oss-scout-mcp` binary bundles.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createScout, getGitHubToken } from "@oss-scout/core";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";

export { registerTools } from "./tools.js";
export { registerResources } from "./resources.js";

/** Server identity, kept in one place for the bin and any embedding host. */
export const SERVER_INFO = {
  name: "oss-scout-mcp",
  version: "0.10.0", // x-release-please-version
} as const;

/**
 * Build a fully-wired MCP server (tools + resources) around a scout.
 * Side-effect-free: the caller owns transport and lifecycle.
 */
export function createServer(
  scout: Parameters<typeof registerTools>[1],
): McpServer {
  const server = new McpServer(
    { name: SERVER_INFO.name, version: SERVER_INFO.version },
    { capabilities: { resources: {}, tools: {} } },
  );
  registerTools(server, scout);
  registerResources(server, scout);
  return server;
}

/**
 * Boot the stdio MCP server: resolve a token, build the scout, and connect.
 * Throws on a missing token (the bin maps that to a stderr message + exit).
 */
export async function runServer(): Promise<void> {
  const token = getGitHubToken();
  if (!token) {
    throw new Error(
      "GitHub token required. Set GITHUB_TOKEN or run `gh auth login`.",
    );
  }
  // Local persistence: read and write ~/.oss-scout/state.json so the server
  // sees the user's preferences and history and survives restarts (#113).
  const scout = await createScout({ githubToken: token, persistence: "local" });
  const server = createServer(scout);
  await server.connect(new StdioServerTransport());
}
