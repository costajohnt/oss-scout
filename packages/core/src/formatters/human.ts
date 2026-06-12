/**
 * Human-readable (non-JSON) output formatters for the oss-scout CLI.
 *
 * Each renderer is a pure function that returns the exact multi-line string the
 * CLI used to emit via a sequence of `console.log` calls. The caller does a
 * single `console.log(renderX(...))`, which appends the one trailing newline
 * that the final `console.log` in the old inline block produced.
 *
 * To stay byte-identical: every old `console.log(line)` becomes one entry in a
 * lines array, a bare `console.log()` (blank line) becomes an empty entry, and
 * the array is joined with "\n". The caller's own `console.log` supplies the
 * last newline. STDERR output (the search rate-limit warning) is deliberately
 * NOT folded in here — it stays a `console.error` in the caller.
 */

import type { SearchOutput } from "../commands/search.js";
import type { FeaturesOutput } from "../commands/features.js";
import type { SavedCandidate } from "../core/schemas.js";
import type { VetListResult } from "../core/types.js";
import type { VetOutput } from "../commands/vet.js";

/** Emoji for a vetting recommendation, shared by the search and vet renderers. */
export function recommendationIcon(
  recommendation: "approve" | "skip" | "needs_review",
): string {
  if (recommendation === "approve") return "✅";
  if (recommendation === "skip") return "❌";
  return "⚠️";
}

/**
 * Render the human-readable `search` output: the "Found N issue candidates"
 * block with per-candidate icon, personalization and stalled tags, and the
 * optional repoScore line. The trailing rate-limit warning is NOT included
 * here; it goes to stderr in the caller.
 */
