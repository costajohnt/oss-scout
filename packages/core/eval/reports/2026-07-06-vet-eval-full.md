# oss-scout vet eval — 2026-07-06

Model: oss-scout deterministic vet/scoring algorithm (`deriveRecommendation` + `calculateViabilityScore`, current `main`). No LLM in the default vet path — see "Honest limits" below for what this does and doesn't mean.
n: 1 run per fixture (deterministic — see "Why n=1" below). Mode: full. Fixtures: 30 (skip_correct=10, merged=12, maintainer_fixed=6, lost_race=2). Fixture-set hash: `dc01be45d9a9`.

## Verdict accuracy (measurable fixtures only)

Strict (recommendation exactly matches expected): 12/20 (60%). Lenient (counts "needs_review" as acceptable, not wrong — see finding below): 20/20 (100%). Wrong (confidently the opposite call): 0/20. Out of 30 total fixtures — the remaining 10 hinge on signals oss-scout's current vetter doesn't model (see "Out-of-model-scope fixtures" below) and are excluded from these rates rather than silently counted as passes or failures.

> **Finding:** 8/8 "should skip" fixtures landed on `needs_review` rather than a hard `skip`. `deriveRecommendation` (issue-vetting.ts) only emits `skip` when more than 2 reasonsToSkip accumulate — a single signal (existing PR *or* claimed, alone) downgrades to `needs_review` instead. Not wrong on its own (a human in the loop still catches it), but worth knowing for any automation that treats `recommendation !== "skip"` as "safe to proceed" rather than requiring `recommendation === "approve"` — that automation would auto-pursue every one of these correctly-flagged-but-not-hard-skipped cases.

| Fixture | Outcome | Expected | Recommendation | Score | Grade |
|---|---|---|---|---|---|
| activist-2084 | skip_correct | skip | needs_review | 79 | 🟡 cautious |
| backstage-8216 | merged | pursue | approve | 97 | ✅ correct |
| casa-6836 | skip_correct | skip | needs_review | 77 | 🟡 cautious |
| casa-6839 | skip_correct | skip | needs_review | 67 | 🟡 cautious |
| casa-6923 | merged | pursue | approve | 97 | ✅ correct |
| casa-6948 | merged | pursue | approve | 97 | ✅ correct |
| dioxus-5477 | merged | pursue | approve | 92 | ✅ correct |
| directus-27091 | skip_correct | skip | needs_review | 72 | 🟡 cautious |
| graphite-4011 | skip_correct | skip | needs_review | 62 | 🟡 cautious |
| near-cli-rs-581 | skip_correct | skip | needs_review | 55 | 🟡 cautious |
| pg-clickhouse-167 | skip_correct | skip | needs_review | 63 | 🟡 cautious |
| react-spectrum-9916 | merged | pursue | approve | 100 | ✅ correct |
| super-productivity-7188 | merged | pursue | approve | 100 | ✅ correct |
| super-productivity-7191 | merged | pursue | approve | 100 | ✅ correct |
| super-productivity-7219 | merged | pursue | approve | 100 | ✅ correct |
| super-productivity-7674 | merged | pursue | approve | 100 | ✅ correct |
| super-productivity-7785 | merged | pursue | approve | 100 | ✅ correct |
| super-productivity-7786 | merged | pursue | approve | 100 | ✅ correct |
| super-productivity-8220 | merged | pursue | approve | 100 | ✅ correct |
| tubesync-1446 | skip_correct | skip | needs_review | 57 | 🟡 cautious |

## Out-of-model-scope fixtures (reported, not scored)

These outcomes hinge on race timing, maintainer self-fix behavior, or feasibility/business judgment that oss-scout's current deterministic checks don't attempt to predict. Shown so the tool's output is visible on these cases without pretending the verdict was 'graded'.

