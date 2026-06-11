import { describe, it, expect } from "vitest";
import { formatResultsMarkdown } from "./markdown.js";
import type { SavedCandidate } from "../core/schemas.js";

function candidate(overrides: Partial<SavedCandidate> = {}): SavedCandidate {
  return {
    issueUrl: "https://github.com/owner/repo/issues/1",
    repo: "owner/repo",
    number: 1,
    title: "Fix the bug",
    labels: [],
    recommendation: "approve",
    viabilityScore: 75,
    searchPriority: "normal",
    firstSeenAt: "2026-03-01T00:00:00.000Z",
    lastSeenAt: "2026-03-01T00:00:00.000Z",
    lastScore: 75,
    ...overrides,
  };
}

describe("formatResultsMarkdown (#170)", () => {
  it("returns a friendly message when empty", () => {
    expect(formatResultsMarkdown([])).toBe("_No saved results._");
  });

  it("renders a header, divider, and one row per result, sorted by score", () => {
    const md = formatResultsMarkdown([
      candidate({ number: 1, viabilityScore: 40 }),
      candidate({ number: 2, viabilityScore: 90 }),
    ]);
    const lines = md.split("\n");
    expect(lines[0]).toContain("oss-scout results (2)");
    expect(lines).toContain(
      "| Score | Repo | Issue | Recommendation | Title |",
    );
    // Highest score first.
    const rows = lines.filter((l) => l.startsWith("| ") && l.includes("#"));
    expect(rows[0]).toContain("90");
    expect(rows[0]).toContain("[#2](");
    expect(rows[1]).toContain("40");
  });

  it("escapes pipes and newlines in the title so the table stays valid", () => {
    const md = formatResultsMarkdown([candidate({ title: "a | b\nc" })]);
    const row = md.split("\n").find((l) => l.includes("[#1]"))!;
    expect(row).toContain("a \\| b c");
    // Exactly the 5 column separators (no extra unescaped pipe from the title).
    expect(row.match(/(?<!\\)\|/g)).toHaveLength(6);
  });
});
