/**
 * Vet eval — fixture builder.
 *
 * One-off (re-runnable) script that merges the ground-truth manifest
 * (ground-truth.ts) with a live, READ-ONLY GitHub API fetch of each
 * issue's title/body/labels/state/timestamps and its repo's star/fork
 * counts, and writes the result to eval/fixtures/vet/<id>.json.
 *
 * Uses the `gh` CLI (already authenticated in this environment) rather
 * than a token, so nothing secret is read or printed. Makes no writes to
 * GitHub — issues/comments/PRs are only ever read.
 *
 * Run with: pnpm --filter @oss-scout/core exec tsx src/eval/build-fixtures.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GROUND_TRUTH } from "./ground-truth.js";
import { VetFixtureSchema, type VetFixture } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(
  __dirname,
  "..",
  "..",
  "eval",
  "fixtures",
  "vet",
);

interface GhIssue {
  title: string;
  body: string | null;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  labels: Array<string | { name?: string }>;
}

interface GhRepo {
  stargazers_count: number;
  forks_count: number;
}

function ghApiJson<T>(path: string): T {
  const out = execFileSync("gh", ["api", path], { encoding: "utf8" });
  return JSON.parse(out) as T;
}

function buildOne(entry: (typeof GROUND_TRUTH)[number]): VetFixture {
  const issue = ghApiJson<GhIssue>(
    `repos/${entry.owner}/${entry.repo}/issues/${entry.issueNumber}`,
  );
  const repoMeta = ghApiJson<GhRepo>(`repos/${entry.owner}/${entry.repo}`);

  const fixture: VetFixture = {
    id: entry.id,
    url: `https://github.com/${entry.owner}/${entry.repo}/issues/${entry.issueNumber}`,
    owner: entry.owner,
    repo: entry.repo,
    issueNumber: entry.issueNumber,
    vetDate: entry.vetDate,
    issue: {
      title: issue.title,
      body: issue.body ?? "",
      labels: issue.labels.map((l) =>
        typeof l === "string" ? l : (l.name ?? ""),
      ),
      state: issue.state,
      createdAt: issue.created_at,
      updatedAtObserved: issue.updated_at,
    },
    repoMeta: {
      stars: repoMeta.stargazers_count,
      forks: repoMeta.forks_count,
    },
    vetTimeFacts: entry.vetTimeFacts,
    outcome: entry.outcome,
    measurable: entry.measurable,
    expectedVerdict: entry.expectedVerdict,
    fidelityNote: entry.fidelityNote,
    vaultSource:
      "open-source/potential-issue-list.md, open-source/skipped-issues.md",
  };

  return VetFixtureSchema.parse(fixture);
}

function main(): void {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  let built = 0;
  for (const entry of GROUND_TRUTH) {
    process.stderr.write(`Building fixture ${entry.id}...\n`);
    const fixture = buildOne(entry);
    const outPath = path.join(FIXTURES_DIR, `${entry.id}.json`);
    writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");
    built++;
  }
  process.stderr.write(`Built ${built} fixtures in ${FIXTURES_DIR}\n`);
}

main();
