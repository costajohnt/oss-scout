import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OssScout } from '@oss-scout/core';

export function registerResources(server: McpServer, scout: OssScout): void {
  server.resource(
    'config',
    'scout://config',
    { description: 'Current oss-scout preferences' },
    async () => ({
      contents: [{
        uri: 'scout://config',
        mimeType: 'application/json',
        text: JSON.stringify(scout.getPreferences(), null, 2),
      }],
    }),
  );

  server.resource(
    'results',
    'scout://results',
    { description: 'Saved search results from previous runs' },
    async () => ({
      contents: [{
        uri: 'scout://results',
        mimeType: 'application/json',
        text: JSON.stringify(scout.getSavedResults(), null, 2),
      }],
    }),
  );

  server.resource(
    'scores',
    'scout://scores',
    { description: 'Repository score data based on contribution history' },
    async () => {
      const state = scout.getState();
      return {
        contents: [{
          uri: 'scout://scores',
          mimeType: 'application/json',
          text: JSON.stringify(state.repoScores, null, 2),
        }],
      };
    },
  );
}
