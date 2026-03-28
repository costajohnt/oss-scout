#!/usr/bin/env node

/**
 * oss-scout CLI — Find open source issues personalized to your contribution history.
 */

import { Command } from 'commander';
import { enableDebug } from './core/logger.js';
import { getCLIVersion } from './core/utils.js';
import { formatJsonSuccess, formatJsonError } from './formatters/json.js';
import { resolveErrorCode } from './core/errors.js';

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
  .command('search [count]')
  .description('Search for contributable issues using multi-strategy discovery')
  .option('--json', 'Output as JSON')
  .action(async (count: string | undefined, options: { json?: boolean }) => {
    try {
      const { runSearch } = await import('./commands/search.js');
      const maxResults = count ? parseInt(count, 10) : 10;
      if (isNaN(maxResults) || maxResults < 1) {
        console.error('Error: count must be a positive integer');
        process.exit(1);
      }
      const results = await runSearch({ maxResults });
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

program
  .command('vet <issue-url>')
  .description('Vet a specific GitHub issue for claimability and project health')
  .option('--json', 'Output as JSON')
  .action(async (issueUrl: string, options: { json?: boolean }) => {
    try {
      const { runVet } = await import('./commands/vet.js');
      const result = await runVet({ issueUrl });
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
