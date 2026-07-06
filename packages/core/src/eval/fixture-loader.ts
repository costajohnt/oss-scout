/**
 * Vet eval — fixture loading + fixture-set hashing.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VetFixtureSchema, type VetFixture } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURES_DIR = path.join(
  __dirname,
  "..",
  "..",
  "eval",
  "fixtures",
  "vet",
);

/** Load and validate all fixtures from a directory (defaults to the real
 * fixture dir; tests pass a temp dir of synthetic fixtures instead). */
export function loadFixtures(dir: string = FIXTURES_DIR): VetFixture[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((f) => {
    const raw = readFileSync(path.join(dir, f), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return VetFixtureSchema.parse(parsed);
  });
}

/**
 * Stable hash over the fixture set's content (not just filenames) so a
 * report can cite exactly which fixture data it ran against — if any
 * fixture is edited/added/removed, the hash changes.
 */
export function fixtureSetHash(fixtures: VetFixture[]): string {
  const hash = createHash("sha256");
  for (const f of [...fixtures].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(f.id);
    hash.update(JSON.stringify(f));
  }
  return hash.digest("hex").slice(0, 12);
}

/** A fixed, representative subset for --quick mode: at least one fixture
 * per outcome label, capped small for fast iteration. */
export function quickSubset(fixtures: VetFixture[]): VetFixture[] {
  const seen = new Set<string>();
  const subset: VetFixture[] = [];
  for (const f of fixtures) {
    if (seen.has(f.outcome.label)) continue;
    seen.add(f.outcome.label);
    subset.push(f);
  }
  // Round out to ~10 fixtures total for a broader (but still fast) smoke
  // check, preferring ones not already included.
  for (const f of fixtures) {
    if (subset.length >= 10) break;
    if (!subset.includes(f)) subset.push(f);
  }
  return subset;
}
