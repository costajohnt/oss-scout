import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OssScout } from "@oss-scout/core";
import {
  SearchStrategySchema,
  ScoutPreferencesSchema,
  ISSUE_URL_PATTERN,
  validateGitHubUrl,
  validateUrl,
} from "@oss-scout/core";

// Generous ceiling: even with inter-phase delays zeroed, vetting many issues
// under the budget tracker's sliding-window pacing can take minutes (#143).
const TOOL_TIMEOUT_MS = 300000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number = TOOL_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timer = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Request timed out after ${ms / 1000}s`)),
      ms,
    );
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeoutId!));
}

export function registerTools(server: McpServer, scout: OssScout): void {
  server.tool(
    "search",
    "Search for open source issues matching your preferences",
    {
      maxResults: z
        .number()
        .optional()
        .describe("Maximum number of results to return (default 10)"),
      strategies: z
        .string()
        .optional()
        .describe(
          "Comma-separated search strategies: merged, starred, broad, maintained, all",
        ),
      preferLanguages: z
        .array(z.string())
        .optional()
        .describe(
          "Soft-boost ranking for candidates whose repo language matches one of these (case-insensitive). Personalization tier between recommendation and viabilityScore (#1244). Not a filter; only reorders.",
        ),
      preferRepos: z
        .array(z.string())
        .optional()
        .describe(
          "Soft-boost ranking for candidates in one of these `owner/repo` slugs. Stronger weight than language match (#1244). Not a filter; only reorders.",
        ),
      diversityRatio: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "Diversity counterweight (#1244): fraction of result slots reserved for candidates that matched NEITHER preference list. Counters echo-chamber bias when boosts accumulate over time. 0 disables, 1 reserves every slot for diversity. Default 0.",
        ),
    },
    async ({
      maxResults,
      strategies,
      preferLanguages,
      preferRepos,
      diversityRatio,
    }) => {
      try {
        const parsedStrategies = strategies
          ? strategies
              .split(",")
              .map((s) => SearchStrategySchema.parse(s.trim()))
          : undefined;

        const result = await withTimeout(
          scout.search({
            maxResults: maxResults ?? 10,
            strategies: parsedStrategies,
            preferLanguages,
            preferRepos,
            diversityRatio,
            // No fixed inter-phase sleeps in the request/response MCP context;
            // the budget tracker still paces the GitHub calls (#143)
            interPhaseDelayMs: 0,
            broadPhaseDelayMs: 0,
          }),
        );

        scout.saveResults(result.candidates);
        await scout.checkpoint();

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "scout-features",
    "Surface feature-scoped contribution opportunities in repos where you have 3+ merged PRs",
    {
      maxResults: z
        .number()
        .optional()
        .describe("Maximum number of results to return (default 10)"),
      anchorThreshold: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Anchor threshold override (default 3)"),
      splitRatio: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Quick-wins/bigger-bets split ratio (default 0.6)"),
    },
    async ({ maxResults, anchorThreshold, splitRatio }) => {
      try {
        const result = await withTimeout(
          scout.features({
            count: maxResults ?? 10,
            anchorThreshold,
            splitRatio,
          }),
        );
        scout.saveResults([...result.quickWins, ...result.biggerBets]);
        await scout.checkpoint();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "vet",
    "Vet a specific GitHub issue for contribution viability",
    {
      issueUrl: z
        .string()
        .describe(
          "Full GitHub issue URL (e.g. https://github.com/owner/repo/issues/123)",
        ),
    },
    async ({ issueUrl }) => {
      try {
        const candidate = await withTimeout(scout.vetIssue(issueUrl));
        return {
          content: [{ type: "text", text: JSON.stringify(candidate, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "config",
    "Show current oss-scout configuration preferences",
    async () => {
      const preferences = scout.getPreferences();
      return {
        content: [{ type: "text", text: JSON.stringify(preferences, null, 2) }],
      };
    },
  );

  server.tool(
    "skip",
    "Skip, unskip, list, or clear skipped issues. Skipped issues are excluded from future searches and auto-expire after 90 days.",
    {
      action: z
        .enum(["add", "remove", "list", "clear"])
        .default("add")
        .describe("Action to perform (default: add)"),
      issueUrl: z
        .string()
        .optional()
        .describe("GitHub issue URL (required for add/remove actions)"),
    },
    async ({ action, issueUrl }) => {
      try {
        if ((action === "add" || action === "remove") && !issueUrl) {
          return {
            content: [
              {
                type: "text",
                text: `Error: issueUrl is required for the "${action}" action.`,
              },
            ],
            isError: true,
          };
        }

        if (action === "list") {
          const skipped = scout.getSkippedIssues();
          return {
            content: [{ type: "text", text: JSON.stringify(skipped, null, 2) }],
          };
        }

        if (action === "clear") {
          const count = scout.getSkippedIssues().length;
          scout.clearSkippedIssues();
          const synced = await scout.checkpoint();
          const syncNote = synced ? "" : " (saved locally, gist sync failed)";
          return {
            content: [
              {
                type: "text",
                text:
                  count > 0
                    ? `Skip list cleared (${count} entries removed)${syncNote}`
                    : `Skip list already empty${syncNote}`,
              },
            ],
          };
        }

        if (action === "remove") {
          const wasPresent = scout
            .getSkippedIssues()
            .some((s) => s.url === issueUrl);
          scout.unskipIssue(issueUrl!);
          const synced = await scout.checkpoint();
          const syncNote = synced ? "" : " (saved locally, gist sync failed)";
          return {
            content: [
              {
                type: "text",
                text: wasPresent
                  ? `Removed from skip list: ${issueUrl}${syncNote}`
                  : `Not in skip list: ${issueUrl}`,
              },
            ],
          };
        }

        // action === "add"
        // Same validation as the CLI's runSkip: skip matching is exact-URL,
        // so junk or near-miss URLs would be stored but never match anything.
        // The throw is caught below and surfaced as isError.
        validateUrl(issueUrl!);
        validateGitHubUrl(issueUrl!, ISSUE_URL_PATTERN, "issue");
        const alreadySkipped = scout
          .getSkippedIssues()
          .some((s) => s.url === issueUrl);
        if (alreadySkipped) {
          return {
            content: [
              { type: "text", text: `Already in skip list: ${issueUrl}` },
            ],
          };
        }
        const saved = scout
          .getSavedResults()
          .find((r) => r.issueUrl === issueUrl);
        const metadata = saved
          ? {
              repo: saved.repo,
              number: saved.number,
              title: saved.title,
            }
          : undefined;
        scout.skipIssue(issueUrl!, metadata);
        const synced = await scout.checkpoint();
        const syncNote = synced ? "" : " (saved locally, gist sync failed)";
        return {
          content: [{ type: "text", text: `Skipped: ${issueUrl}${syncNote}` }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  const VALID_KEYS = Object.keys(ScoutPreferencesSchema.shape);
  const ARRAY_KEYS = new Set([
    "languages",
    "labels",
    "projectCategories",
    "excludeRepos",
    "excludeOrgs",
    "aiPolicyBlocklist",
    "scope",
    "defaultStrategy",
  ]);
  const NUMBER_KEYS = new Set([
    "minStars",
    "maxIssueAgeDays",
    "minRepoScoreThreshold",
    "interPhaseDelayMs",
    "broadPhaseDelayMs",
    "skipBroadWhenSufficientResults",
    "featuresAnchorThreshold",
    "featuresSplitRatio",
  ]);
  const BOOLEAN_KEYS = new Set(["includeDocIssues"]);

  server.tool(
    "config-set",
    "Update an oss-scout configuration preference",
    {
      key: z
        .string()
        .describe(
          "Preference key to update (e.g. languages, minStars, excludeRepos)",
        ),
      value: z
        .string()
        .describe(
          "New value — comma-separated for arrays, plain string for scalars",
        ),
    },
    async ({ key, value }) => {
      if (!VALID_KEYS.includes(key)) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown config key: "${key}". Valid keys: ${VALID_KEYS.join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      let parsed: unknown;
      if (ARRAY_KEYS.has(key)) {
        // Accept comma-separated strings → arrays
        try {
          parsed = JSON.parse(value);
          if (!Array.isArray(parsed)) {
            parsed = value
              .split(",")
              .map((s: string) => s.trim())
              .filter(Boolean);
          }
        } catch {
          parsed = value
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean);
        }
      } else if (NUMBER_KEYS.has(key)) {
        const num = Number(value);
        if (isNaN(num)) {
          return {
            content: [
              { type: "text", text: `Invalid number for "${key}": "${value}"` },
            ],
            isError: true,
          };
        }
        parsed = num;
      } else if (BOOLEAN_KEYS.has(key)) {
        const lower = value.toLowerCase();
        if (lower === "true" || lower === "yes") parsed = true;
        else if (lower === "false" || lower === "no") parsed = false;
        else {
          return {
            content: [
              {
                type: "text",
                text: `Invalid boolean for "${key}": "${value}". Use true/false or yes/no.`,
              },
            ],
            isError: true,
          };
        }
      } else {
        // String or enum fields — pass through as-is
        parsed = value;
      }

      const currentPrefs = scout.getPreferences();
      const candidate = { ...currentPrefs, [key]: parsed };

      // Validate the full preferences object with Zod
      const result = ScoutPreferencesSchema.safeParse(candidate);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        return {
          content: [{ type: "text", text: `Validation error: ${issues}` }],
          isError: true,
        };
      }

      scout.updatePreferences({ [key]: parsed });
      await scout.checkpoint();
      const updated = scout.getPreferences();
      return {
        content: [{ type: "text", text: JSON.stringify(updated, null, 2) }],
      };
    },
  );
}
