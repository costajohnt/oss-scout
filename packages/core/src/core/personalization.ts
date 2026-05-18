/**
 * Personalization signals for search ranking (#1244).
 *
 * Translates caller-supplied `preferLanguages` / `preferRepos` lists
 * into a soft `boostScore` on each `IssueCandidate`. The final search
 * sort consults this score between the `recommendation` tier and the
 * raw `viabilityScore`, so personalization reorders ties without
 * changing which candidates pass vetting.
 *
 * This is the minimum-viable subset of Option A in #1244: only language
 * and repo bias, no `boostIssueTypes` / `avoidRepos` / `diversityRatio`
 * yet. Those follow up in separate PRs.
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
