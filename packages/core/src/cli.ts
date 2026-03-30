#!/usr/bin/env node

/**
 * oss-scout CLI — Find open source issues personalized to your contribution history.
 */

import { Command } from "commander";
import { enableDebug } from "./core/logger.js";
import { getCLIVersion } from "./core/utils.js";
import { formatJsonSuccess, formatJsonError } from "./formatters/json.js";
import { errorMessage, resolveErrorCode } from "./core/errors.js";
import {
  hasLocalState,
  loadLocalState,
  saveLocalState,
} from "./core/local-state.js";
import { CONCRETE_STRATEGIES, SearchStrategySchema } from "./core/schemas.js";
import type { SearchStrategy } from "./core/schemas.js";

function handleCommandError(err: unknown, options: { json?: boolean }): never {
  if (options.json) {
    console.log(formatJsonError(errorMessage(err), resolveErrorCode(err)));
  } else {
    console.error("Error:", errorMessage(err));
  }
  process.exit(1);
}

const program = new Command();

program
  .name("oss-scout")
  .description(
    "Find open source issues personalized to your contribution history",
  )
  .version(getCLIVersion())
  .option("--debug", "Enable debug output");

// Parse --debug early so it's available in preAction hooks
program.hook("preAction", (_thisCommand, _actionCommand) => {
  const opts = program.opts();
  if (opts.debug) enableDebug();
});

program
  .command("setup")
  .description("Interactive first-run configuration")
  .option("--json", "Output as JSON")
  .action(async (options: { json?: boolean }) => {
    try {
      const { runSetup } = await import("./commands/setup.js");
      const prefs = await runSetup();
      const state = loadLocalState();
      state.preferences = prefs;
      saveLocalState(state);
      if (options.json) {
        console.log(formatJsonSuccess(prefs));
      }
    } catch (err) {
      handleCommandError(err, options);
    }
  });

program
  .command("bootstrap")
  .description("Import starred repos and PR history from GitHub")
  .option("--json", "Output as JSON")
  .action(async (options: { json?: boolean }) => {
    try {
      const { bootstrapScout } = await import("./core/bootstrap.js");
      const { createScout } = await import("./scout.js");
      const { requireGitHubToken } = await import("./core/utils.js");
      const token = requireGitHubToken();
      const state = loadLocalState();
      const scout = await createScout({
        githubToken: token,
        persistence: "provided",
        initialState: state,
      });
      const result = await bootstrapScout(scout, token);
      saveLocalState(scout.getState());

      if (options.json) {
        console.log(formatJsonSuccess(result));
      } else {
        if (result.skippedDueToRateLimit) {
          console.log(
            "Skipped: GitHub API rate limit too low. Try again later.",
          );
        } else {
          console.log(
            `Imported ${result.mergedPRCount} merged PRs, ${result.closedPRCount} closed PRs, ${result.starredRepoCount} starred repos`,
          );
          console.log(`Scored ${result.reposScoredCount} repositories`);
        }
      }
    } catch (err) {
      handleCommandError(err, options);
    }
  });

