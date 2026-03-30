/**
 * Setup command — interactive first-run configuration for oss-scout.
 */

import * as readline from "readline";
import { execFile } from "child_process";
import type {
  ScoutPreferences,
  ProjectCategory,
  IssueScope,
} from "../core/schemas.js";
import {
  ScoutPreferencesSchema,
  ProjectCategorySchema,
  IssueScopeSchema,
} from "../core/schemas.js";

const ALL_CATEGORIES =
  ProjectCategorySchema.options as readonly ProjectCategory[];
const ALL_SCOPES = IssueScopeSchema.options as readonly IssueScope[];

interface ReadlineInterface {
  question(query: string, callback: (answer: string) => void): void;
  close(): void;
}

function createReadlineInterface(): ReadlineInterface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: ReadlineInterface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => resolve(answer.trim()));
  });
}

function detectGitHubUsername(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["api", "user", "--jq", ".login"],
      { timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve("");
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

function parseCSV(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseMultiSelect<T extends string>(
  input: string,
  options: readonly T[],
): T[] {
  if (!input) return [];
  const selected = parseCSV(input);
  return selected.filter((s): s is T =>
    (options as readonly string[]).includes(s),
  );
}

export interface SetupOptions {
  rl?: ReadlineInterface;
  detectUsername?: () => Promise<string>;
}

/**
 * Run the interactive setup flow and return the configured preferences.
 */
export async function runSetup(
  options?: SetupOptions,
): Promise<ScoutPreferences> {
  const rl = options?.rl ?? createReadlineInterface();
  const detect = options?.detectUsername ?? detectGitHubUsername;

  try {
    console.log("\n🔧 oss-scout setup\n");

    // Detect GitHub username
    console.log("Detecting GitHub username...");
    const detectedUsername = await detect();
    const usernameDefault = detectedUsername || "";
    const usernamePrompt = detectedUsername
      ? `GitHub username [${detectedUsername}]: `
      : "GitHub username: ";
    const usernameInput = await ask(rl, usernamePrompt);
    const githubUsername = usernameInput || usernameDefault;

    // Languages
    const defaultLangs = "any (all languages)";
    const langsInput = await ask(
      rl,
      `Preferred languages (comma-separated, or "any" for all) [${defaultLangs}]: `,
    );
    const languages = langsInput ? parseCSV(langsInput) : ["any"];

    // Issue labels
    const defaultLabels = "good first issue, help wanted";
    const labelsInput = await ask(
      rl,
      `Issue labels to search for [${defaultLabels}]: `,
    );
    const labels = labelsInput
      ? parseCSV(labelsInput)
      : ["good first issue", "help wanted"];

    // Difficulty scope
    const scopeOptions = ALL_SCOPES.join(", ");
    const scopeInput = await ask(
      rl,
      `Difficulty scope (${scopeOptions}) [all]: `,
    );
    const scope = scopeInput
      ? parseMultiSelect(scopeInput, ALL_SCOPES)
      : [...ALL_SCOPES];

    // Minimum stars
    const minStarsInput = await ask(rl, "Minimum repo stars [50]: ");
    const minStars = minStarsInput ? parseInt(minStarsInput, 10) : 50;

    // Project categories
    const categoryOptions = ALL_CATEGORIES.join(", ");
    const categoriesInput = await ask(
      rl,
      `Project categories (${categoryOptions}) [none]: `,
    );
    const projectCategories = parseMultiSelect(categoriesInput, ALL_CATEGORIES);

    // Repos to exclude
    const excludeInput = await ask(
      rl,
      "Repos to exclude (owner/repo, comma-separated, optional): ",
    );
    const excludeRepos = parseCSV(excludeInput);

    const prefs = ScoutPreferencesSchema.parse({
      githubUsername,
      languages,
      labels,
      scope: scope.length > 0 ? scope : undefined,
      excludeRepos,
      projectCategories,
      minStars: isNaN(minStars) ? 50 : minStars,
    });

    console.log("\n✅ Setup complete! Preferences saved.\n");
    return prefs;
  } finally {
    if (!options?.rl) {
      rl.close();
    }
  }
}
