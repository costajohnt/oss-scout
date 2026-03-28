<p align="center">
  <img src="assets/icon.svg" alt="oss-scout" width="120">
</p>

<h1 align="center">oss-scout</h1>

<p align="center">
  Find open source issues personalized to <em>your</em> contribution history
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node 20+">
  <img src="https://img.shields.io/badge/TypeScript-strict-blue" alt="TypeScript Strict">
</p>

Most issue finders search GitHub for `good first issue` labels and hand you a list. You could do that yourself in 30 seconds.

**oss-scout is different.** It knows which repos you've contributed to, which maintainers have merged your work before, and which projects are actually responsive. It searches strategically, vets every result, and tells you where your next PR has the highest chance of getting merged.

## How It Works

oss-scout runs a multi-phase search that prioritizes your existing relationships:

```
Phase 0   Repos where you have merged PRs          (highest merge probability)
Phase 0.5 Your preferred organizations              (explicit interest)
Phase 1   Your starred repos                        (implicit interest)
Phase 2   General label-filtered search             (discovery)
Phase 3   Actively maintained repos by topic        (exploration)
```

Every candidate goes through deep vetting:

- **Is someone already working on it?** Checks for linked PRs via timeline API, scans comments for claim phrases
- **Is the project healthy?** Recent commits, open issue count, star/fork quality
- **Are the requirements clear?** Analyzes issue body for numbered steps, code blocks, expected behavior
- **Does the repo have contribution guidelines?** Probes for CONTRIBUTING.md variants, extracts branch naming, test framework, CLA requirements

Each issue gets a **viability score (0-100)** combining repo quality, your relationship strength, issue clarity, and freshness. Results are sorted by merge probability, not just label matches.

## Quick Start

### CLI

```bash
# Search for issues (uses gh auth token automatically)
npx @oss-scout/core search 10

# Search with JSON output
npx @oss-scout/core search 10 --json

# Vet a specific issue before working on it
npx @oss-scout/core vet https://github.com/owner/repo/issues/123
```

### As a Library

```bash
npm install @oss-scout/core
```

```typescript
import { createScout } from '@oss-scout/core';

const scout = await createScout({ githubToken: process.env.GITHUB_TOKEN });
const results = await scout.search({ maxResults: 10 });

for (const c of results.candidates) {
  console.log(`${c.issue.repo}#${c.issue.number}: ${c.viabilityScore}/100`);
  console.log(`  ${c.recommendation} — ${c.reasonsToApprove.join(', ')}`);
}
```

### Claude Code Plugin (coming soon)

The Claude Code plugin with `/scout` command and issue-scout agent is planned. For now, use the CLI or library API.

## What Makes It Different

### Personalized search, not label scraping

Other tools query `label:"good first issue"` and call it a day. oss-scout builds a profile of your contribution history and uses it to prioritize repos where you have an established relationship. Your first search is useful; your tenth search is better, because the tool has learned which repos merge your PRs.

### Deep vetting, not surface filtering

Every candidate is checked against 6 signals in parallel:

| Check | What it detects | Method |
|-------|----------------|--------|
| Existing PRs | Someone already submitted a fix | Timeline API (avoids Search API quota) |
| Claimed | "I'm working on this" in comments | Comment text scanning |
| Project health | Is the repo active and maintained? | Commit history, stars, forks |
| Clear requirements | Can you actually implement this? | Body analysis (steps, code blocks, keywords) |
| Contribution guidelines | Branch naming, test framework, CLA | CONTRIBUTING.md probing |
| Your merge history | Have your PRs been merged here before? | Search API (cached 15 min) |

Results are scored and classified as `approve`, `needs_review`, or `skip` with specific reasons for each.

### Rate-limit aware

GitHub's Search API allows 30 requests per minute (oss-scout reserves a safety margin of 4, using up to 26). It tracks budget across phases with a sliding-window rate limiter. When quota is low, it skips expensive phases and tells you why. When quota is critical, it runs only Phase 0 (your highest-value repos). It never burns your API quota on low-value searches.

### Spam detection

Label-farming repos (5+ beginner labels per issue), templated-title repos ("Add Question #42", "Add Question #43"), and repos with known anti-AI contribution policies are automatically filtered out.

## CLI Reference

```
oss-scout [--debug] <command>