| Fixture | Outcome | Recommendation | Score | Why unmeasurable |
|---|---|---|---|---|
| eslint-plugin-unicorn-3091 | maintainer_fixed | approve | 90 | The maintainer had already posted the exact fix in a thread comment before this vet — a 'maintainer recently commented with a concrete fix sketch' heuristic could plausibly catch this class, but oss-scout's vetter does not read/analyze comment bodies for that signal today. |
| homebrew-21892 | skip_correct | approve | 100 | The skip reason is 'can't verify a fix works without infra John doesn't have' — a feasibility judgment, not something hasExistingPR/isClaimed/projectActive/clearRequirements models. |
| homebrew-22206 | lost_race | approve | 100 | hasExistingPR=false is the CORRECT vet-time snapshot (no PR existed yet when John vetted/started); the competing PR was opened and merged entirely within John's build window. |
| homebrew-22672 | maintainer_fixed | approve | 87 | closedWithoutMergeCount=1 reflects the real prior history: John's #22225 (see homebrew-22206 fixture) had closed without merging a month earlier in this same repo, so calculateViabilityScore's -15 closed-without-merge penalty legitimately applies here even though mergedPRCount=0. |
| nautilus-trader-4096 | maintainer_fixed | approve | 100 | Not a self-fix in the same sense as the super-productivity cases — maintainer solved a related-but-different root cause and declined the Cython-path fix as legacy. |
| open-design-5081 | lost_race | approve | 100 | Race timing is not observable from a point-in-time vet snapshot — oss-scout has no signal for 'a competing contributor is about to claim this in the next N minutes'. |
| super-productivity-8232 | maintainer_fixed | approve | 100 | Same pattern as #8233, same vet round. |
| super-productivity-8233 | maintainer_fixed | approve | 100 | Maintainer-filed issue, self-fixed same day — no existing PR/claim visible at vet time. |
| super-productivity-8275 | skip_correct | approve | 100 | The right call here required actually reproducing the reported behavior end-to-end against a live server, not something derivable from the issue text/labels/repo metadata oss-scout's vetter reads. |
| super-productivity-8651 | maintainer_fixed | approve | 100 | No visible existing PR/claim at vet time even after the fact (GitHub never cross-referenced #8630 to this issue) — a comment-content or cross-issue-similarity signal would be needed to catch this, which oss-scout does not implement. |

## Score calibration

Average current `calculateViabilityScore` output per realized outcome (across ALL fixtures, measurable or not) — a well-calibrated scorer should rank merged > lost_race/maintainer_fixed > skip_correct, since the first three are all 'pursue was the right call' outcomes and only differ in execution/luck, while skip_correct issues should score lower.

| Outcome | n | Avg score | Pursued rate |
|---|---|---|---|
| skip_correct | 10 | 73.2 | 100% |
| merged | 12 | 98.6 | 100% |
| maintainer_fixed | 6 | 96.2 | 100% |
| lost_race | 2 | 100.0 | 100% |

## Why n=1

oss-scout's default vet path (`deriveRecommendation` + `calculateViabilityScore` + `analyzeRequirements`) is pure, deterministic TypeScript — no LLM call, no sampling, so repeated runs against the same fixture always produce the same output. Running n>1 here would only prove the functions are pure (already true by inspection), not measure anything about judgment quality. The one place a model actually runs is the OPTIONAL SLM pre-triage pass (Ollama, local-only, off by default) — pass `--slm <model>` to additionally measure ITS run-to-run stability across n repeats; that path is not exercised by this report.

## Honest limits

- **Survivorship bias.** These are issues John already chose to investigate, not a random sample of all GitHub issues — they skew toward things that looked promising enough to spend time on. This eval measures 'given John's existing funnel, does the current vetter's verdict/score line up with what happened', not 'how good is the vetter at cold-sourcing.'
- **Outcome conflation.** `merged` vs `lost_race` vs `maintainer_fixed` mostly reflect execution speed and luck (who else was watching the same issue, how fast John built and pushed), not vet quality — all three started from a reasonable 'pursue' call. Treating lost_race/maintainer_fixed as vetting failures would overstate what a smarter vetter could realistically prevent.
- **Reconstruction fidelity.** `vetTimeFacts` (existing-PR/claimed/project-active/merged-PR-count) are hand-derived from John's own vetting notes recorded at the time, not re-derived from a time-traveled GitHub API call — GitHub's search and timeline APIs can't be queried as of a past date. Issue title/body/labels/repo star-fork counts ARE live API reads, but reflect state as of fixture-build time (2026-07-05), which can differ slightly from vet-time if the issue was edited or the repo grew. Each fixture's `fidelityNote` documents this per-case.
- **Small N, single fixture-set.** 30 fixtures is enough to catch a gross regression (e.g. a recommendation-logic change that starts skipping every clean issue) but not enough to draw fine-grained statistical conclusions about score thresholds.
- **Capability gaps are not bugs.** The 'out-of-model-scope' fixtures above surface real capability gaps (no maintainer-comment-sentiment signal, no race-timing prediction) — these are candidates for future feature work, not defects in the current scoring math.