export function renderSearch(results: SearchOutput): string {
  const lines: string[] = [];
  lines.push(`\nFound ${results.candidates.length} issue candidates:\n`);
  for (const c of results.candidates) {
    const icon = recommendationIcon(c.recommendation);
    const stalledTag = c.linkedPR?.isStalled
      ? " (stalled PR, revive opportunity)"
      : "";
    // Personalization tag (#1244). A candidate is either boosted (matched a
    // preference) or a diversity slot (matched none and filled a reserved
    // slot); never both.
    let personalizationTag = "";
    if (c.boostReasons && c.boostReasons.length > 0) {
      // Net score can be negative when avoidRepos applied (#168).
      const verb = (c.boostScore ?? 0) >= 0 ? "boosted" : "deprioritized";
      personalizationTag = ` [${verb}: ${c.boostReasons.join("; ")}]`;
    } else if (c.diversitySlot) {
      personalizationTag = " [diversity slot]";
    }
    lines.push(
      `  ${icon} ${c.issue.repo}#${c.issue.number} [${c.viabilityScore}/100]${personalizationTag}${stalledTag}`,
    );
    lines.push(`     ${c.issue.title}`);
    lines.push(`     ${c.issue.url}`);
    if (c.repoScore) {
      lines.push(
        `     Repo: ${c.repoScore.score}/10, ${c.repoScore.mergedPRCount} merged PRs`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Render the human-readable `features` output: the optional message, the
 * "Feature opportunities" header, the anchor repos line, and the Quick wins /
 * Bigger bets sections. Returns "" when there is nothing to print beyond an
 * absent message (caller guards against logging a blank line).
 */
export function renderFeatures(
  result: FeaturesOutput,
  options: { broad?: boolean },
): string {
  const lines: string[] = [];
  const total = result.quickWins.length + result.biggerBets.length;
  if (result.message) {
    lines.push(`\n${result.message}\n`);
  }
  if (total === 0) return lines.join("\n");
  const headerScope = options.broad
    ? "across the ecosystem"
    : "in your anchor repos";
  lines.push(
    `\n🎯 Feature opportunities ${headerScope} (${result.quickWins.length} quick wins + ${result.biggerBets.length} bigger bets)\n`,
  );
  if (!options.broad) {
    lines.push(`Anchor repos: ${result.anchorRepos.join(", ")}\n`);
  }
  if (result.quickWins.length) {
    lines.push("── Quick wins ─────────────────────────────────────────");
    for (const c of result.quickWins) {
      const stalledTag = c.linkedPR?.isStalled
        ? " (stalled PR, revive opportunity)"
        : "";
      lines.push(
        `  ${c.issue.repo}#${c.issue.number} [${c.viabilityScore}/100] ${c.issue.title}${stalledTag}`,
      );
      lines.push(`     ${c.issue.url}`);
    }
    lines.push("");
  }
  if (result.biggerBets.length) {
    lines.push("── Bigger bets ────────────────────────────────────────");
    for (const c of result.biggerBets) {
      const stalledTag = c.linkedPR?.isStalled
        ? " (stalled PR, revive opportunity)"
        : "";
      lines.push(
        `  ${c.issue.repo}#${c.issue.number} [${c.viabilityScore}/100] ${c.issue.title}${stalledTag}`,
      );
      lines.push(`     ${c.issue.url}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** The empty-state message printed by `results` when nothing is saved. */
export const RESULTS_EMPTY_MESSAGE =
  "\nNo saved results. Run `oss-scout search` to find issues.\n";

/**
 * Render the human-readable `results` table: the "Saved results" header and a
 * Score / Repo / Issue / Recommendation / Title row per saved candidate.
 * Callers handle the empty state (RESULTS_EMPTY_MESSAGE) separately.
 */
export function renderResults(results: SavedCandidate[]): string {
  const lines: string[] = [];
  lines.push(`\nSaved results (${results.length}):\n`);
  lines.push(
    "  Score  Repo                              Issue   Recommendation  Title",
  );
  lines.push(
    "  ─────  ────────────────────────────────  ──────  ──────────────  ─────",
  );
  for (const r of results) {
    const score = String(r.viabilityScore).padStart(3);
    const repo = r.repo.padEnd(32).slice(0, 32);
    const issue = `#${r.number}`.padEnd(6);
    const rec = r.recommendation.padEnd(14);
    const title = r.title.length > 50 ? r.title.slice(0, 47) + "..." : r.title;
    lines.push(`  ${score}    ${repo}  ${issue}  ${rec}  ${title}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** The empty-state message printed by `vet-list` when there is nothing to vet. */
export const VET_LIST_EMPTY_MESSAGE =
  "\nNo saved results to vet. Run `oss-scout search` first.\n";

/** Icon for a vet-list entry's availability status. */
function vetListStatusIcon(
  status: VetListResult["results"][number]["status"],
): string {
  return status === "still_available"
    ? "✅"
    : status === "claimed"
      ? "🔒"
      : status === "has_pr"
        ? "🔀"
        : status === "closed"
          ? "🚫"
          : "❌";
}

/**
 * Render the human-readable `vet-list` output: the "Vet-list results (N)"
 * block with a per-row status icon, the "Changes since last check"
 * transitions block, the summary line, and the optional pruned-count line.
 * Callers handle the empty state (VET_LIST_EMPTY_MESSAGE) separately.
 */
export function renderVetList(result: VetListResult): string {
  const lines: string[] = [];
  lines.push(`\nVet-list results (${result.summary.total}):\n`);
  for (const r of result.results) {
    const icon = vetListStatusIcon(r.status);
    const score = r.ok ? ` [${r.viabilityScore}/100]` : "";
    lines.push(`  ${icon} ${r.repo}#${r.number} — ${r.status}${score}`);
    lines.push(`     ${r.title}`);
  }
  if (result.transitions.length > 0) {
    lines.push(`\n🔔 Changes since last check (${result.transitions.length}):`);
    for (const t of result.transitions) {
      lines.push(`  ${t.repo}#${t.number}: ${t.from} → ${t.to}`);
    }
  }
  lines.push(
    `\nSummary: ${result.summary.stillAvailable} available, ${result.summary.claimed} claimed, ${result.summary.hasPR} has PR, ${result.summary.closed} closed, ${result.summary.errors} errors`,
  );
  if (result.prunedCount != null) {
    lines.push(
      `Pruned ${result.prunedCount} unavailable issues from saved results.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the human-readable single-issue `vet` output: the recommendation
 * header, the reasons to approve / skip, and the project-health block. The
 * checkFailed branch (#158) is preserved exactly.
 */
export function renderVet(result: VetOutput): string {
  const lines: string[] = [];
  const icon = recommendationIcon(result.recommendation);
  lines.push(
    `\n${icon} ${result.issue.repo}#${result.issue.number}: ${result.recommendation.toUpperCase()}`,
  );
  lines.push(`   ${result.issue.title}`);
  lines.push(`   ${result.issue.url}\n`);
  if (result.reasonsToApprove.length > 0) {
    lines.push("Reasons to approve:");
    for (const r of result.reasonsToApprove) lines.push(`  + ${r}`);
  }
  if (result.reasonsToSkip.length > 0) {
    lines.push("Reasons to skip:");
    for (const r of result.reasonsToSkip) lines.push(`  - ${r}`);
  }
  if (result.projectHealth.checkFailed) {
    lines.push(
      `\nProject health: unknown (check failed: ${result.projectHealth.failureReason})`,
    );
  } else {
    lines.push(
      `\nProject health: ${result.projectHealth.isActive ? "Active" : "Inactive"}`,
    );
    lines.push(
      `  Last commit: ${result.projectHealth.daysSinceLastCommit} days ago`,
    );
    lines.push(`  CI status: ${result.projectHealth.ciStatus}`);
  }
  return lines.join("\n");
}
