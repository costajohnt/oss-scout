/**
 * Markdown output formatter (#170) — renders saved results as a table for
 * digests, notes export, and scheduled GitHub-issue summaries.
 */

import type { SavedCandidate } from "../core/schemas.js";

/**
 * Escape markdown so an attacker-authored issue title renders as inert text
 * (#308). The digest is posted as a GitHub issue body by action.yml, so an
 * unescaped title could plant live links, images, or HTML in the user's
 * trusted digest. Newlines and pipes also keep the table intact.
 */
function cell(value: string): string {
  return value
    .replace(/\r?\n/g, " ")
    .replace(/[\\`*_[\]()!<>~|]/g, "\\$&")
    .trim();
}

/**
 * Point github.com links at redirect.github.com (#356). The digest is posted
 * as an issue body, and GitHub turns every github.com issue URL in an issue
 * body into a "mentioned this issue" cross-reference on the target issue, so
 * each scheduled run would ping maintainers of every candidate. The redirect
 * host resolves to the same page but creates no backlink (Dependabot uses the
 * same trick).
 */
function noBacklinkUrl(url: string): string {
  return url.replace(
    /^https:\/\/(www\.)?github\.com\//i,
    "https://redirect.github.com/",
  );
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
    const url = noBacklinkUrl(r.issueUrl);
    const issueLink = `[#${r.number}](${url})`;
    // Title rendered as a link to the real issue: GFM does not process
    // autolinks inside link text, so a bare URL pasted into a title can't
    // become a clickable phishing link either (#308).
    const titleLink = `[${cell(r.title)}](${url})`;
    return `| ${r.viabilityScore} | ${cell(r.repo)} | ${issueLink} | ${cell(r.recommendation)} | ${titleLink} |`;
  });

  return [
    `## oss-scout results (${results.length})`,
    "",
    header,
    divider,
    ...rows,
  ].join("\n");
}
