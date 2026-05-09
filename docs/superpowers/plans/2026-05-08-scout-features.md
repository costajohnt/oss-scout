# `scout features` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `scout features` subcommand that surfaces feature-scoped contribution opportunities in repos where the user has 3+ merged PRs, ranked into separate "quick wins" and "bigger bets" buckets.

**Architecture:** New CLI command + new core orchestrator (`feature-discovery.ts`) sharing the existing scoring, vetting, cache, and rate-limit infrastructure. Feature-mode signals (reactions, comments, milestone) plumb through `calculateViabilityScore` as an optional `featureSignals` parameter and through `IssueVetter.vetIssue` as an optional option. No `if (mode === ...)` checks anywhere — mode is expressed as data.

**Tech Stack:** TypeScript (strict mode, ESM, NodeNext), Vitest, Commander, Octokit, Zod, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-05-08-scout-features-design.md`

---

## File map

**Create:**
- `packages/core/src/core/feature-discovery.ts` — orchestrator + pure helpers (anchor resolver, horizon classifier, bucket splitter)
- `packages/core/src/core/feature-discovery.test.ts`
- `packages/core/src/commands/features.ts` — CLI command runner
- `packages/core/src/commands/features.test.ts`

**Modify:**
- `packages/core/src/core/schemas.ts` — add `HorizonSchema`, optional `horizon` on `SavedCandidate`
- `packages/core/src/core/issue-scoring.ts` — extend `calculateViabilityScore` with optional `featureSignals` param
- `packages/core/src/core/issue-scoring.test.ts` — add cases for feature signals
- `packages/core/src/core/issue-vetting.ts` — thread optional `featureSignals` through `vetIssue`
- `packages/core/src/scout.ts` — add `OssScout.features()` API
- `packages/core/src/cli.ts` — register `features` subcommand
- `packages/core/src/index.ts` — export `Horizon`, `FeatureSearchResult`, `FeatureSignals`
- `packages/mcp-server/src/tools.ts` — register `scout-features` tool
- `packages/mcp-server/src/tools.test.ts` — add tool registration test

---

## Branch & convention

Branch already exists: `feat/92-scout-features-design`. Use it for the implementation as well, or cut a new `feat/92-scout-features-impl` from main if you prefer to keep the spec PR separate. The plan below assumes the same branch (single PR for spec + impl); adjust if splitting.

---

### Task 1: Add `HorizonSchema` and optional `horizon` field on `SavedCandidate`

**Files:**
- Modify: `packages/core/src/core/schemas.ts`

Existing `SavedCandidateSchema` is at the lines defining `savedResults` storage shape. We need to add a new enum and extend the candidate schema. The change must be backwards-compatible (existing saved results in user gists must still validate).

- [ ] **Step 1: Read current schema location**

Run: `grep -n "SavedCandidateSchema" packages/core/src/core/schemas.ts`
Note the line range; plan to insert `HorizonSchema` immediately above it.

- [ ] **Step 2: Add `HorizonSchema` and field**

Edit `packages/core/src/core/schemas.ts`. Add immediately above `export const SavedCandidateSchema`:

```ts
export const HorizonSchema = z.enum(["quick-win", "bigger-bet"]);
```

Inside `SavedCandidateSchema = z.object({ ... })`, add `horizon: HorizonSchema.optional(),` as a new field (alongside the existing fields like `viabilityScore`, `searchPriority`).

At the bottom of the file with the other type exports, add:

```ts
export type Horizon = z.infer<typeof HorizonSchema>;
```

- [ ] **Step 3: Run schema tests**

Run: `pnpm --filter @oss-scout/core test schemas`
Expected: PASS. Existing tests cover `SavedCandidateSchema.parse({...})` without `horizon`; the optional field must not break them.

- [ ] **Step 4: Add test for new field**

`packages/core/src/core/schemas.test.ts` already exists. Append the two `describe` blocks below to it:

```ts
import { describe, it, expect } from "vitest";
import { SavedCandidateSchema, HorizonSchema } from "./schemas.js";

describe("HorizonSchema", () => {
  it("accepts quick-win and bigger-bet", () => {
    expect(HorizonSchema.parse("quick-win")).toBe("quick-win");
    expect(HorizonSchema.parse("bigger-bet")).toBe("bigger-bet");
  });
  it("rejects unknown values", () => {
    expect(() => HorizonSchema.parse("medium")).toThrow();
  });
});

describe("SavedCandidateSchema horizon field", () => {
  const base = {
    issueUrl: "https://github.com/foo/bar/issues/1",
    repo: "foo/bar",
    number: 1,
    title: "t",
    labels: [],
    recommendation: "approve" as const,
    viabilityScore: 80,
    searchPriority: "merged_pr" as const,
    firstSeenAt: "2026-05-08T00:00:00Z",
    lastSeenAt: "2026-05-08T00:00:00Z",
    lastScore: 80,
  };
  it("validates without horizon (backwards compat)", () => {
    expect(() => SavedCandidateSchema.parse(base)).not.toThrow();
  });
  it("validates with horizon set", () => {
    expect(() =>
      SavedCandidateSchema.parse({ ...base, horizon: "quick-win" }),
    ).not.toThrow();
  });
});
```

If `schemas.test.ts` already exists, append the two `describe` blocks to it.

- [ ] **Step 5: Run new tests**

Run: `pnpm --filter @oss-scout/core test schemas`
Expected: PASS, new tests included.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/core/schemas.ts packages/core/src/core/schemas.test.ts
git commit -m "feat(core): add Horizon schema + optional horizon field on SavedCandidate (#92)"
```

---

### Task 2: Extend `calculateViabilityScore` with optional `featureSignals`

**Files:**
- Modify: `packages/core/src/core/issue-scoring.ts`
- Modify: `packages/core/src/core/issue-scoring.test.ts`

The scoring function gains an optional input. When absent, behavior is identical to today. When present, applies +reactions/2 (capped at 10), +5 if comments >= 5, +5 if hasMilestone.

- [ ] **Step 1: Write failing tests for feature signals**

Append to `packages/core/src/core/issue-scoring.test.ts`:

