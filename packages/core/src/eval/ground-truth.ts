/**
 * Vet eval — ground-truth manifest.
 *
 * 30 historical issues pulled from John's OSS-pipeline notes
 * (~/dev/obsidian-vault/open-source/potential-issue-list.md and
 * skipped-issues.md), each with a realized outcome. `vetTimeFacts` are
 * hand-derived from the vault's own vetting-time notes (the vault records
 * the existing-PR/claimed/project-active/merged-PR-count checks in prose
 * at the time each issue was vetted); `issue`/`repoMeta` fields are filled
 * in by build-fixtures.ts from a live (read-only) GitHub API fetch.
 *
 * Every merge status cited in `outcome` was independently re-verified
 * against the live GitHub API on 2026-07-05 (not just trusted from vault
 * prose) — see the PR description for the verification commands.
 */
import type { OutcomeLabel, VetTimeFacts } from "./types.js";

export interface ManifestEntry {
  id: string;
  owner: string;
  repo: string;
  issueNumber: number;
  vetDate: string;
  vetTimeFacts: VetTimeFacts;
  outcome: {
    label: OutcomeLabel;
    date: string;
    detail: string;
    prUrl?: string;
  };
  measurable: boolean;
  expectedVerdict: "pursue" | "skip";
  fidelityNote: string;
}

const noHistory: Pick<
  VetTimeFacts,
  "mergedPRCount" | "orgHasMergedPRs" | "closedWithoutMergeCount"
> = {
  mergedPRCount: 0,
  orgHasMergedPRs: false,
  closedWithoutMergeCount: 0,
};

const established: Pick<
  VetTimeFacts,
  "mergedPRCount" | "orgHasMergedPRs" | "closedWithoutMergeCount"
> = {
  mergedPRCount: 1,
  orgHasMergedPRs: false,
  closedWithoutMergeCount: 0,
};