Commands:
  search [count]           Search for contributable issues (default: 10)
    --json                 Output as structured JSON

  vet <issue-url>          Vet a specific GitHub issue
    --json                 Output as structured JSON

Global flags:
  --debug                  Enable debug logging (applies to any command)
  --version                Show version
```

### Search Output (JSON)

```json
{
  "success": true,
  "data": {
    "candidates": [
      {
        "issue": {
          "repo": "expressjs/express",
          "repoUrl": "https://github.com/expressjs/express",
          "number": 6012,
          "title": "Add timeout option to res.download()",
          "url": "https://github.com/expressjs/express/issues/6012",
          "labels": ["feature", "good first issue"]
        },
        "recommendation": "approve",
        "reasonsToApprove": [
          "Trusted project (2 PRs merged)",
          "Clear requirements",
          "Contribution guidelines found"
        ],
        "reasonsToSkip": [],
        "viabilityScore": 92,
        "searchPriority": "merged_pr",
        "repoScore": {
          "score": 9,
          "mergedPRCount": 2,
          "closedWithoutMergeCount": 0,
          "isResponsive": true
        }
      }
    ],
    "excludedRepos": ["spam/repo"],
    "aiPolicyBlocklist": ["matplotlib/matplotlib"]
  },
  "timestamp": "2026-03-27T12:00:00.000Z"
}
```

### Vet Output (JSON)

```json
{
  "success": true,
  "data": {
    "issue": {
      "repo": "expressjs/express",
      "number": 6012,
      "title": "Add timeout option to res.download()",
      "url": "https://github.com/expressjs/express/issues/6012",
      "labels": ["feature", "good first issue"]
    },
    "recommendation": "approve",
    "reasonsToApprove": ["Clear requirements", "No existing PR", "Active project"],
    "reasonsToSkip": [],
    "projectHealth": {
      "repo": "expressjs/express",
      "daysSinceLastCommit": 2,
      "isActive": true,
      "ciStatus": "unknown",
      "stargazersCount": 65000
    },
    "vettingResult": {
      "passedAllChecks": true,
      "checks": {
        "noExistingPR": true,
        "notClaimed": true,
        "projectActive": true,
        "clearRequirements": true,
        "contributionGuidelinesFound": true
      }
    }
  },
  "timestamp": "2026-03-27T12:00:00.000Z"
}
```

## Library API

### `createScout(config)`

Creates an `OssScout` instance.

```typescript
// Standalone — fresh state each run (gist persistence coming soon)
const scout = await createScout({ githubToken: 'ghp_...' });

// Library — caller provides state (e.g., from a parent application)
const scout = await createScout({
  githubToken: 'ghp_...',
  persistence: 'provided',
  initialState: existingState,
});
```

### `scout.search(options?)`

Multi-strategy search returning scored candidates.

```typescript
const results = await scout.search({ maxResults: 10 });
// results.candidates — sorted by priority, then recommendation, then score
// results.rateLimitWarning — set if API limits affected results
```

### `scout.vetIssue(url)`

Deep vet a single issue.

```typescript
const candidate = await scout.vetIssue('https://github.com/owner/repo/issues/123');
// candidate.recommendation — 'approve' | 'skip' | 'needs_review'
// candidate.viabilityScore — 0-100
// candidate.vettingResult.checks — individual check results
```

### State mutation (for host applications)

When embedded in a larger tool, the host can contribute data back:

```typescript
// Record PR outcomes to improve future search quality
scout.recordMergedPR({
  url: 'https://github.com/owner/repo/pull/42',
  title: 'Fix timeout bug',
  mergedAt: '2026-03-27T12:00:00Z',
  repo: 'owner/repo',
});

