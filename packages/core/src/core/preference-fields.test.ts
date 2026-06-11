import { describe, it, expect } from "vitest";
import {
  applyPreferenceField,
  assertFieldConfigsCover,
  FIELD_CONFIGS,
  PREFERENCE_KEYS,
} from "./preference-fields.js";
import { ScoutPreferencesSchema } from "./schemas.js";

const defaults = ScoutPreferencesSchema.parse({});

describe("preference-fields", () => {
  describe("assertFieldConfigsCover", () => {
    it("FIELD_CONFIGS covers every schema preference key", () => {
      expect(() => assertFieldConfigsCover()).not.toThrow();
    });

    it("every preference key (incl. SLM triage) has a field config", () => {
      for (const key of PREFERENCE_KEYS) {
        expect(FIELD_CONFIGS[key]).toBeDefined();
      }
      // The keys that previously drifted out of the CLI map (#153).
      expect(FIELD_CONFIGS.slmTriageModel).toEqual({ type: "string" });
      expect(FIELD_CONFIGS.slmTriageHost).toEqual({ type: "string" });
    });
  });

  describe("applyPreferenceField", () => {
    it("parses the SLM triage keys the CLI map used to reject", () => {
      const updated = applyPreferenceField(
        defaults,
        "slmTriageModel",
        "gemma4:e4b",
      );
      expect(updated.slmTriageModel).toBe("gemma4:e4b");
    });

    it("applies +append / -remove array syntax (parity for MCP)", () => {
      const appended = applyPreferenceField(
        { ...defaults, excludeRepos: ["a/b"] },
        "excludeRepos",
        "+c/d",
      );
      expect(appended.excludeRepos).toEqual(["a/b", "c/d"]);

      const removed = applyPreferenceField(
        { ...defaults, excludeRepos: ["a/b", "c/d"] },
        "excludeRepos",
        "-a/b",
      );
      expect(removed.excludeRepos).toEqual(["c/d"]);
    });

    it("keeps the scope empty-array-means-all special case", () => {
      const cleared = applyPreferenceField(
        { ...defaults, scope: ["beginner"] },
        "scope",
        "-beginner",
      );
      expect(cleared.scope).toBeUndefined();
    });

    it("validates enum-array members", () => {
      expect(() => applyPreferenceField(defaults, "scope", "expert")).toThrow(
        "Invalid value",
      );
    });

    it("rejects an unknown key with the sorted key list", () => {
      expect(() => applyPreferenceField(defaults, "nope", "x")).toThrow(
        "Unknown config key",
      );
    });

    it("does not mutate the input preferences object", () => {
      const input = ScoutPreferencesSchema.parse({ minStars: 50 });
      applyPreferenceField(input, "minStars", "999");
      expect(input.minStars).toBe(50);
    });
  });
});
