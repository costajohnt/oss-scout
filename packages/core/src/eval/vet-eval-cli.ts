#!/usr/bin/env node
/**
 * Vet eval — CLI entry point.
 *
 * Usage:
 *   tsx src/eval/vet-eval-cli.ts --quick          # fast subset, smoke check
 *   tsx src/eval/vet-eval-cli.ts --full            # all fixtures (default)
 *   tsx src/eval/vet-eval-cli.ts --full --slm <model>  # also measure SLM
 *       pre-triage stability (n repeats per fixture); requires a local
 *       Ollama instance with <model> pulled. Runs locally only, never in CI.
 *
 * Writes a dated markdown report to eval/reports/ and prints its path.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { triageWithSLM } from "../core/slm-triage.js";
import {
  FIXTURES_DIR,
  fixtureSetHash,
  loadFixtures,
  quickSubset,
} from "./fixture-loader.js";
import { buildReport } from "./report.js";
import { runFixture, summarize } from "./vet-eval.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(__dirname, "..", "..", "eval", "reports");

interface CliOptions {
  mode: "quick" | "full";
  slmModel: string | null;
  slmRuns: number;
}

function parseArgs(argv: string[]): CliOptions {
  const mode = argv.includes("--quick") ? "quick" : "full";
  const slmIdx = argv.indexOf("--slm");
  const slmModel = slmIdx >= 0 ? (argv[slmIdx + 1] ?? null) : null;
  const runsIdx = argv.indexOf("--slm-runs");
  const slmRuns = runsIdx >= 0 ? Number(argv[runsIdx + 1]) : 5;
  return { mode, slmModel, slmRuns };
}

async function runSlmStability(
  model: string,
  runs: number,
  fixtures: ReturnType<typeof loadFixtures>,
): Promise<string> {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `## SLM pre-triage stability (model: ${model}, n=${runs}, local Ollama)`,
  );
  lines.push("");
  lines.push("| Fixture | Decisions across n runs | Agreement rate |");
  lines.push("|---|---|---|");

  let reachable = true;
  for (const fixture of fixtures) {
    const decisions: string[] = [];
    for (let i = 0; i < runs; i++) {
      const result = await triageWithSLM(
        {
          issue: {
            title: fixture.issue.title,
            labels: fixture.issue.labels,
            body: fixture.issue.body,
          },
          linkedPRExists: fixture.vetTimeFacts.hasExistingPR,
        },
        { model },
      );
      if (result === null) {
        reachable = false;
        break;
      }
      decisions.push(result.decision);
    }
    if (!reachable) break;
    const modeCount = Math.max(
      ...Object.values(
        decisions.reduce<Record<string, number>>((acc, d) => {
          acc[d] = (acc[d] ?? 0) + 1;
          return acc;
        }, {}),
      ),
    );
    lines.push(
      `| ${fixture.id} | ${decisions.join(", ")} | ${((modeCount / runs) * 100).toFixed(0)}% |`,
    );
  }

  if (!reachable) {
    return (
      "\n## SLM pre-triage stability\n\n" +
      `Could not reach Ollama at the default host with model \`${model}\` — ` +
      "skipping SLM stability measurement rather than reporting fabricated numbers. " +
      "Start Ollama locally (`ollama pull <model>` + `ollama serve`) and re-run with " +
      "`--slm <model>` to measure it.\n"
    );
  }
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const allFixtures = loadFixtures(FIXTURES_DIR);
  const fixtures =
    opts.mode === "quick" ? quickSubset(allFixtures) : allFixtures;

  const results = fixtures.map((f) => runFixture(f));
  const summary = summarize(results);

  const date = new Date().toISOString().slice(0, 10);
  let report = buildReport(summary, {
    date,
    mode: opts.mode,
    fixtureCount: fixtures.length,
    fixtureSetHash: fixtureSetHash(fixtures),
  });

  if (opts.slmModel) {
    report += await runSlmStability(opts.slmModel, opts.slmRuns, fixtures);
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = path.join(REPORTS_DIR, `${date}-vet-eval-${opts.mode}.md`);
  writeFileSync(outPath, report);

  process.stdout.write(report);
  process.stdout.write(`\nReport written to ${outPath}\n`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
