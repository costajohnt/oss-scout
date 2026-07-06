# Vet eval fixtures

30 historical GitHub issues from John's OSS-pipeline notes
(`~/dev/obsidian-vault/open-source/potential-issue-list.md` and
`skipped-issues.md`), each with a realized outcome recorded later:
`merged`, `lost_race`, `maintainer_fixed`, or `skip_correct`.

## How these were built

1. **Ground truth** (`../../src/eval/ground-truth.ts`): for each issue, the
   `vetTimeFacts` (existing-PR / claimed / project-active / merged-PR-count
   / etc.) are hand-derived from the vault's own vetting-time notes — the
   vault records these checks in prose at the time each issue was actually
   vetted. This can't be re-derived from a live API call because GitHub's
   search and timeline APIs cannot be queried as of a past date.
2. **Objective facts** (`../../src/eval/build-fixtures.ts`): issue
   title/body/labels/state/timestamps and repo star/fork counts are fetched
   live via the `gh` CLI (read-only, no writes, no posting). These reflect
   state as of the fixture-build date (2026-07-05), which can differ
   slightly from vet-time state if an issue was edited or a repo grew.
3. **Outcome verification**: every merge/close status cited in `outcome`
   was independently re-verified against the live GitHub API on 2026-07-05
   (`gh api repos/<owner>/<repo>/pulls/<n>` for `merged`/`merged_at`,
   `gh api repos/<owner>/<repo>/issues/<n>` for `state`/`state_reason`) —
   not just trusted from vault prose.

Each fixture's `fidelityNote` documents the specific provenance and any
known reconstruction gaps for that case. `measurable: false` fixtures are
run and reported but excluded from the headline verdict-accuracy score —
see `docs/plans/fleet-evals-design.md` and the PR description for why
(their outcomes hinge on race timing / maintainer behavior / feasibility
judgment that oss-scout's current deterministic checks don't attempt to
predict).

## Regenerating

```
pnpm --filter @oss-scout/core run eval:vet:build-fixtures
```

This re-fetches the objective (title/body/labels/repo metadata) fields
live but leaves `vetTimeFacts`/`outcome`/`measurable`/`expectedVerdict`
untouched (those come from `ground-truth.ts`, edited by hand). Re-run
only if you want to refresh drift in issue bodies/repo stats, or after
editing `ground-truth.ts` to add/change a fixture.
