# `scout features` — feature-opportunity search mode

**Issue:** #92
**Status:** approved design, ready for implementation plan
**Date:** 2026-05-08

## Problem

Today's `scout` optimizes for low-friction merges: small bugs, good-first-issue labels, fast review cycles. That objective function biases discovery toward maintenance work. A different objective function would surface bigger contribution opportunities — features rather than fixes — anchored on repos where the user has demonstrated relationships through merged PRs.

`scout features` adds a complementary search mode that uses different signals to surface feature-scoped contribution opportunities, restricted to repos where the user has earned trust.

## Design decisions (locked during brainstorm)

| Decision | Value |
|---|---|
| Audience | Relationship-anchored only. No broad cross-repo discovery in v1. |
| Time horizon | Both quick wins and bigger bets, ranked separately into two buckets. |
| Surface | New `scout features [count]` subcommand sharing core discovery pipeline with `scout search`. |
| v1 signals | Labels, reactions, comment count, milestone presence. Project boards / ROADMAP.md / wontfix-no-contributor deferred to v2. |
| Anchor threshold | 3+ merged PRs into a repo. Hardcoded for v1; configurable in a follow-up. |
| Horizon classifier | Bigger bet if issue has a milestone OR carries `roadmap` / `accepted-rfc` / `proposal` labels. Otherwise quick win. |
| Linked-PR handling | Same -30 penalty as `scout`. Stalled-PR revival mode is a future follow-up. |

## Architecture

### New CLI command

`scout features [count]` — sibling to `scout search`. Default count: 10. Same global flags (`--json`, `--strategy` not applicable).

### New core module

`packages/core/src/core/feature-discovery.ts` — orchestrator that:

1. Resolves anchor repos from `ScoutState.repoScores` (filter `mergedPRCount >= 3`).
2. Builds a `FeatureSearchConfig` with feature-flavored signals (label set, scoring adjustments, horizon classifier).
3. Calls existing `IssueVetter` per anchor repo to fetch and vet issues with the feature filter applied.
4. Classifies each surviving issue into `quick-win` or `bigger-bet`.
5. Returns `FeatureSearchResult` with both buckets, anchor list, and an optional empty-state message.

### Reused modules

- `IssueVetter` (existing) for per-issue PR existence, claim detection, requirements check, scoring.
- `issue-scoring.ts` viability score (existing weights, including -30 for existing PR).
- `http-cache.ts`, `search-budget.ts`, `github.ts` — cache, rate limit, throttled client.
- `errors.ts` (`getHttpStatusCode`, `isRateLimitError`) — auth and rate-limit propagation policy.

### New files

- `packages/core/src/core/feature-discovery.ts`
- `packages/core/src/core/feature-discovery.test.ts`
- `packages/core/src/commands/features.ts`
- `packages/core/src/commands/features.test.ts`

### Modified files

- `packages/core/src/cli.ts` — register `features` command (mirror of `search`).
- `packages/core/src/scout.ts` — expose `OssScout.features()` API method paralleling `OssScout.search()`.
- `packages/core/src/index.ts` — export `FeatureSearchResult`, `FeatureCandidate` types.
- `packages/core/src/core/schemas.ts` — extend `SavedCandidate` with optional `horizon: "quick-win" | "bigger-bet"`.
- `packages/core/src/core/issue-scoring.ts` — extend `calculateViabilityScore` with optional `featureSignals` parameter.
- `packages/mcp-server/src/tools.ts` — register `scout-features` MCP tool paralleling `search`.
- `packages/mcp-server/src/tools.test.ts` — registration test for the new tool.

### Schema delta

```ts
// schemas.ts
export const HorizonSchema = z.enum(["quick-win", "bigger-bet"]);

export const SavedCandidateSchema = z.object({
  // ... existing fields ...
  horizon: HorizonSchema.optional(),
});
```

`horizon` is optional so existing `scout search` results validate unchanged. Feature-mode results always set it.

## Data flow

