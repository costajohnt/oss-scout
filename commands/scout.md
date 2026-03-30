---
name: scout
description: "Search for open source issues — multi-strategy search with vetting and viability scoring"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, mcp__*
---

# OSS Scout — Issue Discovery

This command searches for open source contribution opportunities personalized to your history and preferences.

## Step 0: Ensure CLI is Built

```bash
if [ ! -f "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" ]; then
  if ! BUILD_LOG=$(cd "${CLAUDE_PLUGIN_ROOT}/packages/core" && npm install --silent 2>&1 && npm run bundle --silent 2>&1); then
    echo "BUILD_FAILED"; echo "$BUILD_LOG" | tail -5; exit 1
  fi
fi
```

**If output starts with `BUILD_FAILED`**: Tell the user the CLI build failed and show the error lines. Suggest: `cd ${CLAUDE_PLUGIN_ROOT}/packages/core && npm install && npm run bundle`. Common causes: missing Node.js 20+, stale `node_modules`.

## Step 1: Check Setup

```bash
GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN") node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --json 2>/dev/null
```

If setup is not complete, suggest running `/scout-setup` first. Continue anyway — the CLI works with auto-detected defaults.

## Step 2: Run Search

Run the multi-strategy search:

```bash
GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN") node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" search 10 --json
```

The CLI automatically:
- Loads user preferences from local state
- Applies multi-strategy search (starred repos, language-based, category-based)
- Scores issues by viability (0-100)
- Filters for active, available issues
- Returns structured, scored results

**Strategy selection:** Users can request a specific strategy:
```bash
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" search 10 --strategy starred --json
```

Available strategies: `merged`, `starred`, `broad`, `maintained`, `all` (default).

## Step 3: Present Results

Parse the JSON output and present results in a formatted list:

```markdown
## Issue Search Results

### Top Opportunities

#### 1. [owner/repo#123](https://github.com/owner/repo/issues/123) — Issue Title
**Score:** 85/100 | **Recommendation:** approve
**Why it's good:**
- [Reasons from the scoring breakdown]

**Quick start:**
> [Brief approach suggestion based on issue content]

---

#### 2. [owner/repo#456](https://github.com/owner/repo/issues/456) — Issue Title
**Score:** 72/100 | **Recommendation:** needs_review
...
```

**Key fields from JSON output:**
- `candidates[].viabilityScore` — Overall score (0-100)
- `candidates[].recommendation` — `approve`, `needs_review`, or `skip`
- `candidates[].issue` — Issue metadata (title, url, repo, number, labels)
- `candidates[].repoScore` — Repository health metrics
- `candidates[].reasonsToApprove` / `reasonsToSkip` — Scoring explanations

**If no results:** Suggest adjusting search preferences via `/scout-setup` or trying a different strategy.

## Step 4: Follow-Up Actions

After presenting results, offer:

1. **"Vet an issue"** — Deep-vet a specific issue for availability and project health:
   ```bash
   GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" vet https://github.com/owner/repo/issues/123 --json
   ```

2. **"Search again"** — Run another search with different parameters (more results, different strategy)

3. **"View saved results"** — Show previously saved search results:
   ```bash
   GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" results --json
   ```

4. **"Re-vet saved results"** — Check availability of all saved results:
   ```bash
   GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" vet-list --json
   ```

5. **"Done"** — End the search session

## Error Handling

**If the CLI command fails** (non-zero exit or error JSON):
1. Show the error to the user
2. Check common issues:
   - `GITHUB_TOKEN` not set → suggest `gh auth login`
   - Rate limited → suggest waiting or reducing result count
   - Setup incomplete → suggest `/scout-setup`
3. Offer to retry with adjusted parameters

**If the CLI bundle is missing**: Build it:
```bash
cd "${CLAUDE_PLUGIN_ROOT}/packages/core" && npm install && npm run bundle
```

## Rules

1. **Never post comments on issues** without explicit user approval
2. **Work-first approach** — the PR is the claim, not a comment
3. Present all results before asking for action
4. Keep responses concise — let the scores speak
5. If the user wants to work on an issue, help them clone/fork and start implementing
