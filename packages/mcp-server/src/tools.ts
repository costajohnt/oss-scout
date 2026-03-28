import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OssScout } from '@oss-scout/core';
import { SearchStrategySchema } from '@oss-scout/core';

export function registerTools(server: McpServer, scout: OssScout): void {
  server.tool(
    'search',
    'Search for open source issues matching your preferences',
    {
      maxResults: z.number().optional().describe('Maximum number of results to return (default 10)'),
      strategies: z.string().optional().describe('Comma-separated search strategies: merged, orgs, starred, broad, maintained, all'),
    },
    async ({ maxResults, strategies }) => {
      const parsedStrategies = strategies
        ? strategies.split(',').map((s) => SearchStrategySchema.parse(s.trim()))
        : undefined;

      const result = await scout.search({
        maxResults: maxResults ?? 10,
        strategies: parsedStrategies,
      });

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'vet',
    'Vet a specific GitHub issue for contribution viability',
    {
      issueUrl: z.string().describe('Full GitHub issue URL (e.g. https://github.com/owner/repo/issues/123)'),
    },
    async ({ issueUrl }) => {
      const candidate = await scout.vetIssue(issueUrl);
      return { content: [{ type: 'text', text: JSON.stringify(candidate, null, 2) }] };
    },
  );

  server.tool(
    'config',
    'Show current oss-scout configuration preferences',
    async () => {
      const preferences = scout.getPreferences();
      return { content: [{ type: 'text', text: JSON.stringify(preferences, null, 2) }] };
    },
  );

  server.tool(
    'config-set',
    'Update an oss-scout configuration preference',
    {
      key: z.string().describe('Preference key to update (e.g. languages, minStars, excludeRepos)'),
      value: z.string().describe('New value — JSON for arrays/objects, plain string for scalars'),
    },
    async ({ key, value }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = value;
      }
      scout.updatePreferences({ [key]: parsed });
      const updated = scout.getPreferences();
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    },
  );
}