```
scout features [count]
  │
  ▼
commands/features.ts
  • Validate count (1-50, like search)
  • Load ScoutState (gist or local, via existing store)
  • Call OssScout.features({ count, json })
  │
  ▼
scout.ts → OssScout.features()
  • Build context: prefs, octokit, stateReader
  • Delegate to feature-discovery.ts
  │
  ▼
feature-discovery.ts → discoverFeatures(ctx, count)
  │
  ├─ 1. Resolve anchors
  │    repoScores.filter(rs => rs.mergedPRCount >= 3) → anchorRepos[]
  │    if empty → return no-anchors result with explanatory message
  │
  ├─ 2. Build FeatureSearchConfig
  │    • labelSet: ["enhancement","feature","proposal","roadmap","accepted-rfc"]
  │    • requiredLabelMatch: any-of
  │    • exclusionLabels: ["good first issue","bug","documentation"]
  │    • horizonClassifier
  │    • feature scoring adjustments
  │
  ├─ 3. Per-anchor-repo search (sequential, throttled by search-budget)
  │    Reuse existing `fetchIssuesFromKnownRepos` helper from
  │    `search-phases.ts` with the feature label set and exclusions.
  │    → IssueCandidate[]
  │
  ├─ 4. Vet each candidate (existing IssueVetter)
  │    • PR existence check, claim detection, requirements, spam filter, viability score
  │
  ├─ 5. Filter + classify
  │    • Drop where viabilityScore < 40
  │    • Tag each survivor with horizon
  │    • Group into quickWins[] + biggerBets[]
  │
  ├─ 6. Sort within each bucket by score desc, take top N proportionally
  │    Target split: 60% quick wins, 40% bigger bets, rounded to integers,
  │    sum equals `count`.
  │    • count=10 → 6 quick + 4 bigger
  │    • count=5  → 3 + 2
  │    Underfill rule: if either bucket has fewer than its target after
  │    sort, redirect the deficit to the other bucket up to total `count`.
  │    Example: target 6+4, but only 2 bigger bets exist → return 6 quick + 2 bigger
  │    if quick has only 6; otherwise fill to 8 quick + 2 bigger.
  │
  ├─ 7. Persist into state.searchResults with horizon stamped on each
  │
  └─ Return FeatureSearchResult
```

### Empty-state messages

| State | Detection | Message |
|---|---|---|
| no-anchors | `anchorRepos.length === 0` | "No anchor repos yet (need 3+ merged PRs in a repo). Try `scout search` to build relationships first." |
| no-results | anchors exist, but `quickWins.length + biggerBets.length === 0` | "No open feature opportunities in your anchor repos right now. Check back next week, or try `scout search` for fix-mode work." |
| success | results exist | (no message; output is the results) |

## Scoring weights

Feature mode reuses `calculateViabilityScore` with an optional `featureSignals` parameter that adds zero when absent. Existing `scout search` ignores it; feature mode populates it. One scoring function, no `if (mode === ...)` checks.

| Signal | `scout search` | `scout features` | Source |
|---|---|---|---|
| Reaction bonus | not used | `+min(reactions / 2, 10)` | `featureSignals.reactions` |
| Comment-depth bonus | not used | `+5` if `comments >= 5` | `featureSignals.comments` |
| Milestone bonus | not used | `+5` if `hasMilestone` | `featureSignals.hasMilestone` |
| Org affinity | `+5` | `+5` | existing |
| Repo merged-PR bonus | `+15` | `+15` | existing |
| Existing-PR penalty | `-30` | `-30` | existing |
| Repo-quality bonus | up to `+12` | up to `+12` | existing |
| Freshness | up to `+15` | up to `+15` | existing |

Score range stays 0-100. A strong feature opportunity (anchor repo, recent activity, no PR, milestone, 10+ reactions) lands ~85-95.

## Output

### Terminal (default)

```
🎯 Feature opportunities in your anchor repos (5 quick wins + 3 bigger bets)

Anchor repos: foo/bar (5 merged), baz/qux (4 merged), abc/xyz (3 merged)

── Quick wins ─────────────────────────────────────────
  1. [foo/bar] Add JSON output to `bar list`        Score 87
     https://github.com/foo/bar/issues/123
     Labels: enhancement
     Updated 4d ago · 12 reactions · 7 comments

── Bigger bets ────────────────────────────────────────
  1. [baz/qux] Pluggable transport layer            Score 82
     https://github.com/baz/qux/issues/456
     Labels: roadmap, proposal · Milestone: v2.0
     Updated 11d ago · 38 reactions · 24 comments
```

