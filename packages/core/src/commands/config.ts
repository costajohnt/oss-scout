/**
 * Config command — view and update oss-scout preferences.
 */

import { loadLocalState, saveLocalState } from '../core/local-state.js';
import { ScoutPreferencesSchema, IssueScopeSchema, ProjectCategorySchema, PersistenceModeSchema } from '../core/schemas.js';
import type { ScoutPreferences } from '../core/schemas.js';
import { ValidationError } from '../core/errors.js';

/** All known preference keys and their types. */
const ARRAY_FIELDS = new Set([
  'languages',
  'labels',
  'preferredOrgs',
  'projectCategories',
  'excludeRepos',
  'excludeOrgs',
  'aiPolicyBlocklist',
]);

const NUMBER_FIELDS = new Set(['minStars', 'maxIssueAgeDays', 'minRepoScoreThreshold']);

const BOOLEAN_FIELDS = new Set(['includeDocIssues']);

const STRING_FIELDS = new Set(['githubUsername']);

const SCOPE_FIELD = 'scope';

const ENUM_FIELDS: Record<string, readonly string[]> = {
  persistence: PersistenceModeSchema.options as readonly string[],
};

const ALL_FIELDS = new Set([
  ...ARRAY_FIELDS,
  ...NUMBER_FIELDS,
  ...BOOLEAN_FIELDS,
  ...STRING_FIELDS,
  ...Object.keys(ENUM_FIELDS),
  SCOPE_FIELD,
]);

const VALID_SCOPES = IssueScopeSchema.options as readonly string[];
const VALID_CATEGORIES = ProjectCategorySchema.options as readonly string[];

function parseBoolean(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === 'yes') return true;
  if (lower === 'false' || lower === 'no') return false;
  throw new ValidationError(`Invalid boolean value: "${value}". Use true/false or yes/no.`);
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
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Apply an array update: plain set, +append, or -remove.
 */
function updateArray(current: string[], value: string): string[] {
  if (value.startsWith('+')) {
    const toAdd = parseArrayValue(value.slice(1));
    const merged = [...current];
    for (const item of toAdd) {
      if (!merged.includes(item)) merged.push(item);
    }
    return merged;
  }
  if (value.startsWith('-')) {
    const toRemove = new Set(parseArrayValue(value.slice(1)));
    return current.filter((item) => !toRemove.has(item));
  }
  return parseArrayValue(value);
}

function formatArray(arr: string[]): string {
  return arr.length > 0 ? arr.join(', ') : '(none)';
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

  console.log('\n⚙️  oss-scout preferences\n');
  console.log(`  githubUsername:        ${prefs.githubUsername || '(not set)'}`);
  console.log(`  languages:            ${formatArray(prefs.languages)}`);
  console.log(`  labels:               ${formatArray(prefs.labels)}`);
  console.log(`  scope:                ${prefs.scope ? formatArray(prefs.scope) : '(all)'}`);
  console.log(`  minStars:             ${prefs.minStars}`);
  console.log(`  maxIssueAgeDays:      ${prefs.maxIssueAgeDays}`);
  console.log(`  minRepoScoreThreshold: ${prefs.minRepoScoreThreshold}`);
  console.log(`  includeDocIssues:     ${prefs.includeDocIssues}`);
  console.log(`  preferredOrgs:        ${formatArray(prefs.preferredOrgs)}`);
  console.log(`  projectCategories:    ${formatArray(prefs.projectCategories)}`);
  console.log(`  excludeRepos:         ${formatArray(prefs.excludeRepos)}`);
  console.log(`  excludeOrgs:          ${formatArray(prefs.excludeOrgs)}`);
  console.log(`  aiPolicyBlocklist:    ${formatArray(prefs.aiPolicyBlocklist)}`);
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
  if (!ALL_FIELDS.has(key)) {
    throw new ValidationError(
      `Unknown config key: "${key}". Valid keys: ${[...ALL_FIELDS].sort().join(', ')}`,
    );
  }

  const state = loadLocalState();
  const prefs = { ...state.preferences };

  if (STRING_FIELDS.has(key)) {
    (prefs as Record<string, unknown>)[key] = value;
  } else if (BOOLEAN_FIELDS.has(key)) {
    (prefs as Record<string, unknown>)[key] = parseBoolean(value);
  } else if (NUMBER_FIELDS.has(key)) {
    (prefs as Record<string, unknown>)[key] = parseNumber(value, key);
  } else if (key === SCOPE_FIELD) {
    const updated = updateArray((prefs.scope as string[] | undefined) ?? [], value);
    const invalid = updated.filter((s) => !VALID_SCOPES.includes(s));
    if (invalid.length > 0) {
      throw new ValidationError(
        `Invalid scope value(s): ${invalid.join(', ')}. Valid: ${VALID_SCOPES.join(', ')}`,
      );
    }
    prefs.scope = updated.length > 0 ? (updated as typeof prefs.scope) : undefined;
  } else if (key === 'projectCategories') {
    const updated = updateArray(prefs.projectCategories, value);
    const invalid = updated.filter((s) => !VALID_CATEGORIES.includes(s));
    if (invalid.length > 0) {
      throw new ValidationError(
        `Invalid category value(s): ${invalid.join(', ')}. Valid: ${VALID_CATEGORIES.join(', ')}`,
      );
    }
    prefs.projectCategories = updated as typeof prefs.projectCategories;
  } else if (key in ENUM_FIELDS) {
    const validValues = ENUM_FIELDS[key];
    if (!validValues.includes(value)) {
      throw new ValidationError(
        `Invalid value for "${key}": "${value}". Valid: ${validValues.join(', ')}`,
      );
    }
    (prefs as Record<string, unknown>)[key] = value;
  } else if (ARRAY_FIELDS.has(key)) {
    const current = ((prefs as Record<string, unknown>)[key] as string[] | undefined) ?? [];
    (prefs as Record<string, unknown>)[key] = updateArray(current, value);
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
