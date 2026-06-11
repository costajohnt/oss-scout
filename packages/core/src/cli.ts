#!/usr/bin/env node

/**
 * oss-scout CLI — Find open source issues personalized to your contribution history.
 */

import { Command } from "commander";
import { enableDebug } from "./core/logger.js";
import { getCLIVersion } from "./core/utils.js";
import { formatJsonSuccess, formatJsonError } from "./formatters/json.js";
import {
  ValidationError,
  errorMessage,
  resolveErrorCode,
} from "./core/errors.js";
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
      state.preferencesUpdatedAt = new Date().toISOString(); // #117 merge recency
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
    `Search strategies (${CONCRETE_STRATEGIES.join(",")},all). Defaults to the defaultStrategy preference, or all.`,
  )
  .option(
    "--prefer-languages <list>",
    "Comma-separated languages to soft-boost in ranking (#1244). Candidates whose repo language matches sort above equally-recommended non-matches. Does not filter results.",
  )
  .option(
    "--prefer-repos <list>",
    "Comma-separated `owner/repo` slugs to soft-boost in ranking (#1244). Stronger weight than language match. Does not filter results.",
  )
  .option(
    "--diversity-ratio <n>",
    "Fraction of result slots (0-1) reserved for candidates that matched NEITHER preference list (#1244). Counterweights echo-chamber bias as boosts accumulate. Default 0 (disabled).",
  )
  .action(
    async (
      count: string | undefined,
      options: {
        json?: boolean;
        strategy?: string;
        preferLanguages?: string;
        preferRepos?: string;
        diversityRatio?: string;
      },
    ) => {
      try {
        if (!hasLocalState() && !options.json) {
          // Human hint only: stdout must stay pure JSON under --json (#131)
          console.log(
            "💡 Run `oss-scout setup` to configure your preferences for personalized search results.\n",
          );
        }
        const { runSearch } = await import("./commands/search.js");
        const maxResults = count ? parseInt(count, 10) : 10;
        if (isNaN(maxResults) || maxResults < 1) {
          throw new ValidationError("count must be a positive integer");
        }
        const state = loadLocalState();
        if (
          state.mergedPRs.length === 0 &&
          state.starredRepos.length === 0 &&
          state.preferences.githubUsername &&
          !options.json
        ) {
          console.log(
            "Run `oss-scout bootstrap` to import your starred repos and PR history for better results.\n",
          );
        }
        // Parse --strategy. Absent means undefined so the stored
        // defaultStrategy preference applies (discovery falls back to "all").
        let strategies: SearchStrategy[] | undefined;
        if (options.strategy !== undefined) {
          const strategyTokens = options.strategy
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          strategies = [];
          for (const token of strategyTokens) {
            const parsed = SearchStrategySchema.safeParse(token);
            if (!parsed.success) {
              const valid = [...CONCRETE_STRATEGIES, "all"].join(", ");
              throw new ValidationError(
                `unknown strategy "${token}". Valid strategies: ${valid}`,
              );
            }
            strategies.push(parsed.data);
          }
        }

        const splitCsv = (raw: string | undefined): string[] | undefined => {
          if (!raw) return undefined;
          const parts = raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          return parts.length > 0 ? parts : undefined;
        };
        let diversityRatio: number | undefined;
        if (options.diversityRatio !== undefined) {
          const parsed = Number(options.diversityRatio);
          if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
            throw new ValidationError(
              `--diversity-ratio must be a number in [0, 1] (got "${options.diversityRatio}")`,
            );
          }
          diversityRatio = parsed;
        }
        const results = await runSearch({
          maxResults,
          state,
          strategies,
          preferLanguages: splitCsv(options.preferLanguages),
          preferRepos: splitCsv(options.preferRepos),
          diversityRatio,
        });
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
            const stalledTag = c.linkedPR?.isStalled
              ? " (stalled PR, revive opportunity)"
              : "";
            // Personalization tag (#1244). A candidate is either boosted
            // (matched a preference) or a diversity slot (matched none and
            // filled a reserved slot); never both.
            let personalizationTag = "";
            if (c.boostScore && c.boostReasons && c.boostReasons.length > 0) {
              personalizationTag = ` [boosted: ${c.boostReasons.join("; ")}]`;
            } else if (c.diversitySlot) {
              personalizationTag = " [diversity slot]";
            }
            console.log(
              `  ${icon} ${c.issue.repo}#${c.issue.number} [${c.viabilityScore}/100]${personalizationTag}${stalledTag}`,
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

program
  .command("features [count]")
  .description(
    "Surface feature-scoped opportunities in repos where you have 3+ merged PRs",
  )
  .option("--json", "Output as JSON")
  .option("--anchor-threshold <n>", "Override featuresAnchorThreshold (1-50)")
  .option("--split-ratio <r>", "Override featuresSplitRatio (0-1, e.g. 0.6)")
  .option(
    "--broad",
    "Bypass anchor repos; search feature issues across the ecosystem (first-touch mode)",
  )
  .action(
    async (
      count: string | undefined,
      options: {
        json?: boolean;
        anchorThreshold?: string;
        splitRatio?: string;
        broad?: boolean;
      },
    ) => {
      try {
        const { runFeatures } = await import("./commands/features.js");
        const maxResults = count ? parseInt(count, 10) : 10;
        if (isNaN(maxResults) || maxResults < 1 || maxResults > 50) {
          throw new ValidationError(
            "count must be an integer between 1 and 50",
          );
        }
        let anchorThreshold: number | undefined;
        if (options.anchorThreshold !== undefined) {
          const parsed = parseInt(options.anchorThreshold, 10);
          if (isNaN(parsed) || parsed < 1 || parsed > 50) {
            throw new ValidationError(
              "--anchor-threshold must be an integer between 1 and 50",
            );
          }
          anchorThreshold = parsed;
        }
        let splitRatio: number | undefined;
        if (options.splitRatio !== undefined) {
          const parsed = Number.parseFloat(options.splitRatio);
          if (isNaN(parsed) || parsed < 0 || parsed > 1) {
            throw new ValidationError(
              "--split-ratio must be a number between 0 and 1",
            );
          }
          splitRatio = parsed;
        }
        const state = loadLocalState();
        const result = await runFeatures({
          maxResults,
          state,
          anchorThreshold,
          splitRatio,
          broad: options.broad,
        });
        if (options.json) {
          console.log(formatJsonSuccess(result));
        } else {
          const total = result.quickWins.length + result.biggerBets.length;
          if (result.message) {
            console.log(`\n${result.message}\n`);
          }
          if (total === 0) return;
          const headerScope = options.broad
            ? "across the ecosystem"
            : "in your anchor repos";
          console.log(
            `\n🎯 Feature opportunities ${headerScope} (${result.quickWins.length} quick wins + ${result.biggerBets.length} bigger bets)\n`,
          );
          if (!options.broad) {
            console.log(`Anchor repos: ${result.anchorRepos.join(", ")}\n`);
          }
          if (result.quickWins.length) {
            console.log(
              "── Quick wins ─────────────────────────────────────────",
            );
            for (const c of result.quickWins) {
              const stalledTag = c.linkedPR?.isStalled
                ? " (stalled PR, revive opportunity)"
                : "";
              console.log(
                `  ${c.issue.repo}#${c.issue.number} [${c.viabilityScore}/100] ${c.issue.title}${stalledTag}`,
              );
              console.log(`     ${c.issue.url}`);
            }
            console.log("");
          }
          if (result.biggerBets.length) {
            console.log(
              "── Bigger bets ────────────────────────────────────────",
            );
            for (const c of result.biggerBets) {
              const stalledTag = c.linkedPR?.isStalled
                ? " (stalled PR, revive opportunity)"
                : "";
              console.log(
                `  ${c.issue.repo}#${c.issue.number} [${c.viabilityScore}/100] ${c.issue.title}${stalledTag}`,
              );
              console.log(`     ${c.issue.url}`);
            }
            console.log("");
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
  .description(
    'Update a single preference (e.g. config set minStars 100). For dash-prefixed values like the array-remove form, escape with --: config set excludeRepos -- "-spam/repo"',
  )
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
          throw new ValidationError("--concurrency must be a positive integer");
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

// ── skip command ───────────────────────────────────────────────────

const skipCmd = program
  .command("skip")
  .description("Manage the skip list — exclude issues from future searches");

skipCmd
  .command("add <issue-url>")
  .description("Skip an issue by URL")
  .option("--json", "Output as JSON")
  .action(async (issueUrl: string, options: { json?: boolean }) => {
    try {
      const { runSkip } = await import("./commands/skip.js");
      const state = loadLocalState();
      const result = await runSkip({ issueUrl, state });
      if (options.json) {
        console.log(formatJsonSuccess(result));
      } else {
        if (result.alreadySkipped) {
          console.log("Issue already in skip list.");
        } else {
          console.log(`Skipped: ${issueUrl}`);
        }
      }
    } catch (err) {
      handleCommandError(err, options);
    }
  });

skipCmd
  .command("list")
  .description("Show all skipped issues")
  .option("--json", "Output as JSON")
  .action(async (options: { json?: boolean }) => {
    try {
      const { runSkipList } = await import("./commands/skip.js");
      const results = runSkipList();
      if (options.json) {
        console.log(formatJsonSuccess(results));
      } else {
        if (results.length === 0) {
          console.log("\nNo skipped issues.\n");
          return;
        }
        console.log(`\nSkipped issues (${results.length}):\n`);
        console.log(
          "  Repo                              Issue   Skipped     Title",
        );
        console.log(
          "  ────────────────────────────────  ──────  ──────────  ─────",
        );
        for (const s of results) {
          const repo = (s.repo || "unknown").padEnd(32).slice(0, 32);
          const issue = s.number ? `#${s.number}`.padEnd(6) : "—".padEnd(6);
          const skippedDate = s.skippedAt.split("T")[0] ?? "";
          const title =
            s.title.length > 50
              ? s.title.slice(0, 47) + "..."
              : s.title || s.url;
          console.log(`  ${repo}  ${issue}  ${skippedDate}  ${title}`);
        }
        console.log();
      }
    } catch (err) {
      handleCommandError(err, options);
    }
  });

skipCmd
  .command("remove <issue-url>")
  .description("Remove an issue from the skip list (unskip)")
  .option("--json", "Output as JSON")
  .action(async (issueUrl: string, options: { json?: boolean }) => {
    try {
      const { runSkipRemove } = await import("./commands/skip.js");
      const result = await runSkipRemove({ issueUrl });
      if (options.json) {
        console.log(formatJsonSuccess(result));
      } else {
        if (result.removed) {
          console.log(`Removed from skip list: ${issueUrl}`);
        } else {
          console.log("Issue was not in the skip list.");
        }
      }
    } catch (err) {
      handleCommandError(err, options);
    }
  });

skipCmd
  .command("clear")
  .description("Clear all skipped issues")
  .option("--json", "Output as JSON")
  .action(async (options: { json?: boolean }) => {
    try {
      const { runSkipClear } = await import("./commands/skip.js");
      await runSkipClear();
      if (options.json) {
        console.log(formatJsonSuccess({ cleared: true }));
      } else {
        console.log("Skip list cleared.");
      }
    } catch (err) {
      handleCommandError(err, options);
    }
  });

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
