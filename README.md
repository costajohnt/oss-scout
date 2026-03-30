<p align="center">
  <img src="assets/icon.svg" alt="oss-scout" width="120">
</p>

<h1 align="center">oss-scout</h1>

<p align="center">
  Find open source issues personalized to <em>your</em> contribution history
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oss-scout/core"><img src="https://img.shields.io/npm/v/@oss-scout/core" alt="npm"></a>
  <img src="https://img.shields.io/npm/dm/@oss-scout/core" alt="downloads">
  <img src="https://github.com/costajohnt/oss-scout/actions/workflows/ci.yml/badge.svg" alt="CI">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node 20+">
  <img src="https://img.shields.io/badge/Claude_Code-Plugin-blueviolet" alt="Claude Code Plugin">
</p>

Most issue finders search GitHub for `good first issue` labels and hand you a list. You could do that yourself in 30 seconds.

**oss-scout is different.** It knows which repos you've contributed to, which maintainers have merged your work before, and which projects are actually responsive. It searches strategically, vets every result, and tells you where your next PR has the highest chance of getting merged.

## Getting Started

### Prerequisites

- **Node.js 20+**
- **GitHub CLI** — `gh auth login` ([install](https://cli.github.com/)) or set `GITHUB_TOKEN` env var

### Install

```bash
npx @oss-scout/core setup    # configure (no install needed)
npx @oss-scout/core search   # find issues
```

Or install globally: `npm install -g @oss-scout/core`

### First run

**1. Configure your preferences:**

```
$ oss-scout setup

🔧 oss-scout setup

Detecting GitHub username...
GitHub username [yourname]:
Preferred languages (or "any" for all) [any]: typescript, rust
Issue labels to search for [good first issue, help wanted]:
Difficulty scope (beginner, intermediate, advanced) [all]: beginner, intermediate
Minimum repo stars [50]: 100
Project categories (nonprofit, devtools, infrastructure, web-frameworks, data-ml, education) [none]: devtools
Repos to exclude (owner/repo, comma-separated, optional):

✅ Setup complete! Preferences saved.
```

**2. Import your GitHub history** (so the tool knows where you've contributed before):

```
$ oss-scout bootstrap

Imported 23 merged PRs, 4 closed PRs, 142 starred repos
Scored 8 repositories
```

**3. Search for issues:**

```
$ oss-scout search

Found 8 issue candidates:

  ✅ owner/repo#123 [92/100]
     Add timeout option to res.download()
     https://github.com/owner/repo/issues/123
     Repo: 9/10, 2 merged PRs

  ✅ org/project#456 [85/100]
     Support NO_COLOR in browser builds
     https://github.com/org/project/issues/456
     Repo: 8/10, 1 merged PRs

  ⚠️ user/library#789 [78/100]
     Add encoding option to execaNode
     https://github.com/user/library/issues/789
```

Results are automatically saved. View them later with `oss-scout results`.

## How Search Works

oss-scout runs four search strategies in priority order:

| Strategy | Flag | What it searches | Why it matters |
|----------|------|-----------------|----------------|
| `merged` | Phase 0 | Repos where you have merged PRs | Highest merge probability |
| `starred` | Phase 1 | Your GitHub starred repos | Implicit interest |
| `broad` | Phase 2 | General label/language filtered | Discovery |
| `maintained` | Phase 3 | Actively maintained repos by topic | Exploration |

Run all strategies (default), or pick specific ones:

```bash
oss-scout search --strategy merged           # only repos you've contributed to
oss-scout search --strategy starred,broad     # starred repos + general discovery
oss-scout search --strategy all               # all strategies (default)
```

Heavy strategies (broad, maintained) are automatically skipped when your GitHub API quota is low.

## Why Not Just Search GitHub?

| Feature | Label search | oss-scout |
|---------|-------------|-----------|
| Personalized to your history | No | Yes — prioritizes repos you've contributed to |
| Checks if issue is claimed | No | Yes — scans comments for claim phrases |
| Checks for existing PRs | No | Yes — uses timeline API |
| Project health check | No | Yes — commit recency, stars, CONTRIBUTING.md |
| Viability scoring | No | Yes — 0-100 with transparent factors |
| Rate limit aware | No | Yes — adaptive budget, never wastes quota |
| Spam detection | No | Yes — filters label farming, templated titles |

## Vetting

Every issue candidate goes through 6 parallel checks:

| Check | What it detects | Method |
|-------|----------------|--------|
| Existing PRs | Someone already submitted a fix | Timeline API |
| Claimed | "I'm working on this" in comments | Comment text scanning |
| Project health | Is the repo active and maintained? | Commit history, stars, forks |
| Clear requirements | Can you actually implement this? | Body analysis (steps, code blocks) |
| Contribution guidelines | Branch naming, test framework, CLA | CONTRIBUTING.md probing |
| Your merge history | Have your PRs been merged here before? | Search API (cached) |

**Vet a specific issue:**

```
$ oss-scout vet https://github.com/owner/repo/issues/123

✅ owner/repo#123: APPROVE
   Add timeout option to res.download()

Reasons to approve:
  + Trusted project (2 PRs merged)
  + Clear requirements
  + Contribution guidelines found

Project health: Active
  Last commit: 2 days ago
```

**Re-vet all saved results** to check for staleness:

```
$ oss-scout vet-list --prune

  ✅ owner/repo#123 — still_available [92/100]
  🔒 user/library#789 — claimed [78/100]
  🔀 org/project#456 — has_pr [85/100]

Summary: 5 available, 1 claimed, 1 has PR, 1 closed
Pruned 3 unavailable issues from saved results.
```

## Saved Results

Search results are automatically saved to `~/.oss-scout/state.json` after each search. Results deduplicate across runs — if the same issue appears again, scores are updated but the first-seen date is preserved.

```bash
oss-scout results             # view saved results
oss-scout results --json      # structured JSON output
oss-scout results clear       # wipe saved results
oss-scout vet-list --prune    # re-vet and remove stale issues
```

### Cross-machine sync with gist persistence

Enable gist persistence to sync your state (preferences, repo scores, PR history, saved results) across machines via a private GitHub gist:

```bash
oss-scout config set persistence gist
```

Your GitHub token needs the `gist` scope: `gh auth refresh -s gist`

State is automatically pushed to the gist after each search, vet-list, or bootstrap. When you run oss-scout on a different machine, it finds the gist and pulls the latest state.

## Configuration

### Interactive setup

```bash
oss-scout setup    # first-run interactive configuration
```

### View and update individual settings

```bash
oss-scout config                                    # show all preferences
oss-scout config --json                             # JSON output
oss-scout config set languages "typescript,rust"    # set languages
oss-scout config set minStars 100                   # minimum repo stars
oss-scout config set includeDocIssues false          # exclude doc-only issues
oss-scout config set excludeRepos "+spam/repo"       # append to exclude list
oss-scout config set excludeRepos "-spam/repo"       # remove from exclude list
oss-scout config reset                               # reset to defaults
```

### All configuration options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `languages` | string[] | any (all languages) | Programming language filter (use "any" for no filter) |
| `labels` | string[] | good first issue, help wanted | Issue label filter |
| `scope` | enum[] | all | Difficulty: beginner, intermediate, advanced |
| `minStars` | number | 50 | Minimum repo star count |
| `maxIssueAgeDays` | number | 90 | Skip issues older than this |
| `includeDocIssues` | boolean | true | Include documentation-only issues |
| `minRepoScoreThreshold` | number | 4 | Skip repos scoring below this (1-10) |
| `excludeRepos` | string[] | [] | Repos to never search |
| `aiPolicyBlocklist` | string[] | matplotlib/matplotlib | Repos with anti-AI policies |
| `projectCategories` | enum[] | [] | Topic filter: devtools, web-frameworks, etc. |
| `persistence` | enum | local | State storage: local or gist |

## Install Options

### CLI (recommended for individual use)

```bash
npm install -g @oss-scout/core
oss-scout setup
oss-scout bootstrap
oss-scout search
```

### Claude Code Plugin

```
/plugin marketplace add costajohnt/oss-scout
/plugin install oss-scout@oss-scout
```

Restart Claude Code. Commands:
- `/scout` — Multi-strategy issue search with interactive results
- `/scout-setup` — Configure preferences

Agents (dispatched automatically by Claude):
- **issue-scout** — Autonomous issue discovery and vetting
- **repo-evaluator** — Repository health assessment before contributing

### MCP Server (Cursor, Claude Desktop, Codex, Windsurf)

```json
{
  "mcpServers": {
    "oss-scout": {
      "command": "npx",
      "args": ["@oss-scout/mcp@latest"]
    }
  }
}
```

**Tools:** search, vet, config, config-set
**Resources:** scout://config, scout://results, scout://scores

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
}
```

Two persistence modes:
- **`'provided'`** — caller manages state (for embedding in other tools)
- **`'gist'`** — oss-scout manages state via private GitHub gist

```typescript
// Host application provides state
const scout = await createScout({
  githubToken: token,
  persistence: 'provided',
  initialState: existingState,
});

// Record PR outcomes to improve future search quality
scout.recordMergedPR({ url, title, mergedAt, repo });
scout.recordClosedPR({ url, title, closedAt, repo });
await scout.checkpoint(); // push to gist
```

## Viability Scoring (0-100)

| Factor | Points | Condition |
|--------|--------|-----------|
| Base | 50 | Always |
| Repo score | +0 to +20 | From 1-10 repo quality rating |
| Repo quality bonus | +0 to +12 | Stars and forks tiers |
| Merged PRs in repo | +15 | You've had PRs merged here |
| Clear requirements | +15 | Issue body has steps, code blocks, keywords |
| Fresh issue | +0 to +15 | Updated within 14 days (full), 15-30 days (partial) |
| Contribution guidelines | +10 | CONTRIBUTING.md found and parsed |
| Org affinity | +5 | Merged PRs in other repos under same org |
| Category match | +5 | Matches your preferred project categories |
| Existing PR | -30 | Someone already submitted a fix |
| Claimed | -20 | Someone commented they're working on it |
| Closed-without-merge history | -15 | Repo has rejected your PRs before (no merges) |

Score is clamped to 0-100. Results sorted by: search priority > recommendation > score.

## CLI Reference

```
oss-scout [--debug] [--json] <command>

Setup:
  setup                         Interactive first-run configuration
  bootstrap                     Import starred repos and PR history from GitHub

Search:
  search [count]                Search for issues (default: 10)
    --strategy <s>              Strategies: merged,starred,broad,maintained,all
  vet <issue-url>               Vet a specific issue
  vet-list                      Re-vet all saved results
    --prune                     Remove unavailable issues
    --concurrency <n>           Max parallel API requests (default: 5)

Results:
  results                       Show saved search results
  results clear                 Clear saved results

Config:
  config                        Show current preferences
  config set <key> <value>      Update a preference
  config reset                  Reset to defaults

Global:
  --debug                       Debug logging
  --json                        Structured JSON output
  --version                     Show version
```

## Spam Detection

Automatically filtered out:
- **Label farming** — repos with 5+ beginner labels per issue
- **Templated titles** — mass-created issues ("Add Question #42", "Add Question #43")
- **Anti-AI policies** — repos in the `aiPolicyBlocklist` (configurable)

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
├── gist-state-store        Gist-backed persistence with conflict resolution
└── ScoutState (Zod)        Preferences, repo scores, PR history, saved results
```

## License

MIT

## Related

- [OSS Autopilot](https://github.com/costajohnt/oss-autopilot) — full AI copilot for managing open source contributions (uses oss-scout for issue discovery)
