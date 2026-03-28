import { describe, it, expect } from "vitest";
import { formatJsonSuccess, formatJsonError } from "./json.js";

const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("formatJsonSuccess", () => {
  it("wraps data in success envelope", () => {
    const output = JSON.parse(formatJsonSuccess({ foo: 1 }));
    expect(output.success).toBe(true);
    expect(output.data).toEqual({ foo: 1 });
    expect(output.timestamp).toMatch(ISO_REGEX);
  });

  it("does not include error field", () => {
    const output = JSON.parse(formatJsonSuccess("test"));
    expect(output.error).toBeUndefined();
  });

  it("handles null data", () => {
    const output = JSON.parse(formatJsonSuccess(null));
    expect(output.success).toBe(true);
    expect(output.data).toBeNull();
  });

  it("handles array data", () => {
    const output = JSON.parse(formatJsonSuccess([1, 2, 3]));
    expect(output.data).toEqual([1, 2, 3]);
  });

  it("outputs pretty-printed JSON", () => {
    const raw = formatJsonSuccess({ key: "value" });
    expect(raw).toContain("\n");
    expect(raw).toContain("  ");
  });
});

describe("formatJsonError", () => {
  it("wraps error in failure envelope", () => {
    const output = JSON.parse(formatJsonError("boom"));
    expect(output.success).toBe(false);
    expect(output.error).toBe("boom");
    expect(output.timestamp).toMatch(ISO_REGEX);
  });

  it("does not include data field", () => {
    const output = JSON.parse(formatJsonError("boom"));
    expect(output.data).toBeUndefined();
  });

  it("includes errorCode when provided", () => {
    const output = JSON.parse(formatJsonError("Auth failed", "AUTH_REQUIRED"));
    expect(output.errorCode).toBe("AUTH_REQUIRED");
  });

  it("omits errorCode when not provided", () => {
    const output = JSON.parse(formatJsonError("fail"));
    expect(output.errorCode).toBeUndefined();
  });
});