### JSON (`--json`)

```json
{
  "success": true,
  "data": {
    "quickWins": [SavedCandidate, ...],
    "biggerBets": [SavedCandidate, ...],
    "anchorRepos": ["foo/bar", "baz/qux", "abc/xyz"],
    "message": null
  },
  "timestamp": "2026-05-08T..."
}
```

Empty-state JSON:

```json
{
  "success": true,
  "data": {
    "quickWins": [],
    "biggerBets": [],
    "anchorRepos": [],
    "message": "No anchor repos yet (need 3+ merged PRs). Try `scout search` to build relationships first."
  },
  "timestamp": "..."
}
```

`success: true` on empty: empty is not an error, it's "no results in this objective function." Matches existing `scout search` convention.

## Error handling

Same strategy as the rest of the codebase (per `errors.ts` documentation):

- Auth errors (401) and rate-limit errors propagate unchanged via `getHttpStatusCode` + `isRateLimitError`.
- Cache and filesystem errors degrade gracefully with `warn` logging.
- No new error types introduced.

The `feature-discovery.ts` orchestrator wraps per-anchor-repo search calls in the same try/catch pattern used in `issue-discovery.ts`, re-raising auth and rate-limit errors and continuing past other failures.

## Testing strategy

| Test | Module | Purpose |
|---|---|---|
| anchor resolution | `feature-discovery.test.ts` | Filter `repoScores` by threshold, returns expected anchors. |
| empty-anchors path | `feature-discovery.test.ts` | Returns no-anchors message, makes no API calls. |
| label filter | `feature-discovery.test.ts` | Issues without feature labels get filtered out. |
| horizon classifier | `feature-discovery.test.ts` | Pure function, table-driven: milestone or `roadmap`/`accepted-rfc`/`proposal` label → bigger-bet, otherwise quick-win. |
| scoring with feature signals | `issue-scoring.test.ts` | Reaction, comment, milestone bonuses applied when `featureSignals` present; ignored otherwise. |
| 60/40 split | `feature-discovery.test.ts` | count=10 returns 6 quick + 4 bigger when both abundant; degrades gracefully when one bucket empty. |
| persistence | `feature-discovery.test.ts` | Results saved with `horizon` field; `scout results` displays them. |
| CLI integration | `commands/features.test.ts` | Argument validation, JSON envelope, exit codes match `search` conventions. |
| MCP tool registration | `mcp-server/src/tools.test.ts` | `scout-features` tool registered, schema validates. |
| Auth/rate-limit propagation | `feature-discovery.test.ts` | 401 and rate-limit errors from search and vet bubble up unchanged. |

All tests use Vitest and the existing `mockOctokit` helpers.

## Out of scope for v1

Tracked as follow-up issues at the end of implementation:

- Project-board and `ROADMAP.md` scraping (richer maintainer-commitment signal).
- "Wontfix because no contributor" detection.
- Stalled-PR revival mode (surface issues with linked PRs that have been inactive >30 days).
- Configurable anchor threshold (`featuresAnchorThreshold` preference).
- Configurable quick-wins / bigger-bets split ratio.
- Cross-repo / first-touch broad mode (audience expansion).

## Acceptance criteria

- [x] Design approved section by section during brainstorm
- [ ] `scout features` command available, default count 10, accepts 1-50 range
- [ ] Anchor resolution uses `mergedPRCount >= 3`
- [ ] Results split into `quickWins` and `biggerBets` with horizon classifier described above
- [ ] JSON output matches `{ success, data: { quickWins, biggerBets, anchorRepos, message }, timestamp }` shape
- [ ] Empty states emit explanatory message, `success: true`
- [ ] Existing `scout search` behavior unchanged
- [ ] `SavedCandidate.horizon` is optional in schema; existing saved results validate unchanged
- [ ] Auth and rate-limit errors propagate (per project policy)
- [ ] Test coverage for anchor resolution, horizon classifier, 60/40 split, persistence, CLI, MCP, error propagation
- [ ] MCP `scout-features` tool exposed
- [ ] Follow-up issues filed for the out-of-scope items above
