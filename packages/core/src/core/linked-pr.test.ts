import { describe, it, expect } from "vitest";
import { isLinkedPRStalled, STALLED_PR_THRESHOLD_DAYS } from "./linked-pr.js";
import type { LinkedPR } from "./schemas.js";

const NOW = new Date("2026-05-09T00:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeLinkedPR(overrides: Partial<LinkedPR> = {}): LinkedPR {
  return {
    number: 1,
    author: "alice",
    state: "open",
    merged: false,
    url: "https://github.com/foo/bar/pull/1",
    updatedAt: daysAgo(45),
    ...overrides,
  };
}

describe("isLinkedPRStalled", () => {
  it("returns false for a null linked PR", () => {
    expect(isLinkedPRStalled(null, NOW)).toBe(false);
  });

  it("returns false for an undefined linked PR", () => {
    expect(isLinkedPRStalled(undefined, NOW)).toBe(false);
  });

  it("returns false when the PR is closed", () => {
    const pr = makeLinkedPR({ state: "closed", updatedAt: daysAgo(45) });
    expect(isLinkedPRStalled(pr, NOW)).toBe(false);
  });

  it("returns false when the PR is merged (closed + merged)", () => {
    const pr = makeLinkedPR({
      state: "closed",
      merged: true,
      updatedAt: daysAgo(45),
    });
    expect(isLinkedPRStalled(pr, NOW)).toBe(false);
  });

  it("returns false when updatedAt is missing", () => {
    const pr = makeLinkedPR({ updatedAt: undefined });
    expect(isLinkedPRStalled(pr, NOW)).toBe(false);
  });

  it("returns false for a fresh open PR (10 days old)", () => {
    const pr = makeLinkedPR({ updatedAt: daysAgo(10) });
    expect(isLinkedPRStalled(pr, NOW)).toBe(false);
  });

  it("returns true for a stalled open PR (45 days old)", () => {
    const pr = makeLinkedPR({ updatedAt: daysAgo(45) });
    expect(isLinkedPRStalled(pr, NOW)).toBe(true);
  });

  it("returns true at exactly the 30-day boundary", () => {
    const pr = makeLinkedPR({ updatedAt: daysAgo(30) });
    expect(isLinkedPRStalled(pr, NOW)).toBe(true);
  });

  it("returns false at 29.5 days (just below the boundary)", () => {
    const pr = makeLinkedPR({ updatedAt: daysAgo(29.5) });
    expect(isLinkedPRStalled(pr, NOW)).toBe(false);
  });

  it("returns false for an invalid date string", () => {
    const pr = makeLinkedPR({ updatedAt: "not-a-date" });
    expect(isLinkedPRStalled(pr, NOW)).toBe(false);
  });

  it("respects a custom thresholdDays argument", () => {
    const pr = makeLinkedPR({ updatedAt: daysAgo(15) });
    expect(isLinkedPRStalled(pr, NOW, 10)).toBe(true);
    expect(isLinkedPRStalled(pr, NOW, 30)).toBe(false);
  });

  it("exports STALLED_PR_THRESHOLD_DAYS as 30", () => {
    expect(STALLED_PR_THRESHOLD_DAYS).toBe(30);
  });
});
