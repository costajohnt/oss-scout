/**
 * Shared preference-field metadata and value parsing.
 *
 * The CLI (`commands/config.ts`) and the MCP `config-set` tool both update a
 * single preference from a raw string. They used to carry separate, drifting
 * copies of the key tables and parse logic — the CLI was missing the SLM
 * triage keys, the MCP side lacked the `scope` special case and the +/- array
 * syntax. This module is the single source of truth both drive (#153).
 */

import {
  ScoutPreferencesSchema,
  IssueScopeSchema,
  ProjectCategorySchema,
  PersistenceModeSchema,
  SearchStrategySchema,
} from "./schemas.js";
import type { ScoutPreferences } from "./schemas.js";
import { ValidationError } from "./errors.js";

export type FieldConfig =
  | { type: "array" | "number" | "float" | "boolean" | "string" }
  | { type: "enum" | "enum-array"; validValues: readonly string[] };

export const FIELD_CONFIGS: Record<string, FieldConfig> = {
  githubUsername: { type: "string" },
  languages: { type: "array" },
  labels: { type: "array" },
  scope: { type: "enum-array", validValues: IssueScopeSchema.options },
  excludeRepos: { type: "array" },
  excludeOrgs: { type: "array" },
  aiPolicyBlocklist: { type: "array" },
  projectCategories: {
    type: "enum-array",
    validValues: ProjectCategorySchema.options,
  },
  minStars: { type: "number" },
  maxIssueAgeDays: { type: "number" },
  includeDocIssues: { type: "boolean" },
  minRepoScoreThreshold: { type: "number" },
  interPhaseDelayMs: { type: "number" },
  persistence: { type: "enum", validValues: PersistenceModeSchema.options },
  defaultStrategy: {
    type: "enum-array",
    validValues: SearchStrategySchema.options,
  },
  broadPhaseDelayMs: { type: "number" },
  skipBroadWhenSufficientResults: { type: "number" },
  preferLanguages: { type: "array" },
  preferRepos: { type: "array" },
  diversityRatio: { type: "float" },
  avoidRepos: { type: "array" },
  boostIssueTypes: { type: "array" },
  slmTriageModel: { type: "string" },
  slmTriageHost: { type: "string" },
  featuresAnchorThreshold: { type: "number" },
  featuresSplitRatio: { type: "float" },
};

/**
 * Every configurable preference key, derived from the schema so a new
 * preference can't be silently left unconfigurable. `assertFieldConfigsCover`
 * (exercised by a unit test) fails loudly if FIELD_CONFIGS drifts from this.
 */
export const PREFERENCE_KEYS: readonly string[] = Object.keys(
  ScoutPreferencesSchema.shape,
);

/** Sorted key list for "unknown key" error messages and help text. */
export const SORTED_PREFERENCE_KEYS: readonly string[] = [
  ...PREFERENCE_KEYS,
].sort();

/**
 * Throw if any schema preference lacks a FIELD_CONFIG entry. Called from a
 * test so adding a preference to the schema without teaching config-set how to
 * parse it is caught in CI rather than at a user's first `config set newKey`.
 */
export function assertFieldConfigsCover(): void {
  const missing = PREFERENCE_KEYS.filter((k) => !(k in FIELD_CONFIGS));
  if (missing.length > 0) {
    throw new Error(
      `FIELD_CONFIGS is missing entries for preference keys: ${missing.join(", ")}`,
    );
  }
  const extra = Object.keys(FIELD_CONFIGS).filter(
    (k) => !PREFERENCE_KEYS.includes(k),
  );
  if (extra.length > 0) {
    throw new Error(
      `FIELD_CONFIGS has entries for unknown preference keys: ${extra.join(", ")}`,
    );
  }
}

function parseBoolean(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "yes") return true;
  if (lower === "false" || lower === "no") return false;
  throw new ValidationError(
    `Invalid boolean value: "${value}". Use true/false or yes/no.`,
  );
}

function parseIntValue(value: string, key: string): number {
  const num = parseInt(value, 10);
  if (isNaN(num)) {
    throw new ValidationError(`Invalid number for "${key}": "${value}"`);
  }
  return num;
}

function parseFloatValue(value: string, key: string): number {
  const num = Number.parseFloat(value);
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
 *
 * The -remove form starts with a dash, which commander rejects as an unknown
 * option unless escaped: `config set excludeRepos -- "-spam/repo"`. The MCP
 * tool has no commander layer so it can pass `-spam/repo` directly. Documented
 * in the CLI help and README (#132).
 */
export function updateArray(current: string[], value: string): string[] {
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

/**
 * Apply a single key/value update to a preferences object and return the
 * fully validated result. The raw string `value` is the form both the CLI and
 * the MCP tool receive; arrays accept comma-separated values and the +add /
 * -remove syntax. Throws ValidationError on an unknown key or a bad value.
 */
export function applyPreferenceField(
  preferences: ScoutPreferences,
  key: string,
  value: string,
): ScoutPreferences {
  const field = FIELD_CONFIGS[key];
  if (!field) {
    throw new ValidationError(
      `Unknown config key: "${key}". Valid keys: ${SORTED_PREFERENCE_KEYS.join(", ")}`,
    );
  }

  const prefs = { ...preferences } as Record<string, unknown>;

  switch (field.type) {
    case "string":
      prefs[key] = value;
      break;

    case "boolean":
      prefs[key] = parseBoolean(value);
      break;

    case "number":
      prefs[key] = parseIntValue(value, key);
      break;

    case "float":
      prefs[key] = parseFloatValue(value, key);
      break;

    case "array": {
      const current = (prefs[key] as string[] | undefined) ?? [];
      prefs[key] = updateArray(current, value);
      break;
    }

    case "enum": {
      const validValues = field.validValues;
      if (!validValues.includes(value)) {
        throw new ValidationError(
          `Invalid value for "${key}": "${value}". Valid: ${validValues.join(", ")}`,
        );
      }
      prefs[key] = value;
      break;
    }

    case "enum-array": {
      const current = (prefs[key] as string[] | undefined) ?? [];
      const updated = updateArray(current, value);
      const validValues = field.validValues;
      const invalid = updated.filter((s) => !validValues.includes(s));
      if (invalid.length > 0) {
        throw new ValidationError(
          `Invalid value(s) for "${key}": ${invalid.join(", ")}. Valid: ${validValues.join(", ")}`,
        );
      }
      // For 'scope', an empty array means undefined (all scopes).
      if (key === "scope") {
        prefs[key] = updated.length > 0 ? updated : undefined;
      } else {
        prefs[key] = updated;
      }
      break;
    }
  }

  return ScoutPreferencesSchema.parse(prefs);
}
