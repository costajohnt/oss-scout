/**
 * Config command — view and update oss-scout preferences.
 */

import { loadLocalState, saveLocalState } from "../core/local-state.js";
import {
  ScoutPreferencesSchema,
  IssueScopeSchema,
  ProjectCategorySchema,
  PersistenceModeSchema,
} from "../core/schemas.js";
import type { ScoutPreferences } from "../core/schemas.js";
import { ValidationError } from "../core/errors.js";

type FieldConfig =
  | { type: "array" | "number" | "boolean" | "string" }
  | { type: "enum" | "enum-array"; validValues: readonly string[] };

const FIELD_CONFIGS: Record<string, FieldConfig> = {
  languages: { type: "array" },
  labels: { type: "array" },
  excludeRepos: { type: "array" },
  excludeOrgs: { type: "array" },
  aiPolicyBlocklist: { type: "array" },
  preferredOrgs: { type: "array" },
  minStars: { type: "number" },
  maxIssueAgeDays: { type: "number" },
  minRepoScoreThreshold: { type: "number" },
  includeDocIssues: { type: "boolean" },
  scope: { type: "enum-array", validValues: IssueScopeSchema.options },
  projectCategories: {
    type: "enum-array",
    validValues: ProjectCategorySchema.options,
  },
  persistence: { type: "enum", validValues: PersistenceModeSchema.options },
  githubUsername: { type: "string" },
};

function parseBoolean(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "yes") return true;
  if (lower === "false" || lower === "no") return false;
  throw new ValidationError(
    `Invalid boolean value: "${value}". Use true/false or yes/no.`,
  );
}

function parseNumber(value: string, key: string): number {
  const num = parseInt(value, 10);
  if (isNaN(num)) {
    throw new ValidationError(`Invalid number for "${key}": "${value}"`);
  }
  return num;
}

function parseArrayValue(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Apply an array update: plain set, +append, or -remove.
 */
function updateArray(current: string[], value: string): string[] {
  if (value.startsWith("+")) {
    const toAdd = parseArrayValue(value.slice(1));
    const merged = [...current];
    for (const item of toAdd) {
      if (!merged.includes(item)) merged.push(item);
    }
    return merged;
  }
  if (value.startsWith("-")) {
    const toRemove = new Set(parseArrayValue(value.slice(1)));
    return current.filter((item) => !toRemove.has(item));
  }
  return parseArrayValue(value);
}

function formatArray(arr: string[]): string {
  return arr.length > 0 ? arr.join(", ") : "(none)";
}

/**
 * Display current preferences in human-readable format.
 */
export function runConfigShow(options: { json?: boolean }): void {
  const state = loadLocalState();
  const prefs = state.preferences;

  if (options.json) {
    // JSON output handled by caller
    return;
  }

  console.log("\n⚙️  oss-scout preferences\n");
  console.log(
    `  githubUsername:        ${prefs.githubUsername || "(not set)"}`,
  );
  console.log(`  languages:            ${formatArray(prefs.languages)}`);
  console.log(`  labels:               ${formatArray(prefs.labels)}`);
  console.log(
    `  scope:                ${prefs.scope ? formatArray(prefs.scope) : "(all)"}`,
  );
  console.log(`  minStars:             ${prefs.minStars}`);
  console.log(`  maxIssueAgeDays:      ${prefs.maxIssueAgeDays}`);
  console.log(`  minRepoScoreThreshold: ${prefs.minRepoScoreThreshold}`);
  console.log(`  includeDocIssues:     ${prefs.includeDocIssues}`);
  console.log(`  preferredOrgs:        ${formatArray(prefs.preferredOrgs)}`);
  console.log(
    `  projectCategories:    ${formatArray(prefs.projectCategories)}`,
  );
  console.log(`  excludeRepos:         ${formatArray(prefs.excludeRepos)}`);
  console.log(`  excludeOrgs:          ${formatArray(prefs.excludeOrgs)}`);
  console.log(
    `  aiPolicyBlocklist:    ${formatArray(prefs.aiPolicyBlocklist)}`,
  );
  console.log(`  persistence:          ${prefs.persistence}`);
  console.log();
}

/**
 * Get current preferences for JSON output.
 */
export function getConfigData(): ScoutPreferences {
  const state = loadLocalState();
  return state.preferences;
}

/**
 * Update a single preference by key.
 */
export function runConfigSet(key: string, value: string): ScoutPreferences {
  const field = FIELD_CONFIGS[key];
  if (!field) {
    throw new ValidationError(
      `Unknown config key: "${key}". Valid keys: ${Object.keys(FIELD_CONFIGS).sort().join(", ")}`,
    );
  }

  const state = loadLocalState();
  const prefs = { ...state.preferences };

  switch (field.type) {
    case "string":
      (prefs as Record<string, unknown>)[key] = value;
      break;

    case "boolean":
      (prefs as Record<string, unknown>)[key] = parseBoolean(value);
      break;

    case "number":
      (prefs as Record<string, unknown>)[key] = parseNumber(value, key);
      break;

    case "array": {
      const current =
        ((prefs as Record<string, unknown>)[key] as string[] | undefined) ?? [];
      (prefs as Record<string, unknown>)[key] = updateArray(current, value);
      break;
    }

    case "enum": {
      const validValues = field.validValues;
      if (!validValues.includes(value)) {
        throw new ValidationError(
          `Invalid value for "${key}": "${value}". Valid: ${validValues.join(", ")}`,
        );
      }
      (prefs as Record<string, unknown>)[key] = value;
      break;
    }

    case "enum-array": {
      const current =
        ((prefs as Record<string, unknown>)[key] as string[] | undefined) ?? [];
      const updated = updateArray(current, value);
      const validValues = field.validValues;
      const invalid = updated.filter((s) => !validValues.includes(s));
      if (invalid.length > 0) {
        throw new ValidationError(
          `Invalid value(s) for "${key}": ${invalid.join(", ")}. Valid: ${validValues.join(", ")}`,
        );
      }
      // For 'scope', empty array means undefined (all scopes)
      if (key === "scope") {
        (prefs as Record<string, unknown>)[key] =
          updated.length > 0 ? updated : undefined;
      } else {
        (prefs as Record<string, unknown>)[key] = updated;
      }
      break;
    }
  }

  // Validate the full preferences object
  const validated = ScoutPreferencesSchema.parse(prefs);
  state.preferences = validated;
  saveLocalState(state);

  return validated;
}

/**
 * Reset preferences to defaults.
 */
export function runConfigReset(): ScoutPreferences {
  const state = loadLocalState();
  const defaults = ScoutPreferencesSchema.parse({});
  state.preferences = defaults;
  saveLocalState(state);
  return defaults;
}
