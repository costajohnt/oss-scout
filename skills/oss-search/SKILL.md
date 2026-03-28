---
name: OSS Issue Search Best Practices
description: This skill should be used when searching for open source issues, vetting contributions, interpreting viability scores, or planning a search strategy. Covers multi-strategy search, vetting workflow, and score interpretation.
version: 1.1.0
---

# OSS Issue Search Best Practices

## Multi-Strategy Search

OSS Scout uses five search strategies, run as phases in priority order. Each targets a different source of issues. Use `--strategy` to select specific strategies or `all` (default) to run them all.

### Strategy: `merged` (Phase 0)

Searches repos where you have previously had PRs merged.

**When to use:** Always — this is the highest-value strategy. Repos where you have an established relationship have the highest merge probability.

**Strengths:** Highest merge probability, established trust with maintainers.
**Weaknesses:** Only works if you have prior contribution history.

### Strategy: `orgs` (Phase 0.5)

Searches your preferred organizations (configured via `oss-scout config set preferredOrgs`).

**When to use:** When you have specific orgs you want to contribute to.

**Strengths:** Targeted to orgs you care about.
**Weaknesses:** Requires explicit configuration.

### Strategy: `starred` (Phase 1)

Searches repos you have starred on GitHub.

**When to use:** When you have curated your GitHub stars as a list of interesting projects. Best for users with 20+ starred repos in their target languages.

**Strengths:** High-confidence results, repos you already know and like.
**Weaknesses:** Limited pool, may not surface new projects.

### Strategy: `broad` (Phase 2)

General search filtered by your preferred languages, labels, and difficulty scope.

**When to use:** For discovering new repos. Broadest search — good for finding volume of opportunities. Default for new users who haven't built contribution history yet.

**Strengths:** Large result pool, discovers new projects.
**Weaknesses:** Less personalized, may include repos you wouldn't enjoy.

### Strategy: `maintained` (Phase 3)

Searches actively maintained repos filtered by project categories (devtools, web-frameworks, etc.) mapped to GitHub topics.

**When to use:** When you have specific domain interests beyond just language. Looking for mission-aligned contributions (e.g., nonprofit, education).

**Strengths:** Domain-targeted, finds niche projects.
**Weaknesses:** Depends on repos using GitHub topics correctly.

### Using Strategies

```bash
# Run all strategies (default)
oss-scout search

# Run a single strategy
oss-scout search --strategy starred

# Combine specific strategies
oss-scout search --strategy merged,starred

# Set a default strategy in config
oss-scout config set defaultStrategy "merged,starred"
```

The `all` strategy runs phases in order: merged (0) -> orgs (0.5) -> starred (1) -> broad (2) -> maintained (3). Results are deduplicated and sorted by priority, then recommendation, then score. Rate-limit-aware: heavy phases (broad, maintained) are skipped when API budget is low.

## Viability Scoring (0-100)

Each issue is scored using a base-50 additive/subtractive model. The raw score is clamped to 0-100.

### Score Components

| Factor | Points | Condition |
|--------|--------|-----------|
| Base | 50 | Always |
| Repo score | +0 to +20 | From 1-10 repo quality rating (score * 2) |
| Repo quality bonus | +0 to +12 | Based on star/fork tiers |
| Merged PRs in repo | +15 | You've had PRs merged here before |
| Clear requirements | +15 | Issue body has steps, code blocks, keywords |
| Fresh issue | +0 to +15 | Updated within 14 days (full), 15-30 days (partial) |
| Contribution guidelines | +10 | CONTRIBUTING.md found and parsed |
| Org affinity | +5 | Merged PRs in other repos under same org |
| Category match | +5 | Matches your preferred project categories |
| Existing PR | -30 | Someone already submitted a fix |
| Claimed | -20 | Someone commented they're working on it |
| Closed-without-merge history | -15 | Repo has rejected your PRs before (no merges) |

### Interpreting Scores

| Score Range | Meaning | Action |
|-------------|---------|--------|
| 80-100 | Excellent opportunity | Highly recommended — start working |
| 60-79 | Good opportunity | Worth pursuing, minor concerns |
| 40-59 | Moderate opportunity | Proceed with caution, vet further |
| 20-39 | Risky opportunity | Significant concerns, investigate first |
| 0-19 | Poor opportunity | Likely skip unless you have special interest |

### Recommendation Logic

Recommendations are based on vetting checks, not score thresholds:

- **approve**: All vetting checks passed (no existing PR, not claimed, project active, clear requirements)
- **needs_review**: Some checks inconclusive (e.g., API error during check) — worth looking at but verify manually
- **skip**: 2+ reasons to skip identified (existing PR, claimed, inactive project, etc.)

## Vetting Checks

Each issue is checked against 6 signals in parallel:

| Check | What it detects | Method |
|-------|----------------|--------|
| Existing PRs | Someone already submitted a fix | Timeline API |
| Claimed | "I'm working on this" in comments | Comment text scanning |
| Project health | Is the repo active and maintained? | Commit history, stars, forks |
| Clear requirements | Can you actually implement this? | Body analysis (steps, code blocks, keywords) |
| Contribution guidelines | Branch naming, test framework, CLA | CONTRIBUTING.md probing |
| Your merge history | Have your PRs been merged here before? | Search API (cached) |

## Vetting Workflow

### 1. Search

Run a search to discover candidates:
```
/scout
```
Or use the CLI directly for specific strategies.

### 2. Review Results

Look at the top-scored issues. Pay attention to:
- Viability score and recommendation
- Search priority (merged_pr > preferred_org > starred > normal)
- Reasons to approve vs. skip

### 3. Deep Vet

For promising issues, run a deep vet to check:
- Assignment status (is someone already working on it?)
- Linked PRs (has someone submitted a solution?)
- Project health (is the repo actively maintained?)
- Contribution guidelines (any special requirements?)

### 4. Start Working

Do NOT comment on the issue to "claim" it. Instead:
1. Fork/clone the repository
2. Implement the fix
3. Open a PR referencing the issue ("Fixes #123")

The PR is the claim. A comment saying "I'm working on this" is unnecessary noise.

### 5. When to Comment

Only comment on the issue when:
- You need clarification from the maintainer before starting
- The approach is ambiguous and needs confirmation
- The issue is old and you want to confirm it's still relevant

## Tips for Effective Searching

1. **Start with merged repos** — Issues in repos where you've contributed are easiest to land
2. **Star repos you're interested in** — This feeds the starred strategy over time
3. **Check repo activity** — A repo with recent commits is more likely to review your PR
4. **Read CONTRIBUTING.md** — Some repos have specific requirements (CLA, tests, etc.)
5. **Avoid repos with many stale PRs** — Indicates slow or unresponsive maintainers
6. **Use category search for mission-driven work** — Find projects aligned with your values
7. **Re-vet saved results regularly** — Issues get claimed quickly; run `oss-scout vet-list` before starting
