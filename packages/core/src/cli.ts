#!/usr/bin/env node

/**
 * oss-scout CLI — Find open source issues personalized to your contribution history.
 */

import { Command } from 'commander';
import { enableDebug } from './core/logger.js';
import { getCLIVersion } from './core/utils.js';
import { formatJsonSuccess, formatJsonError } from './formatters/json.js';
import { resolveErrorCode } from './core/errors.js';
import { hasLocalState, loadLocalState, saveLocalState } from './core/local-state.js';

const program = new Command();

program
  .name('oss-scout')
  .description('Find open source issues personalized to your contribution history')
  .version(getCLIVersion())
  .option('--debug', 'Enable debug output');

// Parse --debug early so it's available in preAction hooks
program.hook('preAction', (_thisCommand, _actionCommand) => {
  const opts = program.opts();
  if (opts.debug) enableDebug();
});

program
  .command('setup')
  .description('Interactive first-run configuration')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      const { runSetup } = await import('./commands/setup.js');
      const prefs = await runSetup();
      const state = loadLocalState();
      state.preferences = prefs;
      saveLocalState(state);
      if (options.json) {
        console.log(formatJsonSuccess(prefs));
      }
    } catch (err) {
      if (options.json) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(formatJsonError(msg, resolveErrorCode(err)));
      } else {
        console.error('Error:', err instanceof Error ? err.message : String(err));
      }
      process.exit(1);
    }
  });

program
  .command('search [count]')
  .description('Search for contributable issues using multi-strategy discovery')
  .option('--json', 'Output as JSON')
  .action(async (count: string | undefined, options: { json?: boolean }) => {
    try {
      if (!hasLocalState()) {
        console.log('💡 Run `oss-scout setup` to configure your preferences for personalized search results.\n');
      }
      const { runSearch } = await import('./commands/search.js');
      const maxResults = count ? parseInt(count, 10) : 10;
      if (isNaN(maxResults) || maxResults < 1) {
        console.error('Error: count must be a positive integer');
        process.exit(1);
      }
      const state = loadLocalState();
      const results = await runSearch({ maxResults, state });
      if (options.json) {
        console.log(formatJsonSuccess(results));
      } else {
        // Human-readable output
        console.log(`\nFound ${results.candidates.length} issue candidates:\n`);
        for (const c of results.candidates) {
          const icon = c.recommendation === 'approve' ? '✅' : c.recommendation === 'skip' ? '❌' : '⚠️';
          console.log(`  ${icon} ${c.issue.repo}#${c.issue.number} [${c.viabilityScore}/100]`);
          console.log(`     ${c.issue.title}`);
          console.log(`     ${c.issue.url}`);
          if (c.repoScore) {
            console.log(`     Repo: ${c.repoScore.score}/10, ${c.repoScore.mergedPRCount} merged PRs`);
          }
          console.log();
        }
        if (results.rateLimitWarning) {
          console.error(`\n⚠️  ${results.rateLimitWarning}`);
        }
      }
    } catch (err) {
      if (options.json) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(formatJsonError(msg, resolveErrorCode(err)));
      } else {
        console.error('Error:', err instanceof Error ? err.message : String(err));
      }
      process.exit(1);
    }
  });

// ── results command ────────────────────────────────────────────────

const resultsCmd = program
  .command('results')
  .description('Show saved search results');

resultsCmd
  .command('show', { isDefault: true })
  .description('Display saved search results')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      const { runResults } = await import('./commands/results.js');
      const results = await runResults(options);
      if (options.json) {
        console.log(formatJsonSuccess(results));
      } else {
        if (results.length === 0) {
          console.log('\nNo saved results. Run `oss-scout search` to find issues.\n');
          return;
        }
        console.log(`\nSaved results (${results.length}):\n`);
        console.log(
          '  Score  Repo                              Issue   Recommendation  Title',
        );
        console.log(
          '  ─────  ────────────────────────────────  ──────  ──────────────  ─────',
        );
        for (const r of results) {
          const score = String(r.viabilityScore).padStart(3);
          const repo = r.repo.padEnd(32).slice(0, 32);
          const issue = `#${r.number}`.padEnd(6);
          const rec = r.recommendation.padEnd(14);
          const title = r.title.length > 50 ? r.title.slice(0, 47) + '...' : r.title;
          console.log(`  ${score}    ${repo}  ${issue}  ${rec}  ${title}`);
        }
        console.log();
      }
    } catch (err) {
      if (options.json) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(formatJsonError(msg, resolveErrorCode(err)));
      } else {
        console.error('Error:', err instanceof Error ? err.message : String(err));
      }
      process.exit(1);
    }
  });

resultsCmd
  .command('clear')
  .description('Clear all saved results')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      const { runResultsClear } = await import('./commands/results.js');
      await runResultsClear();
      if (options.json) {
        console.log(formatJsonSuccess({ cleared: true }));
      } else {
        console.log('Saved results cleared.');
      }
    } catch (err) {
      if (options.json) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(formatJsonError(msg, resolveErrorCode(err)));
      } else {
        console.error('Error:', err instanceof Error ? err.message : String(err));
      }
      process.exit(1);
    }
  });

program
  .command('vet <issue-url>')
  .description('Vet a specific GitHub issue for claimability and project health')
  .option('--json', 'Output as JSON')
  .action(async (issueUrl: string, options: { json?: boolean }) => {
    try {
      const { runVet } = await import('./commands/vet.js');
      const state = loadLocalState();
      const result = await runVet({ issueUrl, state });
      if (options.json) {
        console.log(formatJsonSuccess(result));
      } else {
        const icon = result.recommendation === 'approve' ? '✅' : result.recommendation === 'skip' ? '❌' : '⚠️';
        console.log(`\n${icon} ${result.issue.repo}#${result.issue.number}: ${result.recommendation.toUpperCase()}`);
        console.log(`   ${result.issue.title}`);
        console.log(`   ${result.issue.url}\n`);
        if (result.reasonsToApprove.length > 0) {
          console.log('Reasons to approve:');
          for (const r of result.reasonsToApprove) console.log(`  + ${r}`);
        }
        if (result.reasonsToSkip.length > 0) {
          console.log('Reasons to skip:');
          for (const r of result.reasonsToSkip) console.log(`  - ${r}`);
        }
        console.log(`\nProject health: ${result.projectHealth.isActive ? 'Active' : 'Inactive'}`);
        console.log(`  Last commit: ${result.projectHealth.daysSinceLastCommit} days ago`);
        console.log(`  CI status: ${result.projectHealth.ciStatus}`);
      }
    } catch (err) {
      if (options.json) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(formatJsonError(msg, resolveErrorCode(err)));
      } else {
        console.error('Error:', err instanceof Error ? err.message : String(err));
      }
      process.exit(1);
    }
  });

program.parse();
