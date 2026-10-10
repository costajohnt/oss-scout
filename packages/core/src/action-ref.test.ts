import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The composite action at the repo root is referenced from the docs by a git
// ref. release-please only creates component tags (core-vX.Y.Z,
// mcp-server-vX.Y.Z), so the documented ref must be the current core tag;
// release-please keeps it in sync through the x-release-please-version
// annotation (#354).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const coreVersion = (
  JSON.parse(
    readFileSync(resolve(repoRoot, "packages/core/package.json"), "utf8"),
  ) as {
    version: string;
  }
).version;

describe("documented GitHub Action ref", () => {
  it.each(["README.md", "examples/weekly-digest.yml"])(
    "%s references the current core release tag",
    (file) => {
      const text = readFileSync(resolve(repoRoot, file), "utf8");
      const refs = [
        ...text.matchAll(/uses:\s*costajohnt\/oss-scout@(\S+)/g),
      ].map((m) => m[1]);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(ref).toBe(`core-v${coreVersion}`);
      }
      for (const line of text
        .split("\n")
        .filter((l) => /uses:\s*costajohnt\/oss-scout@/.test(l))) {
        expect(line).toContain("x-release-please-version");
      }
    },
  );
});
