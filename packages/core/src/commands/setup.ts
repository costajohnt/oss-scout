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
import { ConfigurationError } from "../core/errors.js";

const ALL_CATEGORIES =
  ProjectCategorySchema.options as readonly ProjectCategory[];
const ALL_SCOPES = IssueScopeSchema.options as readonly IssueScope[];

interface ReadlineInterface {
  question(query: string, callback: (answer: string) => void): void;
  close(): void;
  on?(event: "close", listener: () => void): unknown;
  off?(event: "close", listener: () => void): unknown;
}

function createReadlineInterface(): ReadlineInterface {
  // Prompts echo on stderr so stdout stays pure for --json output (#131)
  return readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
}

function ask(rl: ReadlineInterface, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Piped stdin that ends early used to leave the pending question
    // unresolved: the event loop drained and the process exited 0 without
    // saving anything (#131). Reject on close instead.
    let settled = false;
    const onClose = () => {
      if (settled) return;
      settled = true;
      reject(
        new ConfigurationError(
          "Input ended before setup finished; preferences were not saved",
        ),
      );
    };
    rl.on?.("close", onClose);
    rl.question(query, (answer) => {
      if (settled) return;
      settled = true;
      rl.off?.("close", onClose);
      resolve(answer.trim());
    });
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
  // Fail fast in non-interactive contexts (CI, piped stdin): prompting
  // would hang or silently save defaults (#131). Injected rl (tests, hosts)
  // opts out of the guard.
  if (!options?.rl && !process.stdin.isTTY) {
    throw new ConfigurationError(
      "setup is interactive and requires a terminal. Use `oss-scout config set <key> <value>` for non-interactive configuration.",
    );
  }
  const rl = options?.rl ?? createReadlineInterface();
  const detect = options?.detectUsername ?? detectGitHubUsername;

  try {
    // Interactive chrome goes to stderr; stdout stays pure for --json (#131)
    console.error("\n🔧 oss-scout setup\n");

    // Detect GitHub username
    console.error("Detecting GitHub username...");
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

    // Optional local SLM pre-triage (Ollama). Empty leaves it disabled.
    const slmTriageModel = await ask(
      rl,
      "Local SLM triage model for faster pre-filtering (Ollama model id, e.g. gemma4:e4b, optional): ",
    );

    const prefs = ScoutPreferencesSchema.parse({
      githubUsername,
      languages,
      labels,
      scope: scope.length > 0 ? scope : undefined,
      excludeRepos,
      projectCategories,
      minStars: isNaN(minStars) ? 50 : minStars,
      slmTriageModel,
    });

    console.error("\n✅ Setup complete! Preferences saved.\n");
    return prefs;
  } finally {
    if (!options?.rl) {
      rl.close();
    }
  }
}