```ts
describe("calculateViabilityScore feature signals", () => {
  const baseFeature: ViabilityScoreParams = {
    repoScore: null,
    hasExistingPR: false,
    isClaimed: false,
    clearRequirements: false,
    hasContributionGuidelines: false,
    issueUpdatedAt: new Date().toISOString(),
    closedWithoutMergeCount: 0,
    mergedPRCount: 0,
    orgHasMergedPRs: false,
  };
  it("adds nothing when featureSignals is absent", () => {
    const score = calculateViabilityScore(baseFeature);
    // base 50 + freshness 15 = 65
    expect(score).toBe(65);
  });
  it("adds reactions/2 capped at 10", () => {
    const score = calculateViabilityScore({
      ...baseFeature,
      featureSignals: { reactions: 4, comments: 0, hasMilestone: false },
    });
    expect(score).toBe(65 + 2); // 4/2 = 2
  });
  it("caps reactions bonus at 10", () => {
    const score = calculateViabilityScore({
      ...baseFeature,
      featureSignals: { reactions: 100, comments: 0, hasMilestone: false },
    });
    expect(score).toBe(65 + 10);
  });
  it("adds +5 when comments >= 5", () => {
    const score = calculateViabilityScore({
      ...baseFeature,
      featureSignals: { reactions: 0, comments: 5, hasMilestone: false },
    });
    expect(score).toBe(65 + 5);
  });
  it("adds nothing when comments < 5", () => {
    const score = calculateViabilityScore({
      ...baseFeature,
      featureSignals: { reactions: 0, comments: 4, hasMilestone: false },
    });
    expect(score).toBe(65);
  });
  it("adds +5 when hasMilestone is true", () => {
    const score = calculateViabilityScore({
      ...baseFeature,
      featureSignals: { reactions: 0, comments: 0, hasMilestone: true },
    });
    expect(score).toBe(65 + 5);
  });
  it("combines all feature bonuses", () => {
    const score = calculateViabilityScore({
      ...baseFeature,
      featureSignals: { reactions: 20, comments: 10, hasMilestone: true },
    });
    expect(score).toBe(65 + 10 + 5 + 5);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm --filter @oss-scout/core test issue-scoring`
Expected: FAIL with `Property 'featureSignals' does not exist on type 'ViabilityScoreParams'` or runtime errors.

- [ ] **Step 3: Implement feature signals in scoring**

Edit `packages/core/src/core/issue-scoring.ts`. Add to `ViabilityScoreParams` interface (after `matchesPreferredCategory?:`):

```ts
  /**
   * Optional feature-mode signals. When present, applies reaction (cap +10),
   * comment-depth (+5 if >=5), and milestone (+5) bonuses. When absent,
   * scoring behavior is unchanged.
   */
  featureSignals?: {
    reactions: number;
    comments: number;
    hasMilestone: boolean;
  };
```

Inside `calculateViabilityScore`, immediately before the final clamp (`return Math.max(0, Math.min(100, score));`), add:

```ts
  if (params.featureSignals) {
    const fs = params.featureSignals;
    score += Math.min(Math.floor(fs.reactions / 2), 10);
    if (fs.comments >= 5) score += 5;
    if (fs.hasMilestone) score += 5;
  }
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm --filter @oss-scout/core test issue-scoring`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/issue-scoring.ts packages/core/src/core/issue-scoring.test.ts
git commit -m "feat(core): add featureSignals to calculateViabilityScore (#92)"
```

---

### Task 3: Thread `featureSignals` through `IssueVetter.vetIssue`

**Files:**
- Modify: `packages/core/src/core/issue-vetting.ts`
- Modify: `packages/core/src/core/issue-vetting.test.ts`

`vetIssue(url)` becomes `vetIssue(url, opts?: { featureSignals?: FeatureSignals })`. The signals plumb directly into the `calculateViabilityScore` call inside vetter. The vetter does NOT extract signals from the fetched issue — the caller (feature-discovery) extracts them from the search-result item and passes them in. This keeps the vetter mode-agnostic.

- [ ] **Step 1: Read current `vetIssue` signature and scoring call**

Run: `grep -n "calculateViabilityScore\|async vetIssue" packages/core/src/core/issue-vetting.ts`
Note line numbers for the signature and the scoring call site.

- [ ] **Step 2: Write failing test**

Append to `packages/core/src/core/issue-vetting.test.ts`:

```ts
describe("IssueVetter feature signals", () => {
  it("plumbs featureSignals through to scoring", async () => {
    // Build a vetter mock that returns a fixed candidate URL with no PR/no claim,
    // so the only score difference comes from featureSignals.
    const baselineUrl = "https://github.com/foo/bar/issues/100";
    const { vetter, scoreOf } = buildVetterUnderTest(); // helper defined in this file
    const baseline = await vetter.vetIssue(baselineUrl);
    const boosted = await vetter.vetIssue(baselineUrl, {
      featureSignals: { reactions: 20, comments: 10, hasMilestone: true },
    });
    // 10 (reactions cap) + 5 (comments) + 5 (milestone) = 20
    expect(scoreOf(boosted)).toBe(scoreOf(baseline) + 20);
  });
});
```

If `buildVetterUnderTest` does not exist in the test file, write one matching the existing test patterns in this file. Otherwise reuse it. To match the project's test style, look at the existing top of the file:

Run: `head -60 packages/core/src/core/issue-vetting.test.ts`

Inline-copy the existing setup pattern (likely `vi.mock("./issue-eligibility")`, `vi.mock("./repo-health")`, etc.) and produce a vetter you can call twice on the same URL. Cache in vetter is 15 minutes — to avoid the cache returning the first result on the second call, clear it between calls. Use:

```ts
import { getHttpCache } from "./http-cache.js";
beforeEach(() => getHttpCache().clear());
```

- [ ] **Step 3: Run test, verify failure**

Run: `pnpm --filter @oss-scout/core test issue-vetting`
Expected: FAIL — vetIssue does not accept the second argument or signals do not affect score.

- [ ] **Step 4: Implement plumbing**

Edit `packages/core/src/core/issue-vetting.ts`. Add a type export at the top (near other type imports):

```ts
export type FeatureSignals = {
  reactions: number;
  comments: number;
  hasMilestone: boolean;
};
```

Change `vetIssue` signature from `async vetIssue(issueUrl: string): Promise<IssueCandidate>` to:

```ts
async vetIssue(
  issueUrl: string,
  opts?: { featureSignals?: FeatureSignals },
): Promise<IssueCandidate>
```

In the body, find the call to `calculateViabilityScore({...})` and add `featureSignals: opts?.featureSignals,` to the params object (alongside the existing fields like `repoScore`, `hasExistingPR`, etc.).

The vetting cache key currently is `vet:${issueUrl}`. Because feature signals affect the score, change it to include them:

```ts
const sigKey = opts?.featureSignals
  ? `:r${opts.featureSignals.reactions}c${opts.featureSignals.comments}m${opts.featureSignals.hasMilestone ? 1 : 0}`
  : "";
const cacheKey = `vet:${issueUrl}${sigKey}`;
```

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm --filter @oss-scout/core test issue-vetting`
Expected: PASS, including the new test.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/core/issue-vetting.ts packages/core/src/core/issue-vetting.test.ts
git commit -m "feat(core): thread featureSignals through IssueVetter.vetIssue (#92)"
```

---

### Task 4: Pure helper — `resolveAnchorRepos`

**Files:**
- Create: `packages/core/src/core/feature-discovery.ts`
- Create: `packages/core/src/core/feature-discovery.test.ts`

Pure function that filters `RepoScore[]` by `mergedPRCount >= threshold` and returns the repo full-names sorted by mergedPRCount desc.

- [ ] **Step 1: Write failing test**

Create `packages/core/src/core/feature-discovery.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { RepoScore } from "./schemas.js";
import { resolveAnchorRepos, ANCHOR_THRESHOLD } from "./feature-discovery.js";

