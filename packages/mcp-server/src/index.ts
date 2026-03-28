import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createScout, getGitHubToken } from '@oss-scout/core';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';

async function main(): Promise<void> {
  const token = getGitHubToken();
  if (!token) {
    process.stderr.write(
      'oss-scout-mcp: GitHub token required.\n' +
      'Set GITHUB_TOKEN or run `gh auth login`.\n',
    );
    process.exit(1);
  }

  const scout = await createScout({ githubToken: token });

  const server = new McpServer(
    { name: 'oss-scout', version: '0.1.0' },
    { capabilities: { resources: {}, tools: {} } },
  );

  registerTools(server, scout);
  registerResources(server, scout);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`oss-scout-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
