/**
 * Config command — view and update oss-scout preferences.
 */

import { loadLocalState, saveLocalState } from "../core/local-state.js";
import { ScoutPreferencesSchema } from "../core/schemas.js";
import type { ScoutPreferences } from "../core/schemas.js";
import { applyPreferenceField } from "../core/preference-fields.js";

function formatArray(arr: string[]): string {
  return arr.length > 0 ? arr.join(", ") : "(none)";
}

/**
 * Display current preferences in human-readable format.
 */
export function runConfigShow(): void {
  const state = loadLocalState();
  const prefs = state.preferences;

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
  console.log(
    `  interPhaseDelayMs:    ${prefs.interPhaseDelayMs}ms (${(prefs.interPhaseDelayMs / 1000).toFixed(0)}s)`,
  );
  console.log(`  includeDocIssues:     ${prefs.includeDocIssues}`);
  console.log(
    `  projectCategories:    ${formatArray(prefs.projectCategories)}`,
  );
  console.log(`  excludeRepos:         ${formatArray(prefs.excludeRepos)}`);
  console.log(`  excludeOrgs:          ${formatArray(prefs.excludeOrgs)}`);
  console.log(
    `  aiPolicyBlocklist:    ${formatArray(prefs.aiPolicyBlocklist)}`,
  );
  console.log(
    `  defaultStrategy:      ${prefs.defaultStrategy ? formatArray(prefs.defaultStrategy) : "(all)"}`,
  );
  console.log(`  persistence:          ${prefs.persistence}`);
  console.log(`  preferLanguages:      ${formatArray(prefs.preferLanguages)}`);
  console.log(`  preferRepos:          ${formatArray(prefs.preferRepos)}`);
  console.log(`  diversityRatio:       ${prefs.diversityRatio}`);
  console.log(
    `  broadPhaseDelayMs:    ${prefs.broadPhaseDelayMs}ms (${(prefs.broadPhaseDelayMs / 1000).toFixed(0)}s)`,
  );
  console.log(
    `  skipBroadWhenSufficientResults: ${prefs.skipBroadWhenSufficientResults}`,
  );
  console.log(
    `  slmTriageModel:       ${prefs.slmTriageModel || "(disabled)"}`,
  );
  console.log(
    `  slmTriageHost:        ${prefs.slmTriageHost || "(default 127.0.0.1:11434)"}`,
  );
  console.log(`  featuresAnchorThreshold: ${prefs.featuresAnchorThreshold}`);
  console.log(`  featuresSplitRatio:    ${prefs.featuresSplitRatio}`);
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
  const state = loadLocalState();
  const validated = applyPreferenceField(state.preferences, key, value);
  state.preferences = validated;
  state.preferencesUpdatedAt = new Date().toISOString(); // #117 merge recency
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
  state.preferencesUpdatedAt = new Date().toISOString(); // #117 merge recency
  saveLocalState(state);
  return defaults;
}