scout.recordClosedPR({ url, title, closedAt, repo });
scout.updateRepoScore('owner/repo', { signals: { isResponsive: true } });
scout.updatePreferences({ languages: ['rust', 'go'] });

// Persist changes
await scout.checkpoint();
```

## Viability Scoring

Each issue is scored 0-100 based on:

| Factor | Points | Condition |
|--------|--------|-----------|
| Base | 50 | Always |
| Repo score | +0 to +20 | From 1-10 repo quality rating |
| Repo quality bonus | +0 to +12 | Stars and forks tiers |
| Merged PRs in repo | +15 | You've had PRs merged here |
| Clear requirements | +15 | Issue body has steps, code blocks, keywords |
| Fresh issue | +0 to +15 | Updated within 14 days (full), 15-30 days (partial) |
| Contribution guidelines | +10 | CONTRIBUTING.md found and parsed |
| Org affinity | +5 | You've merged PRs in other repos under same org |
| Category match | +5 | Matches your preferred project categories |
| Existing PR | -30 | Someone already submitted a fix |
| Claimed | -20 | Someone commented they're working on it |
| Closed-without-merge history | -15 | Repo has rejected your PRs before (no merges) |

Score is clamped to 0-100. Issues are sorted by search priority (merged_pr > preferred_org > starred > normal), then recommendation, then score.

## Search Priorities

| Priority | Source | Why it matters |
|----------|--------|---------------|
| `merged_pr` | Repos where you have merged PRs | Highest merge probability — established relationship |
| `preferred_org` | Your configured preferred orgs | Explicit interest signal |
| `starred` | Your GitHub starred repos | Implicit interest — you know the project |
| `normal` | General search + maintained repos | Discovery — new opportunities |

## Configuration

Preferences are configured via the library API or CLI setup:

```typescript
scout.updatePreferences({
  languages: ['typescript', 'rust'],      // Programming language filter
  labels: ['good first issue', 'help wanted'], // Issue label filter
  scope: ['beginner', 'intermediate'],    // Difficulty tiers
  minStars: 100,                          // Minimum repo star count
  maxIssueAgeDays: 60,                    // Skip issues older than this
  includeDocIssues: false,                // Exclude doc-only issues
  minRepoScoreThreshold: 4,              // Skip repos scoring below this (1-10)
  excludeRepos: ['owner/repo'],           // Never search these repos
  aiPolicyBlocklist: ['matplotlib/matplotlib'], // Repos with anti-AI policies
  preferredOrgs: ['expressjs', 'vercel'], // Priority organizations
  projectCategories: ['devtools', 'web-frameworks'], // Topic-based filtering
});
```

## Architecture

```
@oss-scout/core
├── OssScout class          Public API, implements ScoutStateReader
├── IssueDiscovery          Multi-phase search orchestrator
├── IssueVetter             Parallel vetting pipeline
├── issue-eligibility       PR checks, claim detection, requirements analysis
├── issue-scoring           Viability scoring (pure functions)
├── issue-filtering         Spam detection, doc-only filtering, per-repo caps
├── search-phases           GitHub Search API helpers, caching, batching
├── search-budget           Rate limit tracking (30 req/min sliding window)
├── repo-health             Project health checks, CONTRIBUTING.md parsing
├── category-mapping        Project categories to GitHub topic mapping
├── http-cache              ETag response caching, in-flight deduplication
└── ScoutState (Zod)        Preferences, repo scores, PR history
```

Key design decisions:
- **No singletons in the public API** — `OssScout` accepts config via constructor injection
- **Two persistence modes** — `'provided'` for embedding in other tools, `'gist'` for standalone use (planned)
- **ScoutStateReader interface** — search engine programs against an interface, not a concrete state manager
- **Rate-limit-first design** — every search phase respects a shared budget tracker

## Prerequisites

- **Node.js 20+**
- **GitHub authentication** — either `gh auth login` (recommended) or set `GITHUB_TOKEN`

## License

MIT

## Related

- [OSS Autopilot](https://github.com/costajohnt/oss-autopilot) — full AI copilot for managing open source contributions (uses oss-scout for issue discovery)
