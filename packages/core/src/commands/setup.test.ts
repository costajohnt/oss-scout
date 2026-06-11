import { describe, it, expect } from "vitest";
import { runSetup } from "./setup.js";

/**
 * Creates a mock readline interface that answers questions in sequence.
 */
function mockReadline(answers: string[]) {
  let index = 0;
  return {
    question(_query: string, callback: (answer: string) => void) {
      callback(answers[index++] ?? "");
    },
    close() {},
  };
}

describe("runSetup", () => {
  it("accepts all defaults", async () => {
    const rl = mockReadline([
      "", // username (use detected)
      "", // languages
      "", // labels
      "", // scope
      "", // minStars
      "", // projectCategories
      "", // excludeRepos
    ]);

    const prefs = await runSetup({
      rl,
      detectUsername: async () => "detected-user",
    });

    expect(prefs.githubUsername).toBe("detected-user");
    expect(prefs.languages).toEqual(["any"]);
    expect(prefs.labels).toEqual(["good first issue", "help wanted"]);
    expect(prefs.scope).toEqual(["beginner", "intermediate", "advanced"]);
    expect(prefs.minStars).toBe(50);
    expect(prefs.projectCategories).toEqual([]);
    expect(prefs.excludeRepos).toEqual([]);
  });

  it("accepts custom values", async () => {
    const rl = mockReadline([
      "customuser", // username
      "python, rust", // languages
      "bug, enhancement", // labels
      "beginner", // scope
      "100", // minStars
      "devtools, data-ml", // projectCategories
      "owner/repo1, owner/repo2", // excludeRepos
    ]);

    const prefs = await runSetup({
      rl,
      detectUsername: async () => "detected-user",
    });

    expect(prefs.githubUsername).toBe("customuser");
    expect(prefs.languages).toEqual(["python", "rust"]);
    expect(prefs.labels).toEqual(["bug", "enhancement"]);
    expect(prefs.scope).toEqual(["beginner"]);
    expect(prefs.minStars).toBe(100);
    expect(prefs.projectCategories).toEqual(["devtools", "data-ml"]);
    expect(prefs.excludeRepos).toEqual(["owner/repo1", "owner/repo2"]);
  });

  it("handles no detected username", async () => {
    const rl = mockReadline([
      "manualuser", // username (no detection)
      "",
      "",
      "",
      "",
      "",
      "",
    ]);

    const prefs = await runSetup({
      rl,
      detectUsername: async () => "",
    });

    expect(prefs.githubUsername).toBe("manualuser");
  });

  it("handles invalid minStars gracefully", async () => {
    const rl = mockReadline([
      "", // username
      "", // languages
      "", // labels
      "", // scope
      "not-a-number", // minStars — should fall back to 50
      "",
      "",
    ]);

    const prefs = await runSetup({
      rl,
      detectUsername: async () => "",
    });

    expect(prefs.minStars).toBe(50);
  });

  it("filters invalid scope values", async () => {
    const rl = mockReadline([
      "",
      "",
      "",
      "beginner, expert, advanced", // expert is invalid
      "",
      "",
      "",
    ]);

    const prefs = await runSetup({
      rl,
      detectUsername: async () => "",
    });

    expect(prefs.scope).toEqual(["beginner", "advanced"]);
  });

  it("filters invalid category values", async () => {
    const rl = mockReadline([
      "",
      "",
      "",
      "",
      "",
      "devtools, gaming", // gaming is invalid
      "",
    ]);

    const prefs = await runSetup({
      rl,
      detectUsername: async () => "",
    });

    expect(prefs.projectCategories).toEqual(["devtools"]);
  });
});

describe("non-interactive safety (#131)", () => {
  it("fails fast without an injected rl when stdin is not a TTY", async () => {
    // Under vitest, process.stdin.isTTY is falsy, which is exactly the
    // CI/piped context the guard protects
    await expect(runSetup({ detectUsername: async () => "" })).rejects.toThrow(
      "interactive",
    );
  });

  it("rejects instead of silently exiting when input ends mid-flow", async () => {
    let closeListener: (() => void) | undefined;
    const rl = {
      question: (_q: string, _cb: (a: string) => void) => {
        // Simulate piped stdin ending before any answer arrives
        closeListener?.();
      },
      close: () => {},
      on: (event: "close", listener: () => void) => {
        if (event === "close") closeListener = listener;
      },
      off: () => {},
    };

    await expect(
      runSetup({ rl, detectUsername: async () => "user" }),
    ).rejects.toThrow("preferences were not saved");
  });
});
