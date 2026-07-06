/**
 * Vet eval — markdown report generation. Pure function of a summary +
 * run metadata; no I/O, so it's covered by deterministic tests with
 * canned results (no live vet/model calls needed).
 */
import type { VetEvalResult } from "./types.js";
import type { VetEvalSummary } from "./vet-eval.js";

export interface ReportMeta {
  date: string;
  mode: "quick" | "full";
  fixtureCount: number;
  fixtureSetHash: string;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function outcomeMixLine(results: VetEvalResult[]): string {
  const counts: Record<string, number> = {};
  for (const r of results) {
    counts[r.fixture.outcome.label] =
      (counts[r.fixture.outcome.label] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([label, n]) => `${label}=${n}`)
    .join(", ");
}

export function buildReport(summary: VetEvalSummary, meta: ReportMeta): string {
  const lines: string[] = [];

  lines.push(`# oss-scout vet eval — ${meta.date}`);
  lines.push("");
  lines.push(
    `Model: oss-scout deterministic vet/scoring algorithm (\`deriveRecommendation\` + ` +
      `\`calculateViabilityScore\`, current \`main\`). No LLM in the default vet path — ` +
      `see "Honest limits" below for what this does and doesn't mean.`,
  );
  lines.push(
    `n: 1 run per fixture (deterministic — see "Why n=1" below). ` +
      `Mode: ${meta.mode}. Fixtures: ${meta.fixtureCount} (${outcomeMixLine(summary.results)}). ` +
      `Fixture-set hash: \`${meta.fixtureSetHash}\`.`,
  );
  lines.push("");

  lines.push("## Verdict accuracy (measurable fixtures only)");
  lines.push("");
  lines.push(
    `Strict (recommendation exactly matches expected): ${summary.accuracy.correct}/` +
      `${summary.accuracy.total} (${pct(summary.accuracy.strictRate)}). Lenient ` +
      `(counts "needs_review" as acceptable, not wrong — see finding below): ` +
      `${summary.accuracy.correct + summary.accuracy.cautious}/${summary.accuracy.total} ` +
      `(${pct(summary.accuracy.lenientRate)}). Wrong (confidently the opposite call): ` +
      `${summary.accuracy.wrong}/${summary.accuracy.total}. ` +
      `Out of ${summary.results.length} total fixtures — the remaining ` +
      `${summary.unmeasurable.length} hinge on signals oss-scout's current vetter ` +
      `doesn't model (see "Out-of-model-scope fixtures" below) and are excluded from ` +
      `these rates rather than silently counted as passes or failures.`,
  );
  lines.push("");

  const expectSkipCautious = summary.measurable.filter(
    (r) =>
      r.fixture.expectedVerdict === "skip" && r.verdictGrade === "cautious",
  );
  const expectSkipTotal = summary.measurable.filter(
    (r) => r.fixture.expectedVerdict === "skip",
  ).length;
  if (expectSkipCautious.length > 0) {
    lines.push(
      `> **Finding:** ${expectSkipCautious.length}/${expectSkipTotal} "should skip" ` +
        `fixtures landed on \`needs_review\` rather than a hard \`skip\`. ` +
        "`deriveRecommendation` (issue-vetting.ts) only emits `skip` when more than " +
        "2 reasonsToSkip accumulate — a single signal (existing PR *or* claimed, " +
        "alone) downgrades to `needs_review` instead. Not wrong on its own (a human " +
        "in the loop still catches it), but worth knowing for any automation that " +
        'treats `recommendation !== "skip"` as "safe to proceed" rather than ' +
        'requiring `recommendation === "approve"` — that automation would auto-' +
        "pursue every one of these correctly-flagged-but-not-hard-skipped cases.",
    );
    lines.push("");
  }

  lines.push(
    "| Fixture | Outcome | Expected | Recommendation | Score | Grade |",
  );
  lines.push("|---|---|---|---|---|---|");
  const gradeIcon: Record<string, string> = {
    correct: "✅",
    cautious: "🟡",
    wrong: "❌",
  };
  for (const r of summary.measurable) {
    lines.push(
      `| ${r.fixture.id} | ${r.fixture.outcome.label} | ${r.fixture.expectedVerdict} | ` +
        `${r.recommendation} | ${r.viabilityScore} | ${gradeIcon[r.verdictGrade]} ${r.verdictGrade} |`,
    );
  }
  lines.push("");

  lines.push("## Out-of-model-scope fixtures (reported, not scored)");
  lines.push("");
  lines.push(
    "These outcomes hinge on race timing, maintainer self-fix behavior, or " +
      "feasibility/business judgment that oss-scout's current deterministic " +
      "checks don't attempt to predict. Shown so the tool's output is visible " +
      "on these cases without pretending the verdict was 'graded'.",
  );
  lines.push("");
  lines.push(
    "| Fixture | Outcome | Recommendation | Score | Why unmeasurable |",
  );
  lines.push("|---|---|---|---|---|");
  for (const r of summary.unmeasurable) {
    lines.push(
      `| ${r.fixture.id} | ${r.fixture.outcome.label} | ${r.recommendation} | ` +
        `${r.viabilityScore} | ${r.fixture.fidelityNote.split(".")[0]}. |`,
    );
  }
  lines.push("");

  lines.push("## Score calibration");
  lines.push("");
  lines.push(
    "Average current `calculateViabilityScore` output per realized outcome " +
      "(across ALL fixtures, measurable or not) — a well-calibrated scorer " +
      "should rank merged > lost_race/maintainer_fixed > skip_correct, since " +
      "the first three are all 'pursue was the right call' outcomes and only " +
      "differ in execution/luck, while skip_correct issues should score lower.",
  );
  lines.push("");
  lines.push("| Outcome | n | Avg score | Pursued rate |");
  lines.push("|---|---|---|---|");
  for (const [label, bucket] of Object.entries(summary.byOutcomeLabel)) {
    lines.push(
      `| ${label} | ${bucket.count} | ${bucket.avgScore.toFixed(1)} | ${pct(bucket.pursuedRate)} |`,
    );
  }
  lines.push("");

  lines.push("## Why n=1");
  lines.push("");
  lines.push(
    "oss-scout's default vet path (`deriveRecommendation` + `calculateViabilityScore` + " +
      "`analyzeRequirements`) is pure, deterministic TypeScript — no LLM call, no " +
      "sampling, so repeated runs against the same fixture always produce the same " +
      "output. Running n>1 here would only prove the functions are pure (already true " +
      "by inspection), not measure anything about judgment quality. The one place a " +
      "model actually runs is the OPTIONAL SLM pre-triage pass (Ollama, local-only, " +
      "off by default) — pass `--slm <model>` to additionally measure ITS run-to-run " +
      "stability across n repeats; that path is not exercised by this report.",
  );
  lines.push("");

  lines.push("## Honest limits");
  lines.push("");
  lines.push(
    "- **Survivorship bias.** These are issues John already chose to investigate, not " +
      "a random sample of all GitHub issues — they skew toward things that looked " +
      "promising enough to spend time on. This eval measures 'given John's existing " +
      "funnel, does the current vetter's verdict/score line up with what happened', " +
      "not 'how good is the vetter at cold-sourcing.'",
  );
  lines.push(
    "- **Outcome conflation.** `merged` vs `lost_race` vs `maintainer_fixed` mostly " +
      "reflect execution speed and luck (who else was watching the same issue, how " +
      "fast John built and pushed), not vet quality — all three started from a " +
      "reasonable 'pursue' call. Treating lost_race/maintainer_fixed as vetting " +
      "failures would overstate what a smarter vetter could realistically prevent.",
  );
  lines.push(
    "- **Reconstruction fidelity.** `vetTimeFacts` (existing-PR/claimed/project-active/" +
      "merged-PR-count) are hand-derived from John's own vetting notes recorded at the " +
      "time, not re-derived from a time-traveled GitHub API call — GitHub's search and " +
      "timeline APIs can't be queried as of a past date. Issue title/body/labels/repo " +
      "star-fork counts ARE live API reads, but reflect state as of fixture-build time " +
      "(2026-07-05), which can differ slightly from vet-time if the issue was edited " +
      "or the repo grew. Each fixture's `fidelityNote` documents this per-case.",
  );
  lines.push(
    "- **Small N, single fixture-set.** 30 fixtures is enough to catch a gross " +
      "regression (e.g. a recommendation-logic change that starts skipping every " +
      "clean issue) but not enough to draw fine-grained statistical conclusions about " +
      "score thresholds.",
  );
  lines.push(
    "- **Capability gaps are not bugs.** The 'out-of-model-scope' fixtures above " +
      "surface real capability gaps (no maintainer-comment-sentiment signal, no " +
      "race-timing prediction) — these are candidates for future feature work, not " +
      "defects in the current scoring math.",
  );
  lines.push("");

  return lines.join("\n");
}
