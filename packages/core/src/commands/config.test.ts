import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  runConfigShow,
  runConfigSet,
  runConfigReset,
  getConfigData,
} from "./config.js";
import { ScoutPreferencesSchema } from "../core/schemas.js";
import type { ScoutState } from "../core/schemas.js";

// Mock getDataDir to use a temp directory
let tempDir: string;

vi.mock("../core/utils.js", () => ({
  getDataDir: () => tempDir,
}));

vi.mock("../core/logger.js", () => ({
  debug: () => {},
}));

function writeState(state: ScoutState): void {
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, "state.json"),
    JSON.stringify(state, null, 2),
  );
}

function readState(): ScoutState {
  return JSON.parse(fs.readFileSync(path.join(tempDir, "state.json"), "utf-8"));
}

function makeState(prefsOverrides: Record<string, unknown> = {}): ScoutState {
  return {
    version: 1 as const,
    preferences: ScoutPreferencesSchema.parse(prefsOverrides),
    repoScores: {},
    starredRepos: [],
    mergedPRs: [],
    closedPRs: [],
    lastRunAt: new Date().toISOString(),
  };
}

describe("config command", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-scout-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("runConfigShow", () => {
    it("should display current preferences in human-readable format", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      writeState(makeState({ githubUsername: "testuser", minStars: 100 }));

      runConfigShow();

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("testuser");
      expect(output).toContain("100");
      consoleSpy.mockRestore();
    });
  });

  describe("getConfigData", () => {
    it("should return current preferences as an object", () => {
      writeState(makeState({ githubUsername: "alice", minStars: 200 }));

      const data = getConfigData();

      expect(data.githubUsername).toBe("alice");
      expect(data.minStars).toBe(200);
    });

    it("should return defaults when no state file exists", () => {
      const data = getConfigData();
      const defaults = ScoutPreferencesSchema.parse({});

      expect(data.githubUsername).toBe(defaults.githubUsername);
      expect(data.minStars).toBe(defaults.minStars);
    });
  });

  describe("runConfigSet", () => {
    describe("string fields", () => {
      it("should set githubUsername", () => {
        writeState(makeState());

        const result = runConfigSet("githubUsername", "newuser");

        expect(result.githubUsername).toBe("newuser");
        expect(readState().preferences.githubUsername).toBe("newuser");
      });
    });

    describe("number fields", () => {
      it("should set minStars", () => {
        writeState(makeState());

        const result = runConfigSet("minStars", "200");

        expect(result.minStars).toBe(200);
        expect(readState().preferences.minStars).toBe(200);
      });

      it("should set maxIssueAgeDays", () => {
        writeState(makeState());

        const result = runConfigSet("maxIssueAgeDays", "30");

        expect(result.maxIssueAgeDays).toBe(30);
      });

      it("should reject non-numeric values", () => {
        writeState(makeState());

        expect(() => runConfigSet("minStars", "abc")).toThrow("Invalid number");
      });
    });

    describe("boolean fields", () => {
      it("should set includeDocIssues to false", () => {
        writeState(makeState());

        const result = runConfigSet("includeDocIssues", "false");

        expect(result.includeDocIssues).toBe(false);
      });

      it("should accept yes/no", () => {
        writeState(makeState());

        const result = runConfigSet("includeDocIssues", "yes");
        expect(result.includeDocIssues).toBe(true);

        const result2 = runConfigSet("includeDocIssues", "no");
        expect(result2.includeDocIssues).toBe(false);
      });

      it("should reject invalid boolean values", () => {
        writeState(makeState());

        expect(() => runConfigSet("includeDocIssues", "maybe")).toThrow(
          "Invalid boolean",
        );
      });
    });

    describe("array fields", () => {
      it("should set languages as comma-separated", () => {
        writeState(makeState());

        const result = runConfigSet("languages", "python, rust, go");

        expect(result.languages).toEqual(["python", "rust", "go"]);
      });

      it("should append with + prefix", () => {
        writeState(makeState({ languages: ["typescript", "javascript"] }));

        const result = runConfigSet("languages", "+python");

        expect(result.languages).toEqual([
          "typescript",
          "javascript",
          "python",
        ]);
      });

      it("should not duplicate when appending existing value", () => {
        writeState(makeState({ languages: ["typescript", "javascript"] }));

        const result = runConfigSet("languages", "+typescript");

        expect(result.languages).toEqual(["typescript", "javascript"]);
      });

      it("should remove with - prefix", () => {
        writeState(
          makeState({ languages: ["typescript", "javascript", "python"] }),
        );

        const result = runConfigSet("languages", "-javascript");

        expect(result.languages).toEqual(["typescript", "python"]);
      });

      it("should handle multi-value append", () => {
        writeState(makeState({ languages: ["typescript"] }));

        const result = runConfigSet("languages", "+python, rust");

        expect(result.languages).toEqual(["typescript", "python", "rust"]);
      });

      it("should handle multi-value remove", () => {
        writeState(
          makeState({ languages: ["typescript", "javascript", "python"] }),
        );

        const result = runConfigSet("languages", "-typescript, python");

        expect(result.languages).toEqual(["javascript"]);
      });

      it("should set labels", () => {
        writeState(makeState());

        const result = runConfigSet("labels", "bug, enhancement");

        expect(result.labels).toEqual(["bug", "enhancement"]);
      });

      it("should set excludeRepos", () => {
        writeState(makeState());

        const result = runConfigSet("excludeRepos", "owner/repo1, owner/repo2");

        expect(result.excludeRepos).toEqual(["owner/repo1", "owner/repo2"]);
      });
    });

    describe("scope field", () => {
      it("should set scope with valid values", () => {
        writeState(makeState());

        const result = runConfigSet("scope", "beginner, intermediate");

        expect(result.scope).toEqual(["beginner", "intermediate"]);
      });

      it("should reject invalid scope values", () => {
        writeState(makeState());

        expect(() => runConfigSet("scope", "expert")).toThrow("Invalid value");
      });

      it("should append to scope with +", () => {
        writeState(makeState({ scope: ["beginner"] }));

        const result = runConfigSet("scope", "+intermediate");

        expect(result.scope).toEqual(["beginner", "intermediate"]);
      });

      it("should remove from scope with -", () => {
        writeState(
          makeState({ scope: ["beginner", "intermediate", "advanced"] }),
        );

        const result = runConfigSet("scope", "-advanced");

        expect(result.scope).toEqual(["beginner", "intermediate"]);
      });
    });

    describe("projectCategories field", () => {
      it("should set valid categories", () => {
        writeState(makeState());

        const result = runConfigSet(
          "projectCategories",
          "devtools, infrastructure",
        );

        expect(result.projectCategories).toEqual([
          "devtools",
          "infrastructure",
        ]);
      });

      it("should reject invalid categories", () => {
        writeState(makeState());

        expect(() => runConfigSet("projectCategories", "invalid")).toThrow(
          "Invalid value",
        );
      });
    });

    describe("validation", () => {
      it("should reject unknown keys", () => {
        writeState(makeState());

        expect(() => runConfigSet("unknownKey", "value")).toThrow(
          "Unknown config key",
        );
      });

      it("should include valid keys in error message", () => {
        writeState(makeState());

        expect(() => runConfigSet("bad", "value")).toThrow("Valid keys:");
      });
    });
  });

  describe("runConfigReset", () => {
    it("should reset preferences to defaults", () => {
      writeState(
        makeState({
          githubUsername: "custom",
          minStars: 999,
          languages: ["rust"],
        }),
      );

      const result = runConfigReset();
      const defaults = ScoutPreferencesSchema.parse({});

      expect(result.githubUsername).toBe(defaults.githubUsername);
      expect(result.minStars).toBe(defaults.minStars);
      expect(result.languages).toEqual(defaults.languages);
    });

    it("should persist reset state to disk", () => {
      writeState(makeState({ minStars: 999 }));

      runConfigReset();

      const saved = readState();
      expect(saved.preferences.minStars).toBe(50); // default
    });

    it("should preserve non-preference state", () => {
      const state = makeState({ githubUsername: "user" });
      state.starredRepos = ["org/repo"];
      writeState(state);

      runConfigReset();

      const saved = readState();
      expect(saved.starredRepos).toEqual(["org/repo"]);
    });
  });
});
