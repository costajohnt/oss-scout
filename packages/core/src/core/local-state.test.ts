import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  loadLocalState,
  saveLocalState,
  hasLocalState,
} from "./local-state.js";
import { ScoutStateSchema } from "./schemas.js";
import type { ScoutState } from "./schemas.js";

// Mock getDataDir to use a temp directory
let tmpDir: string;

vi.mock("./utils.js", () => ({
  getDataDir: () => tmpDir,
}));

vi.mock("./logger.js", () => ({
  debug: () => {},
  warn: () => {},
}));

vi.mock("./errors.js", () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

describe("local-state", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-scout-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("hasLocalState", () => {
    it("returns false when no state file exists", () => {
      expect(hasLocalState()).toBe(false);
    });

    it("returns true when state file exists", () => {
      const state = ScoutStateSchema.parse({ version: 1 });
      fs.writeFileSync(path.join(tmpDir, "state.json"), JSON.stringify(state));
      expect(hasLocalState()).toBe(true);
    });
  });

  describe("loadLocalState", () => {
    it("returns fresh default state when no file exists", () => {
      const state = loadLocalState();
      expect(state.version).toBe(1);
      expect(state.preferences.languages).toEqual(["typescript", "javascript"]);
      expect(state.repoScores).toEqual({});
    });

    it("loads existing valid state", () => {
      const existing = ScoutStateSchema.parse({
        version: 1,
        preferences: { githubUsername: "testuser", languages: ["python"] },
      });
      fs.writeFileSync(
        path.join(tmpDir, "state.json"),
        JSON.stringify(existing),
      );

      const state = loadLocalState();
      expect(state.preferences.githubUsername).toBe("testuser");
      expect(state.preferences.languages).toEqual(["python"]);
    });

    it("returns fresh state on corrupt JSON", () => {
      fs.writeFileSync(path.join(tmpDir, "state.json"), "{invalid json");

      const state = loadLocalState();
      expect(state.version).toBe(1);
      expect(state.preferences.languages).toEqual(["typescript", "javascript"]);

      // Verify a .corrupt backup was created
      const files = fs.readdirSync(tmpDir);
      const backups = files.filter((f) => f.startsWith("state.json.corrupt."));
      expect(backups.length).toBe(1);
    });

    it("returns fresh state on invalid schema", () => {
      fs.writeFileSync(
        path.join(tmpDir, "state.json"),
        JSON.stringify({ version: 99 }),
      );

      const state = loadLocalState();
      expect(state.version).toBe(1);

      // Verify a .corrupt backup was created
      const files = fs.readdirSync(tmpDir);
      const backups = files.filter((f) => f.startsWith("state.json.corrupt."));
      expect(backups.length).toBe(1);
    });
  });

  describe("saveLocalState", () => {
    it("writes state to file", () => {
      const state = ScoutStateSchema.parse({
        version: 1,
        preferences: { githubUsername: "saved-user" },
      });
      saveLocalState(state);

      const raw = fs.readFileSync(path.join(tmpDir, "state.json"), "utf-8");
      const loaded = JSON.parse(raw);
      expect(loaded.preferences.githubUsername).toBe("saved-user");
    });

    it("performs atomic write (no .tmp file left behind)", () => {
      const state = ScoutStateSchema.parse({ version: 1 });
      saveLocalState(state);

      expect(fs.existsSync(path.join(tmpDir, "state.json"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "state.json.tmp"))).toBe(false);
    });

    it("overwrites existing state", () => {
      const state1: ScoutState = ScoutStateSchema.parse({
        version: 1,
        preferences: { githubUsername: "first" },
      });
      saveLocalState(state1);

      const state2: ScoutState = ScoutStateSchema.parse({
        version: 1,
        preferences: { githubUsername: "second" },
      });
      saveLocalState(state2);

      const loaded = loadLocalState();
      expect(loaded.preferences.githubUsername).toBe("second");
    });
  });
});
