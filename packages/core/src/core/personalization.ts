/**
 * Personalization signals for search ranking (#1244).
 *
 * Two passes:
 *
 *   - `annotateBoost` translates `preferLanguages` / `preferRepos`
 *     into a soft `boostScore` consumed by issue-discovery's final
 *     sort tier between `recommendation` and `viabilityScore`.
 *   - `applyDiversityRatio` reserves a fraction of the final slot
 *     budget for candidates that matched no preference, counterweighting
 *     echo-chamber bias as recommendations accumulate over time.
 *
 * Still out of scope for #1244: `boostIssueTypes`, `avoidRepos`, and
 * render-time annotation of `boostReasons` / `diversitySlot` in the CLI
 * non-JSON output. Those follow up in separate PRs.
 */

import type { IssueCandidate } from "./types.js";

/**
 * Boost weights. Tuned conservatively so personalization tips equally-
 * scored candidates without drowning out high-viability normal results.
 *
 * Rationale:
 *   - Repo affinity is the strongest signal — a candidate in a repo the
 *     user has merged PRs into has real relationship context. Worth the
 *     higher boost.
 *   - Language match is broad and easy to satisfy. Lower weight.
 */
export const REPO_BOOST = 20;
export const LANGUAGE_BOOST = 10;

/**
 * Annotate each candidate with `boostScore` and `boostReasons` based on
 * the caller-supplied preference lists. Mutates the array in place; the
 * caller is responsible for re-sorting afterwards.
 *
 * Mutation (rather than returning new objects) keeps the personalization
 * step a single linear pass over the array the caller already holds —
 * the sort step reads back from the same objects.
 *
 * No-op when both preference lists are empty or undefined: candidates
 * retain `boostScore: undefined` and the sort tier collapses to 0.
 */
export function annotateBoost(
  candidates: IssueCandidate[],
  preferLanguages?: string[],
  preferRepos?: string[],
): void {
  const langSet = new Set(
    (preferLanguages ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean),
  );
  const repoSet = new Set(
    (preferRepos ?? []).map((r) => r.trim()).filter(Boolean),
  );
  if (langSet.size === 0 && repoSet.size === 0) return;

  for (const c of candidates) {
    let score = 0;
    const reasons: string[] = [];

    if (repoSet.size > 0 && repoSet.has(c.issue.repo)) {
      score += REPO_BOOST;
      reasons.push(`repo affinity: ${c.issue.repo}`);
    }

    const lang = c.projectHealth.language;
    if (langSet.size > 0 && lang && langSet.has(lang.toLowerCase())) {
      score += LANGUAGE_BOOST;
      reasons.push(`language match: ${lang}`);
    }

    if (score > 0) {
      c.boostScore = score;
      c.boostReasons = reasons;
    }
  }
}

/**
 * Apply a diversity-counterweight pass over a pre-sorted candidate list
 * (#1244). Returns the first `maxResults` picks in priority order:
 *
 *   1. Main slots: `maxResults - floor(maxResults * diversityRatio)`
 *      top candidates from the input. Personalization-biased candidates
 *      win these slots when present (since the input is already sorted
 *      by the personalization tier).
 *   2. Diversity slots: the highest-ranked candidates that carry NO
 *      `boostScore` — i.e. they matched neither `preferLanguages` nor
 *      `preferRepos`. Tagged with `diversitySlot: true` for caller
 *      transparency.
 *   3. Top-up: if the diversity pool was thinner than the reserve, fall
 *      back to the remaining sorted candidates so the user gets
 *      `maxResults` slots whenever the source has enough material.
 *
 * `diversityRatio` is clamped to [0, 1]. 0 is a no-op (just slices the
 * input). 1 means every slot is a diversity slot — useful for
 * deliberately suppressing personalization without disabling it.
 *
 * @param candidates    Pre-sorted candidate list (output of issue-discovery)
 * @param maxResults    Total slots to fill
 * @param diversityRatio Fraction of slots reserved for unboosted candidates
 */
export function applyDiversityRatio(
  candidates: IssueCandidate[],
  maxResults: number,
  diversityRatio: number,
): IssueCandidate[] {
  if (maxResults <= 0) return [];
  const ratio = Math.max(0, Math.min(1, diversityRatio));
  if (ratio === 0) return candidates.slice(0, maxResults);

  const diversityReserve = Math.min(Math.floor(maxResults * ratio), maxResults);
  if (diversityReserve === 0) return candidates.slice(0, maxResults);

  const mainBudget = maxResults - diversityReserve;
  const picks: IssueCandidate[] = [];
  const seen = new Set<string>();

  for (const c of candidates) {
    if (picks.length >= mainBudget) break;
    picks.push(c);
    seen.add(c.issue.url);
  }

  for (const c of candidates) {
    if (picks.length >= maxResults) break;
    if (seen.has(c.issue.url)) continue;
    if (c.boostScore && c.boostScore > 0) continue;
    c.diversitySlot = true;
    picks.push(c);
    seen.add(c.issue.url);
  }

  for (const c of candidates) {
    if (picks.length >= maxResults) break;
    if (seen.has(c.issue.url)) continue;
    picks.push(c);
    seen.add(c.issue.url);
  }

  return picks;
}