const mkScore = (repo: string, mergedPRCount: number): RepoScore => ({
  repo,
  score: 5,
  mergedPRCount,
  closedWithoutMergeCount: 0,
  avgResponseDays: null,
  lastEvaluatedAt: "2026-05-08T00:00:00Z",
  signals: {
    hasActiveMaintainers: true,
    isResponsive: true,
    hasHostileComments: false,
  },
});

const mkScores = (...entries: Array<[string, number]>): Record<string, RepoScore> =>
  Object.fromEntries(entries.map(([repo, count]) => [repo, mkScore(repo, count)]));

describe("resolveAnchorRepos", () => {
  it("returns empty array when no scores meet threshold", () => {
    const out = resolveAnchorRepos(mkScores(["a/b", 1], ["c/d", 2]));
    expect(out).toEqual([]);
  });
  it("filters by ANCHOR_THRESHOLD (3)", () => {
    expect(ANCHOR_THRESHOLD).toBe(3);
    const out = resolveAnchorRepos(
      mkScores(["a/b", 2], ["c/d", 3], ["e/f", 5]),
    );
    expect(out).toEqual(["e/f", "c/d"]);
  });
  it("sorts by mergedPRCount desc", () => {
    const out = resolveAnchorRepos(
      mkScores(["a/b", 4], ["c/d", 10], ["e/f", 7]),
    );
    expect(out).toEqual(["c/d", "e/f", "a/b"]);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm --filter @oss-scout/core test feature-discovery`
Expected: FAIL with module not found.

- [ ] **Step 3: Create `feature-discovery.ts` with pure helper**

Create `packages/core/src/core/feature-discovery.ts`:

```ts
/**
 * Feature Discovery — orchestrates `scout features` mode: surfaces
 * feature-scoped contribution opportunities in repos where the user has
 * 3+ merged PRs, ranked into separate "quick wins" and "bigger bets" buckets.
 *
 * Reuses existing infrastructure:
 * - issue-vetting.ts    — per-issue vetting + scoring (with featureSignals)
 * - issue-scoring.ts    — viability score (existing weights + feature bonuses)
 * - http-cache.ts       — response cache
 * - errors.ts           — auth/rate-limit propagation
 *
 * No state singletons — anchor repos are resolved from RepoScore[] passed in.
 */

import type { RepoScore } from "./schemas.js";

/** Minimum merged-PR count for a repo to qualify as an anchor. */
export const ANCHOR_THRESHOLD = 3;

/**
 * Resolve anchor repos: those with mergedPRCount >= ANCHOR_THRESHOLD,
 * sorted by mergedPRCount descending. ScoutState stores repoScores as a
 * Record<string, RepoScore>, so we read its values.
 */
export function resolveAnchorRepos(
  repoScores: Record<string, RepoScore>,
): string[] {
  return Object.values(repoScores)
    .filter((rs) => rs.mergedPRCount >= ANCHOR_THRESHOLD)
    .sort((a, b) => b.mergedPRCount - a.mergedPRCount)
    .map((rs) => rs.repo);
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @oss-scout/core test feature-discovery`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/feature-discovery.ts packages/core/src/core/feature-discovery.test.ts
git commit -m "feat(core): add resolveAnchorRepos pure helper (#92)"
```

---

### Task 5: Pure helper — `classifyHorizon`

**Files:**
- Modify: `packages/core/src/core/feature-discovery.ts`
- Modify: `packages/core/src/core/feature-discovery.test.ts`

Pure function: bigger-bet if `hasMilestone` OR labels contain any of `roadmap`, `accepted-rfc`, `proposal`. Otherwise quick-win.

- [ ] **Step 1: Write failing test**

Append to `packages/core/src/core/feature-discovery.test.ts`:

```ts
import { classifyHorizon } from "./feature-discovery.js";

describe("classifyHorizon", () => {
  it("returns bigger-bet when issue has a milestone", () => {
    expect(classifyHorizon({ hasMilestone: true, labels: [] })).toBe(
      "bigger-bet",
    );
  });
  it("returns bigger-bet for roadmap label", () => {
    expect(
      classifyHorizon({ hasMilestone: false, labels: ["roadmap"] }),
    ).toBe("bigger-bet");
  });
  it("returns bigger-bet for accepted-rfc label", () => {
    expect(
      classifyHorizon({ hasMilestone: false, labels: ["accepted-rfc"] }),
    ).toBe("bigger-bet");
  });
  it("returns bigger-bet for proposal label", () => {
    expect(
      classifyHorizon({ hasMilestone: false, labels: ["proposal"] }),
    ).toBe("bigger-bet");
  });
  it("returns quick-win for plain enhancement label", () => {
    expect(
      classifyHorizon({ hasMilestone: false, labels: ["enhancement"] }),
    ).toBe("quick-win");
  });
  it("returns quick-win when no signals fire", () => {
    expect(classifyHorizon({ hasMilestone: false, labels: [] })).toBe(
      "quick-win",
    );
  });
  it("is case-insensitive on label matching", () => {
    expect(
      classifyHorizon({ hasMilestone: false, labels: ["Roadmap"] }),
    ).toBe("bigger-bet");
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm --filter @oss-scout/core test feature-discovery`
Expected: FAIL — `classifyHorizon` not exported.

- [ ] **Step 3: Implement `classifyHorizon`**

Append to `packages/core/src/core/feature-discovery.ts`:

```ts
import type { Horizon } from "./schemas.js";

/** Labels that promote an issue to the "bigger-bet" bucket. */
export const BIGGER_BET_LABELS = new Set(["roadmap", "accepted-rfc", "proposal"]);

/**
 * Classify an issue into "quick-win" or "bigger-bet" based on
 * maintainer-commitment signals (milestone presence + label set).
 */
export function classifyHorizon(input: {
  hasMilestone: boolean;
  labels: string[];
}): Horizon {
  if (input.hasMilestone) return "bigger-bet";
  for (const label of input.labels) {
    if (BIGGER_BET_LABELS.has(label.toLowerCase())) return "bigger-bet";
  }
  return "quick-win";
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @oss-scout/core test feature-discovery`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/feature-discovery.ts packages/core/src/core/feature-discovery.test.ts
git commit -m "feat(core): add classifyHorizon pure helper (#92)"
```

---

### Task 6: Pure helper — `splitByHorizon` (60/40 with underfill rule)

**Files:**
- Modify: `packages/core/src/core/feature-discovery.ts`
- Modify: `packages/core/src/core/feature-discovery.test.ts`

Takes scored candidates already classified into horizons, target `count`, and produces `{ quickWins, biggerBets }` honoring the 60/40 split with deficit-redirect.

- [ ] **Step 1: Write failing test**

Append to `packages/core/src/core/feature-discovery.test.ts`:

```ts
import { splitByHorizon } from "./feature-discovery.js";
import type { IssueCandidate } from "./types.js";

const mkCand = (
  url: string,
  score: number,
  horizon: "quick-win" | "bigger-bet",
): IssueCandidate & { horizon: "quick-win" | "bigger-bet" } =>
  ({
    issue: {
      url,
      repo: "x/y",
      number: 1,
      title: url,
      labels: [],
      updatedAt: "2026-05-08",
    },
    vettingResult: {} as never,
    projectHealth: {} as never,
    antiLLMPolicy: {} as never,
    slmTriage: null,
    recommendation: "approve",
    reasonsToApprove: [],
    reasonsToSkip: [],
    viabilityScore: score,
    searchPriority: "merged_pr",
    horizon,
  }) as never;

describe("splitByHorizon 60/40 split", () => {
  const quickWinPool = [
    mkCand("q1", 90, "quick-win"),
    mkCand("q2", 88, "quick-win"),
    mkCand("q3", 85, "quick-win"),
    mkCand("q4", 82, "quick-win"),
    mkCand("q5", 80, "quick-win"),
    mkCand("q6", 78, "quick-win"),
    mkCand("q7", 75, "quick-win"),
    mkCand("q8", 72, "quick-win"),
  ];
  const biggerBetPool = [
    mkCand("b1", 95, "bigger-bet"),
    mkCand("b2", 92, "bigger-bet"),
    mkCand("b3", 88, "bigger-bet"),
    mkCand("b4", 85, "bigger-bet"),
    mkCand("b5", 80, "bigger-bet"),
  ];

  it("returns 6 quick + 4 bigger when count=10 and both abundant", () => {
    const out = splitByHorizon([...quickWinPool, ...biggerBetPool], 10);
    expect(out.quickWins).toHaveLength(6);
    expect(out.biggerBets).toHaveLength(4);
  });
  it("returns 3 quick + 2 bigger when count=5", () => {
    const out = splitByHorizon([...quickWinPool, ...biggerBetPool], 5);
    expect(out.quickWins).toHaveLength(3);
    expect(out.biggerBets).toHaveLength(2);
  });
  it("redirects deficit to other bucket when one is short", () => {
    const out = splitByHorizon([...quickWinPool, biggerBetPool[0], biggerBetPool[1]], 10);
    // target 6+4, but only 2 bigger bets exist → fill quick to 8.
    expect(out.quickWins).toHaveLength(8);
    expect(out.biggerBets).toHaveLength(2);
  });
  it("returns all of one bucket when other is empty", () => {
    const out = splitByHorizon([...quickWinPool], 10);
    expect(out.quickWins).toHaveLength(8);
    expect(out.biggerBets).toHaveLength(0);
  });
  it("sorts each bucket by score desc", () => {
    const out = splitByHorizon([...quickWinPool, ...biggerBetPool], 10);
    expect(out.quickWins.map((c) => c.viabilityScore)).toEqual([
      90, 88, 85, 82, 80, 78,
    ]);
    expect(out.biggerBets.map((c) => c.viabilityScore)).toEqual([
      95, 92, 88, 85,
    ]);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm --filter @oss-scout/core test feature-discovery`
Expected: FAIL — `splitByHorizon` not exported.

- [ ] **Step 3: Implement `splitByHorizon`**

Append to `packages/core/src/core/feature-discovery.ts`:

```ts
import type { IssueCandidate } from "./types.js";

/** A vetted issue candidate stamped with its horizon classification. */
export type FeatureCandidate = IssueCandidate & { horizon: Horizon };

/**
 * Split feature candidates into two buckets respecting a 60/40 target.
 * If either bucket is short, redirect the deficit to the other bucket.
 * Each bucket is sorted by viabilityScore descending.
 */
export function splitByHorizon(
  candidates: FeatureCandidate[],
  count: number,
): { quickWins: FeatureCandidate[]; biggerBets: FeatureCandidate[] } {
  const allQuick = candidates
    .filter((c) => c.horizon === "quick-win")
    .sort((a, b) => b.viabilityScore - a.viabilityScore);
  const allBigger = candidates
    .filter((c) => c.horizon === "bigger-bet")
    .sort((a, b) => b.viabilityScore - a.viabilityScore);

  const targetQuick = Math.round(count * 0.6);
  const targetBigger = count - targetQuick;

  const quickTaken = Math.min(allQuick.length, targetQuick);
  const biggerTaken = Math.min(allBigger.length, targetBigger);

  // Redirect deficits.
  let quickFinal = quickTaken;
  let biggerFinal = biggerTaken;
  const quickDeficit = targetQuick - quickTaken;
  const biggerDeficit = targetBigger - biggerTaken;
  if (quickDeficit > 0) {
    biggerFinal = Math.min(allBigger.length, biggerFinal + quickDeficit);
  }
  if (biggerDeficit > 0) {
    quickFinal = Math.min(allQuick.length, quickFinal + biggerDeficit);
  }

  return {
    quickWins: allQuick.slice(0, quickFinal),
    biggerBets: allBigger.slice(0, biggerFinal),
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @oss-scout/core test feature-discovery`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/feature-discovery.ts packages/core/src/core/feature-discovery.test.ts
git commit -m "feat(core): add splitByHorizon helper with deficit-redirect (#92)"
```

---

### Task 7: Build `discoverFeatures` orchestrator

**Files:**
- Modify: `packages/core/src/core/feature-discovery.ts`
- Modify: `packages/core/src/core/feature-discovery.test.ts`

The orchestrator wires anchor resolution → per-repo issue listing → feature-signal extraction → vetting → classification → bucket split. Reuses `IssueVetter` (already extended with featureSignals) and the throttled `octokit` from `github.ts`.

- [ ] **Step 1: Write failing test**

Append to `packages/core/src/core/feature-discovery.test.ts`:

```ts
import { vi } from "vitest";
import { discoverFeatures } from "./feature-discovery.js";

describe("discoverFeatures orchestrator", () => {
  it("returns no-anchors message when repoScores has no qualifying repos", async () => {
    const octokit = { issues: { listForRepo: vi.fn() } } as never;
    const vetter = { vetIssue: vi.fn() } as never;
    const result = await discoverFeatures({
      octokit,
      vetter,
      repoScores: mkScores(["a/b", 1]),
      count: 10,
    });
    expect(result.anchorRepos).toEqual([]);
    expect(result.quickWins).toEqual([]);
    expect(result.biggerBets).toEqual([]);
    expect(result.message).toContain("No anchor repos yet");
    expect(octokit.issues.listForRepo).not.toHaveBeenCalled();
  });

  it("returns no-results message when anchors exist but no feature issues found", async () => {
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({ data: [] }),
      },
    } as never;
    const vetter = { vetIssue: vi.fn() } as never;
    const result = await discoverFeatures({
      octokit,
      vetter,
      repoScores: mkScores(["a/b", 4]),
      count: 10,
    });
    expect(result.anchorRepos).toEqual(["a/b"]);
    expect(result.quickWins).toEqual([]);
    expect(result.biggerBets).toEqual([]);
    expect(result.message).toContain("No open feature opportunities");
  });

  it("classifies, vets, and splits issues into horizons", async () => {
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({
          data: [
            {
              html_url: "https://github.com/a/b/issues/1",
              title: "small enhancement",
              labels: [{ name: "enhancement" }],
              updated_at: "2026-05-01",
              comments: 2,
              reactions: { total_count: 4 },
              milestone: null,
              pull_request: undefined,
              assignee: null,
            },
            {
              html_url: "https://github.com/a/b/issues/2",
              title: "big proposal",
              labels: [{ name: "proposal" }],
              updated_at: "2026-05-01",
              comments: 30,
              reactions: { total_count: 50 },
              milestone: { number: 1 },
              pull_request: undefined,
              assignee: null,
            },
          ],
        }),
      },
    } as never;
    const vetter = {
      vetIssue: vi.fn().mockImplementation(async (url: string) => ({
        issue: { url, repo: "a/b", number: 1, title: "t", labels: [], updatedAt: "2026-05-01" },
        vettingResult: { passedAllChecks: true, checks: {}, notes: [] },
        projectHealth: {},
        antiLLMPolicy: { matched: false, matchedKeywords: [], sourceFile: null },
        slmTriage: null,
        recommendation: "approve",
        reasonsToApprove: [],
        reasonsToSkip: [],
        viabilityScore: 80,
        searchPriority: "merged_pr",
      })),
    } as never;
    const result = await discoverFeatures({
      octokit,
      vetter,
      repoScores: mkScores(["a/b", 4]),
      count: 10,
    });
    expect(result.anchorRepos).toEqual(["a/b"]);
    expect(result.quickWins).toHaveLength(1);
    expect(result.biggerBets).toHaveLength(1);
    expect(result.quickWins[0].horizon).toBe("quick-win");
    expect(result.biggerBets[0].horizon).toBe("bigger-bet");
    expect(result.message).toBeNull();
    // Confirm vetter received feature signals
    expect(vetter.vetIssue).toHaveBeenCalledWith(
      "https://github.com/a/b/issues/1",
      { featureSignals: { reactions: 4, comments: 2, hasMilestone: false } },
    );
    expect(vetter.vetIssue).toHaveBeenCalledWith(
      "https://github.com/a/b/issues/2",
      { featureSignals: { reactions: 50, comments: 30, hasMilestone: true } },
    );
  });

  it("propagates auth and rate-limit errors", async () => {
    const error = Object.assign(new Error("401"), { status: 401 });
    const octokit = {
      issues: { listForRepo: vi.fn().mockRejectedValue(error) },
    } as never;
    const vetter = { vetIssue: vi.fn() } as never;
    await expect(
      discoverFeatures({
        octokit,
        vetter,
        repoScores: mkScores(["a/b", 4]),
        count: 10,
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm --filter @oss-scout/core test feature-discovery`
Expected: FAIL — `discoverFeatures` not exported.

- [ ] **Step 3: Implement orchestrator**

Append to `packages/core/src/core/feature-discovery.ts`:

```ts
import type { Octokit } from "@octokit/rest";
import type { IssueVetter } from "./issue-vetting.js";
import { errorMessage, getHttpStatusCode, isRateLimitError } from "./errors.js";
import { warn } from "./logger.js";
import { sleep } from "./utils.js";

const MODULE = "feature-discovery";

/** Delay between per-repo issue lists, mirroring search-phases.INTER_QUERY_DELAY_MS. */
const INTER_REPO_DELAY_MS = 2000;

/** Feature labels used to filter issues. Any-of match. */
export const FEATURE_LABELS = [
  "enhancement",
  "feature",
  "feature-request",
  "proposal",
  "roadmap",
  "accepted-rfc",
] as const;

/** Labels excluded from feature-mode results (overlap with `scout` territory). */
export const FEATURE_EXCLUSION_LABELS = new Set([
  "good first issue",
  "bug",
  "documentation",
]);

export const NO_ANCHORS_MESSAGE =
  "No anchor repos yet (need 3+ merged PRs in a repo). Try `scout search` to build relationships first.";

export const NO_RESULTS_MESSAGE =
  "No open feature opportunities in your anchor repos right now. Check back next week, or try `scout search` for fix-mode work.";

export interface FeatureSearchResult {
  quickWins: FeatureCandidate[];
  biggerBets: FeatureCandidate[];
  anchorRepos: string[];
  message: string | null;
}

export interface DiscoverFeaturesOptions {
  octokit: Octokit;
  vetter: IssueVetter;
  repoScores: Record<string, RepoScore>;
  count: number;
}

interface RawIssueItem {
  html_url: string;
  title?: string;
  labels?: Array<{ name?: string } | string>;
  comments?: number;
  reactions?: { total_count?: number } | null;
  milestone?: { number?: number } | null;
  pull_request?: unknown;
  assignee?: unknown;
}

function extractLabels(item: RawIssueItem): string[] {
  if (!Array.isArray(item.labels)) return [];
  return item.labels
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter((s): s is string => typeof s === "string");
}

function isFeatureIssue(item: RawIssueItem): boolean {
  const labels = extractLabels(item).map((l) => l.toLowerCase());
  if (labels.length === 0) return false;
  if (labels.some((l) => FEATURE_EXCLUSION_LABELS.has(l))) return false;
  return labels.some((l) => (FEATURE_LABELS as readonly string[]).includes(l));
}

export async function discoverFeatures(
  opts: DiscoverFeaturesOptions,
): Promise<FeatureSearchResult> {
  const anchorRepos = resolveAnchorRepos(opts.repoScores);
  if (anchorRepos.length === 0) {
    return {
      quickWins: [],
      biggerBets: [],
      anchorRepos: [],
      message: NO_ANCHORS_MESSAGE,
    };
  }

  const candidates: FeatureCandidate[] = [];

  for (let i = 0; i < anchorRepos.length; i++) {
    if (i > 0) await sleep(INTER_REPO_DELAY_MS);
    const [owner, repo] = anchorRepos[i].split("/");
    let response;
    try {
      response = await opts.octokit.issues.listForRepo({
        owner,
        repo,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: 20,
      });
    } catch (err: unknown) {
      // Auth and rate-limit errors propagate; other errors degrade with a warn.
      if (getHttpStatusCode(err) === 401 || isRateLimitError(err)) throw err;
      warn(
        MODULE,
        `failed to list issues for ${anchorRepos[i]}: ${errorMessage(err)}`,
      );
      continue;
    }

    const items = (response.data as RawIssueItem[]).filter(
      (it) => !it.pull_request && !it.assignee && isFeatureIssue(it),
    );

    for (const item of items) {
      const labels = extractLabels(item);
      const hasMilestone = !!item.milestone;
      const reactions = item.reactions?.total_count ?? 0;
      const comments = item.comments ?? 0;
      let candidate;
      try {
        candidate = await opts.vetter.vetIssue(item.html_url, {
          featureSignals: { reactions, comments, hasMilestone },
        });
      } catch (err: unknown) {
        if (getHttpStatusCode(err) === 401 || isRateLimitError(err)) throw err;
        warn(MODULE, `vet failed for ${item.html_url}: ${errorMessage(err)}`);
        continue;
      }
      const horizon = classifyHorizon({ hasMilestone, labels });
      candidates.push({ ...candidate, horizon });
    }
  }

  // Drop low-viability results — same threshold as scout search.
  const passing = candidates.filter((c) => c.viabilityScore >= 40);

  const split = splitByHorizon(passing, opts.count);
  const total = split.quickWins.length + split.biggerBets.length;
  return {
    ...split,
    anchorRepos,
    message: total === 0 ? NO_RESULTS_MESSAGE : null,
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @oss-scout/core test feature-discovery`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/feature-discovery.ts packages/core/src/core/feature-discovery.test.ts
git commit -m "feat(core): add discoverFeatures orchestrator (#92)"
```

---

### Task 8: Add `OssScout.features()` API method

**Files:**
- Modify: `packages/core/src/scout.ts`
- Modify: `packages/core/src/scout.test.ts`

Public API mirroring `OssScout.search()`. Builds the discoverFeatures call and persists results.

**Important:** `state.repoScores` is `Record<string, RepoScore>`, not an array. The test data and the `OssScout.features()` body both pass it through unchanged to `discoverFeatures`. The existing `scout.test.ts` builds state via `ScoutStateSchema.parse({ version: 1, ...overrides })` — use that pattern for the test setup.

- [ ] **Step 1: Write failing test**

Append to `packages/core/src/scout.test.ts`. Stub `discoverFeatures` so the test does not exercise network/octokit calls:

```ts
import { vi } from "vitest";

vi.mock("./core/feature-discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./core/feature-discovery.js")>();
  return {
    ...actual,
    discoverFeatures: vi.fn(),
  };
});

import { discoverFeatures } from "./core/feature-discovery.js";

describe("OssScout.features", () => {
  it("delegates to discoverFeatures and persists results with horizon stamped", async () => {
    const fakeQuick = {
      issue: {
        url: "https://github.com/foo/bar/issues/1",
        repo: "foo/bar",
        number: 1,
        title: "qw",
        labels: ["enhancement"],
        updatedAt: "2026-05-08",
      },
      vettingResult: { passedAllChecks: true, checks: {}, notes: [] },
      projectHealth: {},
      antiLLMPolicy: { matched: false, matchedKeywords: [], sourceFile: null },
      slmTriage: null,
      recommendation: "approve",
      reasonsToApprove: [],
      reasonsToSkip: [],
      viabilityScore: 80,
      searchPriority: "merged_pr",
      horizon: "quick-win" as const,
    };
    const fakeBigger = { ...fakeQuick, issue: { ...fakeQuick.issue, url: "https://github.com/foo/bar/issues/2", number: 2 }, horizon: "bigger-bet" as const };
    vi.mocked(discoverFeatures).mockResolvedValue({
      quickWins: [fakeQuick],
      biggerBets: [fakeBigger],
      anchorRepos: ["foo/bar"],
      message: null,
    } as never);

    const state = ScoutStateSchema.parse({
      version: 1,
      repoScores: {
        "foo/bar": {
          repo: "foo/bar",
          score: 5,
          mergedPRCount: 4,
          closedWithoutMergeCount: 0,
          avgResponseDays: null,
          lastEvaluatedAt: "2026-05-08T00:00:00Z",
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        },
      },
    });
    const scout = new OssScout("test-token", state);
    const result = await scout.features({ count: 10 });
    expect(result.quickWins).toHaveLength(1);
    expect(result.biggerBets).toHaveLength(1);
    expect(scout.getSavedResults().find((r) => r.number === 1)?.horizon).toBe("quick-win");
    expect(scout.getSavedResults().find((r) => r.number === 2)?.horizon).toBe("bigger-bet");
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm --filter @oss-scout/core test scout`
Expected: FAIL — `OssScout.features` not implemented.

- [ ] **Step 3: Implement `OssScout.features()`**

Edit `packages/core/src/scout.ts`. Add an import:

```ts
import {
  discoverFeatures,
  type FeatureSearchResult,
} from "./core/feature-discovery.js";
import { IssueVetter } from "./core/issue-vetting.js";
import { getOctokit } from "./core/github.js";
```

Inside the `OssScout` class, after the `search` method, add:

```ts
/**
 * `scout features` — surfaces feature-scoped contribution opportunities
 * in repos where the user has 3+ merged PRs, ranked into separate
 * "quick wins" and "bigger bets" buckets.
 */
async features(options?: {
  count?: number;
}): Promise<FeatureSearchResult> {
  const count = options?.count ?? 10;
  const octokit = getOctokit(this.githubToken);
  const vetter = new IssueVetter(octokit, this);
  const result = await discoverFeatures({
    octokit,
    vetter,
    repoScores: this.state.repoScores ?? {},
    count,
  });

  // Persist with horizon stamped on each saved candidate.
  this.saveResults([
    ...result.quickWins.map((c) => ({ ...c, horizon: c.horizon as const })),
    ...result.biggerBets.map((c) => ({ ...c, horizon: c.horizon as const })),
  ]);
  this.state.lastSearchAt = new Date().toISOString();
  this.dirty = true;

  return result;
}
```

To make `saveResults` honor the new optional `horizon` field, update its body. Find:

```ts
saveResults(candidates: IssueCandidate[]): void {
  ...
  for (const c of candidates) {
    ...
    existing.set(c.issue.url, {
      ...
      lastScore: c.viabilityScore,
    });
  }
}
```

Change the parameter type to accept either `IssueCandidate` or `FeatureCandidate`:

```ts
saveResults(
  candidates: Array<IssueCandidate | (IssueCandidate & { horizon?: Horizon })>,
): void {
```

And inside the existing.set call, append `horizon: ("horizon" in c ? c.horizon : undefined),`.

Also import `Horizon` at the top of `scout.ts` from schemas.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @oss-scout/core test scout`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scout.ts packages/core/src/scout.test.ts
git commit -m "feat(core): expose OssScout.features() API (#92)"
```

---

### Task 9: CLI command `scout features`

**Files:**
- Create: `packages/core/src/commands/features.ts`
- Create: `packages/core/src/commands/features.test.ts`
- Modify: `packages/core/src/cli.ts`

CLI entry mirrors `commands/search.ts`. Validates count, loads state, delegates to `OssScout.features()`, prints terminal or JSON output.

- [ ] **Step 1: Write failing test**

Create `packages/core/src/commands/features.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runFeatures } from "./features.js";

vi.mock("../scout.js", () => ({
  createScout: vi.fn().mockResolvedValue({
    features: vi.fn().mockResolvedValue({
      quickWins: [],
      biggerBets: [],
      anchorRepos: [],
      message: "No anchor repos yet",
    }),
    getState: () => ({}),
    saveResults: vi.fn(),
    checkpoint: vi.fn().mockResolvedValue(true),
    getRepoScoreRecord: vi.fn().mockReturnValue(undefined),
  }),
}));

vi.mock("../core/utils.js", () => ({
  requireGitHubToken: () => "test-token",
}));

vi.mock("../core/local-state.js", () => ({
  saveLocalState: vi.fn(),
}));

describe("runFeatures", () => {
  it("returns the features result envelope", async () => {
    const out = await runFeatures({ maxResults: 10 });
    expect(out.quickWins).toEqual([]);
    expect(out.biggerBets).toEqual([]);
    expect(out.message).toBe("No anchor repos yet");
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm --filter @oss-scout/core test commands/features`
Expected: FAIL — `runFeatures` not exported.

- [ ] **Step 3: Implement `runFeatures`**

Create `packages/core/src/commands/features.ts`:

```ts
/**
 * Features command — surfaces feature opportunities in anchor repos.
 */

import { createScout } from "../scout.js";
import { requireGitHubToken } from "../core/utils.js";
import { saveLocalState } from "../core/local-state.js";
import type { ScoutState } from "../core/schemas.js";

export interface FeaturesOutput {
  quickWins: Array<{
    issue: { repo: string; number: number; title: string; url: string; labels: string[] };
    recommendation: "approve" | "skip" | "needs_review";
    viabilityScore: number;
    horizon: "quick-win";
  }>;
  biggerBets: Array<{
    issue: { repo: string; number: number; title: string; url: string; labels: string[] };
    recommendation: "approve" | "skip" | "needs_review";
    viabilityScore: number;
    horizon: "bigger-bet";
  }>;
  anchorRepos: string[];
  message: string | null;
}

interface FeaturesCommandOptions {
  maxResults: number;
  state?: ScoutState;
}

export async function runFeatures(
  options: FeaturesCommandOptions,
): Promise<FeaturesOutput> {
  const token = requireGitHubToken();
  const scout = options.state
    ? await createScout({
        githubToken: token,
        persistence: "provided",
        initialState: options.state,
      })
    : await createScout({ githubToken: token });

  const result = await scout.features({ count: options.maxResults });

  saveLocalState(scout.getState() as ScoutState);
  const persisted = await scout.checkpoint();
  if (!persisted) {
    console.error("Warning: changes saved locally but gist sync failed.");
  }

  const mapCandidate = (
    c: (typeof result.quickWins)[number],
    horizon: "quick-win" | "bigger-bet",
  ) => ({
    issue: {
      repo: c.issue.repo,
      number: c.issue.number,
      title: c.issue.title,
      url: c.issue.url,
      labels: c.issue.labels,
    },
    recommendation: c.recommendation,
    viabilityScore: c.viabilityScore,
    horizon,
  });

  return {
    quickWins: result.quickWins.map((c) => mapCandidate(c, "quick-win")),
    biggerBets: result.biggerBets.map((c) => mapCandidate(c, "bigger-bet")),
    anchorRepos: result.anchorRepos,
    message: result.message,
  };
}
```

- [ ] **Step 4: Register CLI command**

Edit `packages/core/src/cli.ts`. After the `search` command block, add:

```ts
program
  .command("features [count]")
  .description(
    "Surface feature-scoped opportunities in repos where you have 3+ merged PRs",
  )
  .option("--json", "Output as JSON")
  .action(
    async (
      count: string | undefined,
      options: { json?: boolean },
    ) => {
      try {
        const { runFeatures } = await import("./commands/features.js");
        const maxResults = count ? parseInt(count, 10) : 10;
        if (isNaN(maxResults) || maxResults < 1 || maxResults > 50) {
          console.error("Error: count must be an integer between 1 and 50");
          process.exit(1);
        }
        const state = loadLocalState();
        const result = await runFeatures({ maxResults, state });
        if (options.json) {
          console.log(formatJsonSuccess(result));
        } else {
          // Human-readable output
          const total = result.quickWins.length + result.biggerBets.length;
          if (result.message) {
            console.log(`\n${result.message}\n`);
          }
          if (total === 0) return;
          console.log(
            `\n🎯 Feature opportunities in your anchor repos (${result.quickWins.length} quick wins + ${result.biggerBets.length} bigger bets)\n`,
          );
          console.log(`Anchor repos: ${result.anchorRepos.join(", ")}\n`);
          if (result.quickWins.length) {
            console.log("── Quick wins ─────────────────────────────────────────");
            for (const c of result.quickWins) {
              console.log(
                `  ${c.issue.repo}#${c.issue.number} [${c.viabilityScore}/100] ${c.issue.title}`,
              );
              console.log(`     ${c.issue.url}`);
            }
            console.log("");
          }
          if (result.biggerBets.length) {
            console.log("── Bigger bets ────────────────────────────────────────");
            for (const c of result.biggerBets) {
              console.log(
                `  ${c.issue.repo}#${c.issue.number} [${c.viabilityScore}/100] ${c.issue.title}`,
              );
              console.log(`     ${c.issue.url}`);
            }
            console.log("");
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (options.json) {
          console.log(formatJsonError(msg, "FEATURES_FAILED"));
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exit(1);
      }
    },
  );
```

If `formatJsonSuccess` and `formatJsonError` are not already imported, check the imports at the top of `cli.ts` and add them. Look at how `search` uses them — copy the same imports.

- [ ] **Step 5: Run tests + smoke-test the CLI**

Run: `pnpm --filter @oss-scout/core test commands/features && pnpm --filter @oss-scout/core run bundle`
Expected: PASS, bundle rebuilds.

Smoke: `pnpm start -- features --json` against your real state. Confirm shape of envelope (success, data with quickWins/biggerBets/anchorRepos/message, timestamp). It is OK if the result is the no-anchors message because the running user has no qualifying repos.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/commands/features.ts packages/core/src/commands/features.test.ts packages/core/src/cli.ts
git commit -m "feat(cli): add scout features subcommand (#92)"
```

---

### Task 10: MCP tool `scout-features`

**Files:**
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/tools.test.ts`

Mirrors the existing `search` tool registration.

- [ ] **Step 1: Update existing tool-count test and add registration assertion**

The existing test asserts `expect(server.tool).toHaveBeenCalledTimes(5)` and lists the registered names. With this addition the count becomes 6.

Edit `packages/mcp-server/src/tools.test.ts`. In the `it("registers all five tools", ...)` block:
- Change the test name to `"registers all six tools"`.
- Change `expect(server.tool).toHaveBeenCalledTimes(5)` to `(6)`.
- Add `expect(names).toContain("scout-features");` at the end of the assertions.

Add a new `describe` block paralleling the existing `search tool execution` block:

```ts
describe("scout-features tool execution", () => {
  it("returns JSON text content on success", async () => {
    const featuresResult = {
      quickWins: [],
      biggerBets: [],
      anchorRepos: [],
      message: "No anchor repos yet",
    };
    const local = createMockScout({
      features: vi.fn().mockResolvedValue(featuresResult),
    } as Partial<OssScout>);
    const localServer = new McpServer({ name: "t", version: "0.0.1" });
    vi.spyOn(localServer, "tool");
    registerTools(localServer, local);
    const handler = getToolHandler(localServer, "scout-features");
    const result = (await handler({ maxResults: 5 }, {})) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject(featuresResult);
  });
});
```

Also add `features: vi.fn().mockResolvedValue({ quickWins: [], biggerBets: [], anchorRepos: [], message: null })` to the `createMockScout` defaults so the existing `beforeEach` registration succeeds with the new tool's expected method.

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm --filter @oss-scout/mcp test`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Register tool**

Edit `packages/mcp-server/src/tools.ts`. After the `search` `server.tool(...)` block, add:

```ts
server.tool(
  "scout-features",
  "Surface feature-scoped contribution opportunities in repos where you have 3+ merged PRs",
  {
    maxResults: z
      .number()
      .optional()
      .describe("Maximum number of results to return (default 10)"),
  },
  async ({ maxResults }) => {
    try {
      const result = await withTimeout(
        scout.features({ count: maxResults ?? 10 }),
      );
      scout.saveResults([...result.quickWins, ...result.biggerBets]);
      await scout.checkpoint();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @oss-scout/mcp test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools.ts packages/mcp-server/src/tools.test.ts
git commit -m "feat(mcp): add scout-features tool (#92)"
```

---

### Task 11: Public exports

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add exports**

Edit `packages/core/src/index.ts`. Add to the existing `export {...} from "./core/schemas.js"` line: `Horizon, HorizonSchema`. Add a new export line:

```ts
export {
  discoverFeatures,
  resolveAnchorRepos,
  classifyHorizon,
  splitByHorizon,
  ANCHOR_THRESHOLD,
  FEATURE_LABELS,
  NO_ANCHORS_MESSAGE,
  NO_RESULTS_MESSAGE,
  type FeatureSearchResult,
  type FeatureCandidate,
  type DiscoverFeaturesOptions,
} from "./core/feature-discovery.js";

export type { FeatureSignals } from "./core/issue-vetting.js";
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter @oss-scout/core run typecheck`
Expected: PASS, no missing exports or unresolved types.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export feature-discovery public API (#92)"
```

---

### Task 12: Final integration — lint, full test, bundle, pre-commit review

**Files:** entire repo.

- [ ] **Step 1: Lint**

Run: `pnpm run lint`
Expected: PASS, zero errors.

- [ ] **Step 2: Format check**

Run: `pnpm run format:check`
Expected: PASS. If failures, run `pnpm run format` and re-stage.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: all green; new feature-discovery tests included.

- [ ] **Step 4: Bundle**

Run: `pnpm run bundle`
Expected: bundle rebuild succeeds.

- [ ] **Step 5: Pre-commit review loop (per CLAUDE.md)**

Invoke the `oss-autopilot:pr-ready` skill. Iterate until convergence (zero Critical / Recommended findings). Hard cap at 5 passes; if not converged, stop and report.

- [ ] **Step 6: Open PR**

```bash
git push -u origin feat/92-scout-features-design
gh pr create --base main --title "feat: add scout features subcommand (#92)" --body "$(cat <<'EOF'
## Summary

Implements `scout features` per design in `docs/superpowers/specs/2026-05-08-scout-features-design.md`. Closes #92.

## Why

`scout` optimizes for low-friction merges (small bugs). `scout features` adds a complementary objective function: feature-scoped opportunities in repos where the user has earned trust (3+ merged PRs).

## Test plan

- [ ] All unit tests pass
- [ ] Lint, format, typecheck pass
- [ ] Bundle rebuilds
- [ ] Smoke test: `pnpm start -- features --json` returns the expected envelope
- [ ] Smoke test: `pnpm start -- features` prints the sectioned terminal output
- [ ] CI green on all matrix nodes
EOF
)"
```

- [ ] **Step 7: Wait for CI, then merge per the issue-batch-autopilot pattern**

Use the until-loop pattern from the `issue-batch-autopilot` skill. Once green, squash-merge with `--delete-branch`.

- [ ] **Step 8: File follow-up issues**

For each item in the spec's "Out of scope for v1" section, file an issue. Use bare names (no `@user`, no `org/repo#N`).

```bash
for title in \
  "feat(scout): project-board / ROADMAP.md scraping for richer maintainer-commitment signal" \
  "feat(scout): wontfix-no-contributor detection" \
  "feat(scout): stalled-PR revival mode" \
  "feat(scout): configurable anchor threshold (featuresAnchorThreshold)" \
  "feat(scout): configurable quick-wins / bigger-bets split ratio" \
  "feat(scout): cross-repo features mode for first-touch contributors"; do
  gh issue create --title "$title" --body "Follow-up to #92 design spec. See \`docs/superpowers/specs/2026-05-08-scout-features-design.md\` 'Out of scope for v1' section." --repo costajohnt/oss-scout
done
```

---

## Self-review notes

Reviewed against the spec. Coverage:

- Anchor resolution (3+ merged PRs) → Task 4
- Both horizons ranked separately → Tasks 5 + 6
- Subcommand sharing core pipeline → Tasks 7 + 8 + 9
- Signals: labels (Task 7 `FEATURE_LABELS`), reactions / comments / milestone (Tasks 2 + 7)
- Horizon classifier (milestone or roadmap/accepted-rfc/proposal label) → Task 5
- Linked-PR penalty kept at -30 → reused via existing scoring (no change needed)
- Empty-state messages → Task 7
- JSON envelope (`success, data: { quickWins, biggerBets, anchorRepos, message }, timestamp`) → Task 9 (CLI uses existing `formatJsonSuccess`)
- MCP tool → Task 10
- Auth and rate-limit propagation → Task 7 orchestrator + reused vetter behavior
- Test coverage for anchor resolution, horizon classifier, 60/40 split, persistence, CLI, MCP, error propagation → Tasks 4-10
- Follow-up issues → Task 12 step 8
