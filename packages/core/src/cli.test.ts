import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * CLI smoke tests (#160).
 *
 * The old cli.test.ts never imported ./cli.js — it re-implemented
 * handleCommandError inside the test body and ran typeof checks on other
 * modules, so it could not fail. These tests instead run the real CLI as a
 * child process (via the local tsx binary against the TS source, so no build
 * step is required) and assert on exit codes and stdout, exercising argv
 * parsing, command dispatch, handleCommandError, and the --json contract.
 */

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const tsxBin = fileURLToPath(
  new URL("../node_modules/.bin/tsx", import.meta.url),
);

let homeDir: string;

beforeAll(() => {
  // Point HOME at an empty dir so the CLI reads default preferences and never
  // touches the developer's real ~/.oss-scout state.
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-scout-cli-test-"));
});

afterAll(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

function runCli(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(tsxBin, [cliPath, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      GITHUB_TOKEN: "",
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("oss-scout CLI", () => {
  it("prints usage for --help and exits 0", () => {
    const { status, stdout } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("oss-scout");
    expect(stdout).toContain("config");
  }, 30000);

  it("prints a version for --version and exits 0", () => {
    const { status, stdout } = runCli(["--version"]);
    expect(status).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 30000);

  it("config --json emits a success envelope and exits 0", () => {
    const { status, stdout } = runCli(["config", "--json"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toBeDefined();
  }, 30000);

  it("surfaces a ValidationError as a --json error envelope with exit 1", () => {
    const { status, stdout } = runCli(["search", "abc", "--json"]);
    expect(status).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.errorCode).toBe("VALIDATION");
  }, 30000);

  it("rejects a malformed issue URL on skip add (--json error, exit 1)", () => {
    const { status, stdout } = runCli(["skip", "add", "not-a-url", "--json"]);
    expect(status).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(false);
  }, 30000);

  it("exits non-zero on an unknown command", () => {
    const { status, stderr } = runCli(["frobnicate"]);
    expect(status).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("unknown command");
  }, 30000);
});
