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
/** Soft boost for an issue-label ("issue type") match (#168). Language-tier. */
export const ISSUE_TYPE_BOOST = 10;
/**
 * Soft penalty for an avoidRepos match (#168). Milder than the hard
 * excludeRepos filter: it pushes the candidate down but a strong boost (e.g. a
 * preferRepos affinity, +20) can still outweigh it.
 */
export const AVOID_PENALTY = 15;

/** Per-call personalization bias lists (#168). All optional; empty = no effect. */
export interface PersonalizationBias {
  preferLanguages?: string[];
  preferRepos?: string[];
  avoidRepos?: string[];
  boostIssueTypes?: string[];
}

/**
 * The personalization sort weight of a candidate: its net score, or 0 when it
 * carries no personalization marker. Reads the structural `personalization`
 * field (#158). The score can be negative when avoidRepos applied (#168).
 */
export function boostScoreOf(candidate: IssueCandidate): number {
  return candidate.personalization?.kind === "boosted"
    ? candidate.personalization.score
    : 0;
}

function normalizeSet(values: string[] | undefined): Set<string> {
  return new Set(
    (values ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean),
  );
}

/**
 * Return a new candidate list where each candidate matching a caller-supplied
 * bias carries a `personalization` marker with a NET score (#168): preferRepos,
 * preferLanguages and boostIssueTypes add; avoidRepos subtracts. The score may
 * be negative (avoid-only) — boostScoreOf sorts those below neutral candidates.
 * Does NOT mutate the input (#158): matched candidates are shallow copies,
 * unmatched ones pass through unchanged.
 *
 * No-op when every bias list is empty/undefined: the input array is returned
 * as-is and the sort tier collapses to 0 for every candidate.
 */
export function annotateBoost(
  candidates: IssueCandidate[],
  bias: PersonalizationBias = {},
): IssueCandidate[] {
  const langSet = normalizeSet(bias.preferLanguages);
  const repoSet = normalizeSet(bias.preferRepos);
  const avoidSet = normalizeSet(bias.avoidRepos);
  const typeSet = normalizeSet(bias.boostIssueTypes);
  if (
    langSet.size === 0 &&
    repoSet.size === 0 &&
    avoidSet.size === 0 &&
    typeSet.size === 0
  ) {
    return candidates;
  }

  return candidates.map((c) => {
    let score = 0;
    const reasons: string[] = [];
    const repoLower = c.issue.repo.toLowerCase();

    if (repoSet.size > 0 && repoSet.has(repoLower)) {
      score += REPO_BOOST;
      reasons.push(`repo affinity: ${c.issue.repo}`);
    }

    const lang = c.projectHealth.checkFailed ? null : c.projectHealth.language;
    if (langSet.size > 0 && lang && langSet.has(lang.toLowerCase())) {
      score += LANGUAGE_BOOST;
      reasons.push(`language match: ${lang}`);
    }

    if (typeSet.size > 0) {
      const matched = c.issue.labels.find((l) => typeSet.has(l.toLowerCase()));
      if (matched) {
        score += ISSUE_TYPE_BOOST;
        reasons.push(`issue type: ${matched}`);
      }
    }

    if (avoidSet.size > 0 && avoidSet.has(repoLower)) {
      score -= AVOID_PENALTY;
      reasons.push(`avoided repo: ${c.issue.repo}`);
    }

    if (reasons.length === 0) return c;
    return { ...c, personalization: { kind: "boosted", score, reasons } };
  });
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
    // Diversity slots are for candidates that matched NO personalization bias.
    // Exclude both boosted (>0) and avoided (<0) candidates — resurfacing an
    // avoided repo via a diversity slot would defeat the avoid (#168).
    if (boostScoreOf(c) !== 0) continue;
    // Tag a shallow copy rather than mutating the shared candidate (#158).
    picks.push({ ...c, personalization: { kind: "diversity" } });
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
