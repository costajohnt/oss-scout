/**
 * Markdown output formatter (#170) — renders saved results as a table for
 * digests, notes export, and scheduled GitHub-issue summaries.
 */

import type { SavedCandidate } from "../core/schemas.js";

/** Escape pipe and newline so a title can't break the markdown table. */
function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/**
 * Render saved results as a GitHub-flavored markdown table, sorted by
 * viability score descending. Returns a friendly message when empty.
 */
export function formatResultsMarkdown(results: SavedCandidate[]): string {
  if (results.length === 0) {
    return "_No saved results._";
  }

  const sorted = [...results].sort(
    (a, b) => b.viabilityScore - a.viabilityScore,
  );

  const header = "| Score | Repo | Issue | Recommendation | Title |";
  const divider = "| ----- | ---- | ----- | -------------- | ----- |";
  const rows = sorted.map((r) => {
    const issueLink = `[#${r.number}](${r.issueUrl})`;
    return `| ${r.viabilityScore} | ${cell(r.repo)} | ${issueLink} | ${cell(r.recommendation)} | ${cell(r.title)} |`;
  });

  return [
    `## oss-scout results (${results.length})`,
    "",
    header,
    divider,
    ...rows,
  ].join("\n");
}