program
  .command("search [count]")
  .description("Search for contributable issues using multi-strategy discovery")
  .option("--json", "Output as JSON")
  .option(
    "--strategy <strategies>",
    `Search strategies (${CONCRETE_STRATEGIES.join(",")},all)`,
    "all",
  )
  .action(
    async (
      count: string | undefined,
      options: { json?: boolean; strategy?: string },
    ) => {
      try {
        if (!hasLocalState()) {
          console.log(
            "💡 Run `oss-scout setup` to configure your preferences for personalized search results.\n",
          );
        }
        const { runSearch } = await import("./commands/search.js");
        const maxResults = count ? parseInt(count, 10) : 10;
        if (isNaN(maxResults) || maxResults < 1) {
          console.error("Error: count must be a positive integer");
          process.exit(1);
        }
        const state = loadLocalState();
        if (
          state.mergedPRs.length === 0 &&
          state.starredRepos.length === 0 &&
          state.preferences.githubUsername
        ) {
          console.log(
            "Run `oss-scout bootstrap` to import your starred repos and PR history for better results.\n",
          );
        }
        // Parse --strategy option
        const strategyTokens = (options.strategy ?? "all")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const strategies: SearchStrategy[] = [];
        for (const token of strategyTokens) {
          const parsed = SearchStrategySchema.safeParse(token);
          if (!parsed.success) {
            const valid = [...CONCRETE_STRATEGIES, "all"].join(", ");
            console.error(
              'Error: unknown strategy "' +
                token +
                '". Valid strategies: ' +
                valid,
            );
            process.exit(1);
          }
          strategies.push(parsed.data);
        }

        const results = await runSearch({ maxResults, state, strategies });
        if (options.json) {
          console.log(formatJsonSuccess(results));
        } else {
          // Human-readable output
          console.log(
            `\nFound ${results.candidates.length} issue candidates:\n`,
          );
          for (const c of results.candidates) {
            const icon =
              c.recommendation === "approve"
                ? "✅"
                : c.recommendation === "skip"
                  ? "❌"
                  : "⚠️";
            console.log(
              `  ${icon} ${c.issue.repo}#${c.issue.number} [${c.viabilityScore}/100]`,
            );
            console.log(`     ${c.issue.title}`);
            console.log(`     ${c.issue.url}`);
            if (c.repoScore) {
              console.log(
                `     Repo: ${c.repoScore.score}/10, ${c.repoScore.mergedPRCount} merged PRs`,
              );
            }
            console.log();
          }
          if (results.rateLimitWarning) {
            console.error(`\n⚠️  ${results.rateLimitWarning}`);
          }
        }
      } catch (err) {
        handleCommandError(err, options);
      }
    },
  );

// ── results command ────────────────────────────────────────────────

const resultsCmd = program
  .command("results")
  .description("Show saved search results");

resultsCmd
  .command("show", { isDefault: true })
  .description("Display saved search results")
  .option("--json", "Output as JSON")
  .action(async (options: { json?: boolean }) => {
    try {
      const { runResults } = await import("./commands/results.js");
      const results = await runResults(options);
      if (options.json) {
        console.log(formatJsonSuccess(results));
      } else {
        if (results.length === 0) {
          console.log(
            "\nNo saved results. Run `oss-scout search` to find issues.\n",
          );
          return;
        }
        console.log(`\nSaved results (${results.length}):\n`);
        console.log(
          "  Score  Repo                              Issue   Recommendation  Title",
        );
        console.log(
          "  ─────  ────────────────────────────────  ──────  ──────────────  ─────",
        );
        for (const r of results) {
          const score = String(r.viabilityScore).padStart(3);
          const repo = r.repo.padEnd(32).slice(0, 32);
          const issue = `#${r.number}`.padEnd(6);
          const rec = r.recommendation.padEnd(14);
          const title =
            r.title.length > 50 ? r.title.slice(0, 47) + "..." : r.title;
          console.log(`  ${score}    ${repo}  ${issue}  ${rec}  ${title}`);
        }
        console.log();
      }
    } catch (err) {
      handleCommandError(err, options);
    }
  });

resultsCmd
  .command("clear")
  .description("Clear all saved results")
  .option("--json", "Output as JSON")
  .action(async (options: { json?: boolean }) => {
    try {
      const { runResultsClear } = await import("./commands/results.js");
      await runResultsClear();
      if (options.json) {
        console.log(formatJsonSuccess({ cleared: true }));
      } else {
        console.log("Saved results cleared.");
      }
    } catch (err) {
      handleCommandError(err, options);
    }
  });

// ── config command ──────────────────────────────────────────────────

const configCmd = program
  .command("config")
  .description("View and update preferences")
  .option("--json", "Output as JSON")
  .action(async (options: { json?: boolean }) => {
    try {
      const { runConfigShow, getConfigData } =
        await import("./commands/config.js");
      if (options.json) {
        console.log(formatJsonSuccess(getConfigData()));
      } else {
        runConfigShow();
      }
    } catch (err) {
      handleCommandError(err, options);
    }
  });

configCmd
  .command("set <key> <value>")
  .description("Update a single preference (e.g. config set minStars 100)")
  .option("--json", "Output as JSON")
  .action(async (key: string, value: string, options: { json?: boolean }) => {
    try {
      const { runConfigSet } = await import("./commands/config.js");
      const updated = runConfigSet(key, value);
      if (options.json) {
        console.log(formatJsonSuccess(updated));
      } else {
        console.log(`✅ Updated "${key}" successfully.`);
      }
    } catch (err) {
      handleCommandError(err, options);
    }
  });

