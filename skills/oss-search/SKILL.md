---
name: OSS Issue Search Best Practices
description: This skill should be used when searching for open source issues, vetting contributions, interpreting viability scores, or planning a search strategy. Covers multi-strategy search, vetting workflow, and score interpretation.
version: 1.0.0
---

# OSS Issue Search Best Practices

## Multi-Strategy Search

OSS Scout uses three search strategies to find contribution opportunities. Each strategy targets a different source of issues.

### Strategy 1: Starred Repos

Searches repositories the user has starred on GitHub.

**When to use:**
- User has curated their GitHub stars as a list of interesting projects
- Looking for issues in familiar, trusted repositories
- Best for users with 20+ starred repos in their target languages

**Strengths:** High-confidence results, repos the user already knows and likes.
**Weaknesses:** Limited pool, may not surface new projects.

### Strategy 2: Language-Based

Searches GitHub for issues matching the user's preferred programming languages and labels.

**When to use:**
- User wants to discover new repos in their language ecosystem
- Broadest search — good for finding volume of opportunities
- Default strategy for new users who haven't starred many repos

**Strengths:** Large result pool, discovers new projects.
**Weaknesses:** Less personalized, may include repos the user wouldn't enjoy.

### Strategy 3: Category-Based

Searches by project categories (devtools, infrastructure, web frameworks, data/ML, etc.) mapped to GitHub topics.

**When to use:**
- User has specific interests beyond just language
- Looking for mission-aligned contributions (e.g., nonprofit, education)
- Complements language-based search with domain filtering

**Strengths:** Domain-targeted, finds niche projects.
**Weaknesses:** Depends on repos using GitHub topics correctly.

### Using Multiple Strategies

The `all` strategy (default) runs all three in sequence:
1. Starred repos first (highest confidence)
2. Language-based (broad discovery)
3. Category-based (domain-targeted)

Results are deduplicated and merged by viability score.

## Viability Scoring (0-100)

Each issue is scored on multiple dimensions:

### Issue Quality (0-40 points)
- **Clarity** (0-15): Are requirements specific and actionable?
- **Scope** (0-15): Is the issue appropriately sized (not too big/small)?
- **Labels** (0-10): Has relevant labels (good first issue, help wanted, etc.)

### Availability (0-30 points)
- **Not assigned** (0-10): No one claimed this issue
- **No linked PRs** (0-10): No active PRs attempting to solve it
- **Recently active** (0-10): Issue has recent engagement, maintainers are responsive

### Repository Health (0-30 points)
- **Active development** (0-10): Recent commits and releases
- **Responsive maintainers** (0-10): PRs get reviewed in reasonable time
- **Contributor-friendly** (0-10): Has CONTRIBUTING.md, templates, welcoming tone

### Interpreting Scores

| Score Range | Meaning | Action |
|-------------|---------|--------|
| 80-100 | Excellent opportunity | Highly recommended — start working |
| 60-79 | Good opportunity | Worth pursuing, minor concerns |
| 40-59 | Moderate opportunity | Proceed with caution, vet further |
| 20-39 | Risky opportunity | Significant concerns, investigate first |
| 0-19 | Poor opportunity | Likely skip unless you have special interest |

### Recommendation Mapping

- **approve** (score >= 60): Issue looks good, proceed
- **review** (score 40-59): Worth looking at, but vet more carefully
- **skip** (score < 40): Not recommended, significant issues found

## Vetting Workflow

The recommended workflow for finding and claiming issues:

### 1. Search

Run a broad search to discover candidates:
```
/scout
```
Or use the CLI directly for specific strategies.

### 2. Review Results

Look at the top-scored issues. Pay attention to:
- Viability score and recommendation
- Repository health metrics
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

1. **Start with starred repos** — Issues in repos you know are easier to contribute to
2. **Look for "good first issue" labels** — These are specifically marked for newcomers
3. **Check repo activity** — A repo with recent commits is more likely to review your PR
4. **Read CONTRIBUTING.md** — Some repos have specific requirements (CLA, tests, etc.)
5. **Avoid repos with many stale PRs** — Indicates slow or unresponsive maintainers
6. **Use category search for mission-driven work** — Find projects aligned with your values
7. **Re-vet saved results regularly** — Issues get claimed quickly; check availability before starting

## Common Pitfalls

- **Don't spray-and-pray** — Focus on 1-2 issues at a time, quality over quantity
- **Don't ignore repo health** — A perfect issue in a dead repo is a wasted effort
- **Don't skip the vet step** — An issue that looks easy might already be claimed
- **Don't start with huge issues** — Begin with small, well-scoped contributions
- **Don't contribute to repos with anti-AI policies** — Check contribution guidelines first
