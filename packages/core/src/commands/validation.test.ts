import { describe, it, expect } from "vitest";
import {
  validateUrl,
  validateGitHubUrl,
  ISSUE_URL_PATTERN,
} from "./validation.js";
import { ValidationError } from "../core/errors.js";

describe("validation", () => {
  describe("validateUrl", () => {
    it("accepts a normal URL", () => {
      const url = "https://github.com/owner/repo/issues/123";
      expect(validateUrl(url)).toBe(url);
    });

    it("returns the URL unchanged", () => {
      const url = "https://example.com";
      expect(validateUrl(url)).toBe(url);
    });

    it("rejects URLs exceeding 2048 characters", () => {
      const longUrl = "https://example.com/" + "a".repeat(2040);
      expect(longUrl.length).toBeGreaterThan(2048);

      expect(() => validateUrl(longUrl)).toThrow(ValidationError);
      expect(() => validateUrl(longUrl)).toThrow(
        "URL exceeds maximum length of 2048 characters",
      );
    });

    it("accepts a URL exactly at 2048 characters", () => {
      const url = "https://example.com/" + "a".repeat(2028);
      expect(url.length).toBe(2048);
      expect(validateUrl(url)).toBe(url);
    });
  });

  describe("validateGitHubUrl", () => {
    it("accepts a valid GitHub issue URL", () => {
      expect(() =>
        validateGitHubUrl(
          "https://github.com/owner/repo/issues/123",
          ISSUE_URL_PATTERN,
          "issue",
        ),
      ).not.toThrow();
    });

    it("rejects a non-issue URL", () => {
      expect(() =>
        validateGitHubUrl(
          "https://github.com/owner/repo/pull/123",
          ISSUE_URL_PATTERN,
          "issue",
        ),
      ).toThrow(ValidationError);
    });

    it("throws with a helpful message including expected format", () => {
      try {
        validateGitHubUrl(
          "https://github.com/owner/repo/pull/456",
          ISSUE_URL_PATTERN,
          "issue",
        );
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toContain("Invalid issue URL");
        expect((err as ValidationError).message).toContain(
          "https://github.com/owner/repo/issues/123",
        );
      }
    });

    it("rejects a bare repo URL", () => {
      expect(() =>
        validateGitHubUrl(
          "https://github.com/owner/repo",
          ISSUE_URL_PATTERN,
          "issue",
        ),
      ).toThrow(ValidationError);
    });
  });

  describe("ISSUE_URL_PATTERN", () => {
    it("matches a valid issue URL", () => {
      expect(
        ISSUE_URL_PATTERN.test("https://github.com/owner/repo/issues/123"),
      ).toBe(true);
    });

    it("matches issue URLs with different owners/repos", () => {
      expect(
        ISSUE_URL_PATTERN.test(
          "https://github.com/facebook/react/issues/99999",
        ),
      ).toBe(true);
    });

    it("does not match PR URLs", () => {
      expect(
        ISSUE_URL_PATTERN.test("https://github.com/owner/repo/pull/123"),
      ).toBe(false);
    });

    it("does not match partial URLs without issue number", () => {
      expect(
        ISSUE_URL_PATTERN.test("https://github.com/owner/repo/issues"),
      ).toBe(false);
    });

    it("does not match URLs with trailing path segments", () => {
      expect(
        ISSUE_URL_PATTERN.test(
          "https://github.com/owner/repo/issues/123/comments",
        ),
      ).toBe(false);
    });

    it("does not match non-GitHub URLs", () => {
      expect(
        ISSUE_URL_PATTERN.test("https://gitlab.com/owner/repo/issues/123"),
      ).toBe(false);
    });

    it("does not match URLs with query parameters (regex anchored)", () => {
      expect(
        ISSUE_URL_PATTERN.test(
          "https://github.com/owner/repo/issues/123?foo=bar",
        ),
      ).toBe(false);
    });
  });
});