export const GROUND_TRUTH: ManifestEntry[] = [
  // ---------------------------------------------------------------------
  // MERGED — PURSUE tier that converted. oss-scout's current checks
  // (no existing PR, not claimed, active project, clear requirements)
  // are exactly what should say "approve" here.
  // ---------------------------------------------------------------------
  {
    id: "casa-6923",
    owner: "rubyforgood",
    repo: "casa",
    issueNumber: 6923,
    vetDate: "2026-06-09",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "merged",
      date: "2026-06-10",
      detail: "PR #6990 merged 2026-06-10 (verified live: merged=true)",
      prUrl: "https://github.com/rubyforgood/casa/pull/6990",
    },
    measurable: true,
    expectedVerdict: "pursue",
    fidelityNote:
      "vetTimeFacts from potential-issue-list.md: 'Score 8/10 — PR OPEN', fully available/unclaimed at vet time, first PR John opened in this repo (mergedPRCount=0).",
  },
  {
    id: "casa-6948",
    owner: "rubyforgood",
    repo: "casa",
    issueNumber: 6948,
    vetDate: "2026-06-09",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "merged",
      date: "2026-06-10",
      detail: "PR #6991 merged 2026-06-10 (verified live: merged=true)",
      prUrl: "https://github.com/rubyforgood/casa/pull/6991",
    },
    measurable: true,
    expectedVerdict: "pursue",
    fidelityNote:
      "vault notes: prior claimant (andoq) auto-unassigned 15d before this vet for inactivity, so isClaimed=false at vet time. Same-day vet as #6923 (mergedPRCount=0 for both).",
  },
  {
    id: "super-productivity-7785",
    owner: "super-productivity",
    repo: "super-productivity",
    issueNumber: 7785,
    vetDate: "2026-05-25",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...established,
    },
    outcome: {
      label: "merged",
      date: "2026-05-26",
      detail: "PR #7792 merged 2026-05-26 (verified live: merged=true)",
      prUrl:
        "https://github.com/super-productivity/super-productivity/pull/7792",
    },
    measurable: true,
    expectedVerdict: "pursue",
    fidelityNote:
      "By this vet date John had several earlier merged PRs in this repo (#7211/#7220/#7222 all landed in April), so mergedPRCount treated as established (>0).",
  },
  {
    id: "super-productivity-7786",
    owner: "super-productivity",
    repo: "super-productivity",
    issueNumber: 7786,
    vetDate: "2026-05-25",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...established,
    },
    outcome: {
      label: "merged",
      date: "2026-05-26",
      detail: "PR #7793 merged 2026-05-26 (verified live: merged=true)",
      prUrl:
        "https://github.com/super-productivity/super-productivity/pull/7793",
    },
    measurable: true,
    expectedVerdict: "pursue",
    fidelityNote: "Same vet round as #7785, same repo/history facts.",
  },
  {
    id: "super-productivity-8220",
    owner: "super-productivity",
    repo: "super-productivity",
    issueNumber: 8220,
    vetDate: "2026-06-09",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...established,
    },
    outcome: {
      label: "merged",
      date: "2026-06-09",
      detail:
        "PR #8229 merged same day, 2026-06-09 (verified live: merged=true)",
      prUrl:
        "https://github.com/super-productivity/super-productivity/pull/8229",
    },
    measurable: true,
    expectedVerdict: "pursue",
    fidelityNote: "Fast same-day merge; established repo history by now.",
  },
  {
    id: "super-productivity-7674",
    owner: "super-productivity",
    repo: "super-productivity",
    issueNumber: 7674,
    vetDate: "2026-06-09",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...established,
    },
    outcome: {
      label: "merged",
      date: "2026-06-22",
      detail:
        "PR #8516 merged 2026-06-22 after a comment-first scoping round " +
        "(verified live: merged=true)",
      prUrl:
        "https://github.com/super-productivity/super-productivity/pull/8516",
    },
    measurable: true,
    expectedVerdict: "pursue",
    fidelityNote:
      "Interesting calibration case: the issue body floats 3 mutually-exclusive designs (unclear scope at face value), so analyzeRequirements(body) may legitimately score clearRequirements=false. The eventual merge only happened because John scoped it with a comment before writing code, not from the raw issue alone — a good illustration that 'needs_review' can be the MORE honest verdict than a clean approve/skip binary for this one.",
  },
  {
    id: "super-productivity-7219",
    owner: "super-productivity",
    repo: "super-productivity",
    issueNumber: 7219,
    vetDate: "2026-04-13",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "merged",
      date: "2026-04-16",
      detail: "PR #7222 merged 2026-04-16 (verified live: merged=true)",
      prUrl:
        "https://github.com/super-productivity/super-productivity/pull/7222",
    },
    measurable: true,
    expectedVerdict: "pursue",
    fidelityNote:
      "One of John's earliest contributions to this repo — no prior merged/closed PR history yet (mergedPRCount=0), unlike the June entries above.",
  },
  {
    id: "super-productivity-7188",
    owner: "super-productivity",
    repo: "super-productivity",
    issueNumber: 7188,
    vetDate: "2026-04-12",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "merged",
      date: "2026-04-13",
      detail: "PR #7211 merged 2026-04-13 (verified live: merged=true)",
      prUrl:
        "https://github.com/super-productivity/super-productivity/pull/7211",
    },
    measurable: true,
    expectedVerdict: "pursue",
    fidelityNote: "Cold-start in this repo, same as #7219/#7191.",
  },
  {
    id: "super-productivity-7191",
    owner: "super-productivity",
    repo: "super-productivity",
    issueNumber: 7191,
    vetDate: "2026-04-12",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "merged",
      date: "2026-04-19",
      detail: "PR #7220 merged 2026-04-19 (verified live: merged=true)",
      prUrl:
        "https://github.com/super-productivity/super-productivity/pull/7220",
    },
    measurable: true,
    expectedVerdict: "pursue",
    fidelityNote: "Cold-start in this repo, same as #7219/#7188.",
  },
  {
    id: "react-spectrum-9916",
    owner: "adobe",
    repo: "react-spectrum",
    issueNumber: 9916,
    vetDate: "2026-04-12",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "merged",
      date: "2026-06-25",
      detail:
        "PR #9924 merged 2026-06-25, a much longer review cycle than most " +
        "(verified live: merged=true)",
      prUrl: "https://github.com/adobe/react-spectrum/pull/9924",
    },
    measurable: true,
    expectedVerdict: "pursue",
    fidelityNote:
      "Merge landed >2 months after vet/PR-open — long enterprise-repo review latency, unrelated to vet quality.",
  },
  {
    id: "dioxus-5477",
    owner: "DioxusLabs",
    repo: "dioxus",
    issueNumber: 5477,
    vetDate: "2026-04-12",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: false,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "merged",
      date: "2026-04-14",
      detail: "PR #5481 merged 2026-04-14 (verified live: merged=true)",
      prUrl: "https://github.com/DioxusLabs/dioxus/pull/5481",
    },
    measurable: true,
    expectedVerdict: "pursue",
    fidelityNote:
      "No CONTRIBUTING.md found at any of the 4 probed paths (checked live 2026-07-05) — contributionGuidelinesFound=false is a real repo characteristic, not a fixture gap.",
  },
  {
    id: "backstage-8216",
    owner: "backstage",
    repo: "community-plugins",
    issueNumber: 8216,
    vetDate: "2026-04-12",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "merged",
      date: "2026-07-03",
      detail:
        "PR #8547 merged 2026-07-03 — an unusually long ~3 month review " +
        "cycle (verified live: merged=true)",
      prUrl: "https://github.com/backstage/community-plugins/pull/8547",
    },
    measurable: true,
    expectedVerdict: "pursue",
    fidelityNote:
      "Longest merge latency in this fixture set; included deliberately so the report's calibration section isn't only fast-merge success stories.",
  },

  // ---------------------------------------------------------------------
  // LOST_RACE — pursuing was the right call; a competitor won on timing.
  // Not measurable: nothing in oss-scout's vet-time snapshot could have
  // predicted a competing contributor's timing.
  // ---------------------------------------------------------------------
  {
    id: "open-design-5081",
    owner: "nexu-io",
    repo: "open-design",
    issueNumber: 5081,
    vetDate: "2026-07-02",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...established,
    },
    outcome: {
      label: "lost_race",
      date: "2026-07-02",
      detail:
        "Another contributor claimed + opened an identical-fix PR (#5085) " +
        "while John's clone was still downloading; John's finished, " +
        "review-gated fix was never pushed (zero external footprint).",
    },
    measurable: false,
    expectedVerdict: "pursue",
    fidelityNote:
      "Race timing is not observable from a point-in-time vet snapshot — oss-scout has no signal for 'a competing contributor is about to claim this in the next N minutes'. Excluded from headline accuracy; reported in the lost-race appendix.",
  },
  {
    id: "homebrew-22206",
    owner: "Homebrew",
    repo: "brew",
    issueNumber: 22206,
    vetDate: "2026-05-10",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "lost_race",
      date: "2026-05-10",
      detail:
        "John's PR #22225 (opened 2026-05-10) was closed by the maintainer " +
        "as a duplicate: PR #22211 by another contributor had merged ~9h " +
        "earlier (verified live: #22211 merged=true, #22225 merged=false). " +
        "The 'no other open PRs' check passed vacuously because #22211 was " +
        "no longer open by the time John's PR was opened.",
      prUrl: "https://github.com/Homebrew/brew/pull/22225",
    },
    measurable: false,
    expectedVerdict: "pursue",
    fidelityNote:
      "hasExistingPR=false is the CORRECT vet-time snapshot (no PR existed yet when John vetted/started); the competing PR was opened and merged entirely within John's build window. This is exactly the class of miss a snapshot-based existing-PR check structurally cannot catch — a fresh recheck immediately before push (which the vault's CLAUDE.md now mandates) is the real fix, not a vetting change.",
  },

  // ---------------------------------------------------------------------
  // MAINTAINER_FIXED — pursuing was reasonable; the maintainer shipped
  // their own fix first. Not measurable: oss-scout has no
  // maintainer-comment-sentiment or self-fix-risk signal today.
  // ---------------------------------------------------------------------
  {
    id: "super-productivity-8651",
    owner: "super-productivity",
    repo: "super-productivity",
    issueNumber: 8651,
    vetDate: "2026-06-30",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...established,
    },
    outcome: {
      label: "maintainer_fixed",
      date: "2026-07-02",
      detail:
        "Maintainer johannesjo fixed the underlying regression via #8630 " +
        "(against a sibling issue) and shipped 18.13.0; #8651 itself was " +
        "never cross-referenced (verified live: PR #8630 merged=true).",
    },
    measurable: false,
    expectedVerdict: "pursue",
    fidelityNote:
      "No visible existing PR/claim at vet time even after the fact (GitHub never cross-referenced #8630 to this issue) — a comment-content or cross-issue-similarity signal would be needed to catch this, which oss-scout does not implement.",
  },
  {
    id: "eslint-plugin-unicorn-3091",
    owner: "sindresorhus",
    repo: "eslint-plugin-unicorn",
    issueNumber: 3091,
    vetDate: "2026-06-11",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: false,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "maintainer_fixed",
      date: "2026-06-11",
      detail:
        "Maintainer (Sindre) merged his own PR #3117 same day, ~9h after " +
        "sketching the fix in a comment (verified live: merged=true).",
      prUrl: "https://github.com/sindresorhus/eslint-plugin-unicorn/pull/3117",
    },
    measurable: false,
    expectedVerdict: "pursue",
    fidelityNote:
      "The maintainer had already posted the exact fix in a thread comment before this vet — a 'maintainer recently commented with a concrete fix sketch' heuristic could plausibly catch this class, but oss-scout's vetter does not read/analyze comment bodies for that signal today. Flagged as a future-feature candidate in the report, not scored as a miss.",
  },
  {
    id: "homebrew-22672",
    owner: "Homebrew",
    repo: "brew",
    issueNumber: 22672,
    vetDate: "2026-06-11",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      mergedPRCount: 0,
      orgHasMergedPRs: false,
      closedWithoutMergeCount: 1,
    },
    outcome: {
      label: "maintainer_fixed",
      date: "2026-06-12",
      detail:
        "Maintainer swept/closed the issue as completed within the 24-48h " +
        "window flagged at vet time (verified live: state=closed, " +
        "state_reason=completed).",
    },
    measurable: false,
    expectedVerdict: "pursue",
    fidelityNote:
      "closedWithoutMergeCount=1 reflects the real prior history: John's #22225 (see homebrew-22206 fixture) had closed without merging a month earlier in this same repo, so calculateViabilityScore's -15 closed-without-merge penalty legitimately applies here even though mergedPRCount=0.",
  },
  {
    id: "super-productivity-8233",
    owner: "super-productivity",
    repo: "super-productivity",
    issueNumber: 8233,
    vetDate: "2026-06-09",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...established,
    },
    outcome: {
      label: "maintainer_fixed",
      date: "2026-06-09",
      detail:
        "Maintainer johannesjo merged his own PR #8235 same day, ~few " +
        "hours after filing the issue (verified live: merged=true).",
      prUrl:
        "https://github.com/super-productivity/super-productivity/pull/8235",
    },
    measurable: false,
    expectedVerdict: "pursue",
    fidelityNote:
      "Maintainer-filed issue, self-fixed same day — no existing PR/claim visible at vet time.",
  },
  {
    id: "super-productivity-8232",
    owner: "super-productivity",
    repo: "super-productivity",
    issueNumber: 8232,
    vetDate: "2026-06-09",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...established,
    },
    outcome: {
      label: "maintainer_fixed",
      date: "2026-06-09",
      detail:
        "Maintainer johannesjo merged his own PR #8236 same day, an " +
        "identical fix to the one John had already built locally " +
        "(verified live: merged=true).",
      prUrl:
        "https://github.com/super-productivity/super-productivity/pull/8236",
    },
    measurable: false,
    expectedVerdict: "pursue",
    fidelityNote: "Same pattern as #8233, same vet round.",
  },
  {
    id: "nautilus-trader-4096",
    owner: "nautechsystems",
    repo: "nautilus_trader",
    issueNumber: 4096,
    vetDate: "2026-05-19",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "maintainer_fixed",
      date: "2026-05-19",
      detail:
        "Maintainer closed the issue NOT_PLANNED same day, having fixed " +
        "the underlying problem differently on the Rust data-engine path " +
        "(verified live: state=closed, state_reason=not_planned).",
    },
    measurable: false,
    expectedVerdict: "pursue",
    fidelityNote:
      "Not a self-fix in the same sense as the super-productivity cases — maintainer solved a related-but-different root cause and declined the Cython-path fix as legacy. Bucketed as maintainer_fixed because the practical effect (John's ready fix was never pushed) is the same.",
  },

  // ---------------------------------------------------------------------
  // SKIP_CORRECT — correctly not pursued. Split: 8 map cleanly onto
  // existing-PR/claimed checks oss-scout already runs (measurable); 2
  // hinge on judgment calls the vetter doesn't attempt (not measurable).
  // ---------------------------------------------------------------------
  {
    id: "casa-6839",
    owner: "rubyforgood",
    repo: "casa",
    issueNumber: 6839,
    vetDate: "2026-04-12",
    vetTimeFacts: {
      hasExistingPR: true,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "skip_correct",
      date: "2026-04-12",
      detail:
        "Skipped: competing PR #6844 was already open at vet time " +
        "(verified live: #6844 merged=true, so the skip was also right in " +
        "hindsight).",
      prUrl: "https://github.com/rubyforgood/casa/pull/6844",
    },
    measurable: true,
    expectedVerdict: "skip",
    fidelityNote:
      "hasExistingPR=true directly matches the vault note ('Taken: competing PR #6844 open') — exactly the checkNoExistingPR signal oss-scout's vetter runs today.",
  },
  {
    id: "casa-6836",
    owner: "rubyforgood",
    repo: "casa",
    issueNumber: 6836,
    vetDate: "2026-04-12",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: true,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "skip_correct",
      date: "2026-04-12",
      detail:
        "Skipped: issue assigned to @cliftonmcintosh at vet time " +
        "(verified live: assignee still on the closed issue).",
    },
    measurable: true,
    expectedVerdict: "skip",
    fidelityNote: "isClaimed=true matches checkNotClaimed's assignee check.",
  },
  {
    id: "activist-2084",
    owner: "activist-org",
    repo: "activist",
    issueNumber: 2084,
    vetDate: "2026-04-12",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: true,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "skip_correct",
      date: "2026-04-12",
      detail:
        "Skipped: issue assigned to @sh-ran at vet time (verified live: " +
        "assignee still on the closed issue).",
    },
    measurable: true,
    expectedVerdict: "skip",
    fidelityNote: "isClaimed=true matches checkNotClaimed's assignee check.",
  },
  {
    id: "directus-27091",
    owner: "directus",
    repo: "directus",
    issueNumber: 27091,
    vetDate: "2026-04-12",
    vetTimeFacts: {
      hasExistingPR: true,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "skip_correct",
      date: "2026-04-12",
      detail:
        "Skipped: competing PR #27099 already open at vet time (verified " +
        "live: #27099 state=closed, merged=false — it didn't land either, " +
        "but the skip decision was correct given what was visible then).",
      prUrl: "https://github.com/directus/directus/pull/27099",
    },
    measurable: true,
    expectedVerdict: "skip",
    fidelityNote:
      "hasExistingPR=true matches checkNoExistingPR. Included even though the competing PR itself never merged, to test that the vetter correctly treats 'has a competing PR' as a skip signal regardless of that PR's eventual fate.",
  },
  {
    id: "graphite-4011",
    owner: "GraphiteEditor",
    repo: "Graphite",
    issueNumber: 4011,
    vetDate: "2026-04-12",
    vetTimeFacts: {
      hasExistingPR: true,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: false,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "skip_correct",
      date: "2026-04-12",
      detail:
        "Skipped: competing PR #4025 open at vet time (verified live: " +
        "issue and PR both still open as of 2026-07-05).",
      prUrl: "https://github.com/GraphiteEditor/Graphite/pull/4025",
    },
    measurable: true,
    expectedVerdict: "skip",
    fidelityNote: "hasExistingPR=true matches checkNoExistingPR.",
  },
  {
    id: "tubesync-1446",
    owner: "meeb",
    repo: "tubesync",
    issueNumber: 1446,
    vetDate: "2026-04-12",
    vetTimeFacts: {
      hasExistingPR: true,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: false,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "skip_correct",
      date: "2026-04-12",
      detail:
        "Skipped: competing PR #1447 open at vet time (verified live: " +
        "#1447 merged=true).",
      prUrl: "https://github.com/meeb/tubesync/pull/1447",
    },
    measurable: true,
    expectedVerdict: "skip",
    fidelityNote: "hasExistingPR=true matches checkNoExistingPR.",
  },
  {
    id: "near-cli-rs-581",
    owner: "near",
    repo: "near-cli-rs",
    issueNumber: 581,
    vetDate: "2026-04-04",
    vetTimeFacts: {
      hasExistingPR: true,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: false,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "skip_correct",
      date: "2026-04-04",
      detail:
        "Skipped: competing PR #582 already under review at vet time " +
        "(verified live: #582 merged=true).",
      prUrl: "https://github.com/near/near-cli-rs/pull/582",
    },
    measurable: true,
    expectedVerdict: "skip",
    fidelityNote: "hasExistingPR=true matches checkNoExistingPR.",
  },
  {
    id: "pg-clickhouse-167",
    owner: "ClickHouse",
    repo: "pg_clickhouse",
    issueNumber: 167,
    vetDate: "2026-04-12",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: true,
      projectActive: true,
      contributionGuidelinesFound: false,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "skip_correct",
      date: "2026-04-12",
      detail:
        "Skipped: issue assigned to @serprex at vet time (verified live: " +
        "assignee still on the closed issue).",
    },
    measurable: true,
    expectedVerdict: "skip",
    fidelityNote: "isClaimed=true matches checkNotClaimed's assignee check.",
  },
  {
    id: "homebrew-21892",
    owner: "Homebrew",
    repo: "brew",
    issueNumber: 21892,
    vetDate: "2026-04-04",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...noHistory,
    },
    outcome: {
      label: "skip_correct",
      date: "2026-04-04",
      detail:
        "Skipped: could not be reproduced or verified end-to-end without " +
        "a private artifact host (verified live: state_reason=completed — " +
        "someone else eventually resolved it upstream).",
    },
    measurable: false,
    expectedVerdict: "skip",
    fidelityNote:
      "The skip reason is 'can't verify a fix works without infra John doesn't have' — a feasibility judgment, not something hasExistingPR/isClaimed/projectActive/clearRequirements models. Reported, not scored.",
  },
  {
    id: "super-productivity-8275",
    owner: "super-productivity",
    repo: "super-productivity",
    issueNumber: 8275,
    vetDate: "2026-06-12",
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      matchesPreferredCategory: false,
      ...established,
    },
    outcome: {
      label: "skip_correct",
      date: "2026-06-12",
      detail:
        "Skipped after deep investigation found it wasn't a code bug at " +
        "all — a config trap (an auto-import setting defaulting off), not " +
        "a defect in the sync code path.",
    },
    measurable: false,
    expectedVerdict: "skip",
    fidelityNote:
      "The right call here required actually reproducing the reported behavior end-to-end against a live server, not something derivable from the issue text/labels/repo metadata oss-scout's vetter reads. clearRequirements will likely score true (the bug report itself is clear and detailed) even though the correct verdict was 'skip, not a bug' — a good illustration of why this fixture is unmeasurable by the current feature set.",
  },
];