configCmd
  .command("reset")
  .description("Reset all preferences to defaults")
  .option("--json", "Output as JSON")
  .action(async (options: { json?: boolean }) => {
    try {
      const { runConfigReset } = await import("./commands/config.js");
      const defaults = runConfigReset();
      if (options.json) {
        console.log(formatJsonSuccess(defaults));
      } else {
        console.log("✅ Preferences reset to defaults.");
      }
    } catch (err) {
      handleCommandError(err, options);
    }
  });

program
  .command("vet-list")
  .description(
    "Re-vet all saved search results and classify their current status",
  )
  .option("--prune", "Remove unavailable issues from saved results")
  .option(
    "--concurrency <n>",
    "Max concurrent API requests (default: 5)",
    parseInt,
  )
  .option("--json", "Output as JSON")
  .action(
    async (options: {
      prune?: boolean;
      concurrency?: number;
      json?: boolean;
    }) => {
      try {
        if (
          options.concurrency !== undefined &&
          (isNaN(options.concurrency) || options.concurrency < 1)
        ) {
          console.error("Error: --concurrency must be a positive integer");
          process.exit(1);
        }
        const { runVetList } = await import("./commands/vet-list.js");
        const state = loadLocalState();
        const result = await runVetList({
          state,
          prune: options.prune,
          concurrency: options.concurrency,
        });
        if (options.json) {
          console.log(formatJsonSuccess(result));
        } else {
          if (result.results.length === 0) {
            console.log(
              "\nNo saved results to vet. Run `oss-scout search` first.\n",
            );
            return;
          }
          console.log(`\nVet-list results (${result.summary.total}):\n`);
          for (const r of result.results) {
            const icon =
              r.status === "still_available"
                ? "✅"
                : r.status === "claimed"
                  ? "🔒"
                  : r.status === "has_pr"
                    ? "🔀"
                    : r.status === "closed"
                      ? "🚫"
                      : "❌";
            const score =
              r.viabilityScore != null ? ` [${r.viabilityScore}/100]` : "";
            console.log(
              `  ${icon} ${r.repo}#${r.number} — ${r.status}${score}`,
            );
            console.log(`     ${r.title}`);
          }
          console.log(
            `\nSummary: ${result.summary.stillAvailable} available, ${result.summary.claimed} claimed, ${result.summary.hasPR} has PR, ${result.summary.closed} closed, ${result.summary.errors} errors`,
          );
          if (result.prunedCount != null) {
            console.log(
              `Pruned ${result.prunedCount} unavailable issues from saved results.`,
            );
          }
          console.log();
        }
      } catch (err) {
        handleCommandError(err, options);
      }
    },
  );

program
  .command("vet <issue-url>")
  .description(
    "Vet a specific GitHub issue for claimability and project health",
  )
  .option("--json", "Output as JSON")
  .action(async (issueUrl: string, options: { json?: boolean }) => {
    try {
      const { runVet } = await import("./commands/vet.js");
      const state = loadLocalState();
      const result = await runVet({ issueUrl, state });
      if (options.json) {
        console.log(formatJsonSuccess(result));
      } else {
        const icon =
          result.recommendation === "approve"
            ? "✅"
            : result.recommendation === "skip"
              ? "❌"
              : "⚠️";
        console.log(
          `\n${icon} ${result.issue.repo}#${result.issue.number}: ${result.recommendation.toUpperCase()}`,
        );
        console.log(`   ${result.issue.title}`);
        console.log(`   ${result.issue.url}\n`);
        if (result.reasonsToApprove.length > 0) {
          console.log("Reasons to approve:");
          for (const r of result.reasonsToApprove) console.log(`  + ${r}`);
        }
        if (result.reasonsToSkip.length > 0) {
          console.log("Reasons to skip:");
          for (const r of result.reasonsToSkip) console.log(`  - ${r}`);
        }
        console.log(
          `\nProject health: ${result.projectHealth.isActive ? "Active" : "Inactive"}`,
        );
        console.log(
          `  Last commit: ${result.projectHealth.daysSinceLastCommit} days ago`,
        );
        console.log(`  CI status: ${result.projectHealth.ciStatus}`);
      }
    } catch (err) {
      handleCommandError(err, options);
    }
  });

program.parse();
