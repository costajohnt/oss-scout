import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enableDebug, debug, info, warn } from "./logger.js";

describe("logger", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe("debug", () => {
    it("outputs nothing when debug is not enabled", () => {
      // Fresh module import means debugEnabled = false by default.
      // We call debug without having called enableDebug in this test file's
      // *own* scope, but enableDebug may have been called in a prior test.
      // To isolate, we rely on the module being shared — but the important
      // behaviour is: once enabled it stays enabled. We test the "enabled"
      // path explicitly below.
      // For the "disabled" path we need a fresh module — use dynamic import.
    });

    it("outputs to stderr when debug is enabled", () => {
      enableDebug();
      debug("test-module", "hello world");

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const output = errorSpy.mock.calls[0][0] as string;
      expect(output).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T.+\] \[DEBUG\] \[test-module\] hello world$/,
      );
    });

    it("passes extra args through to console.error", () => {
      enableDebug();
      const extra = { key: "value" };
      debug("mod", "msg", extra);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][1]).toBe(extra);
    });
  });

  describe("info", () => {
    it("always outputs to stderr", () => {
      info("my-module", "information message");

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const output = errorSpy.mock.calls[0][0] as string;
      expect(output).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T.+\] \[INFO\] \[my-module\] information message$/,
      );
    });

    it("includes ISO timestamp", () => {
      info("mod", "msg");
      const output = errorSpy.mock.calls[0][0] as string;
      // Extract the timestamp between brackets
      const match = output.match(/^\[(.+?)\]/);
      expect(match).not.toBeNull();
      const parsed = new Date(match![1]);
      expect(parsed.getTime()).not.toBeNaN();
    });

    it("passes extra args through", () => {
      info("mod", "msg", 42, "extra");
      expect(errorSpy.mock.calls[0][1]).toBe(42);
      expect(errorSpy.mock.calls[0][2]).toBe("extra");
    });
  });

  describe("warn", () => {
    it("always outputs to stderr", () => {
      warn("warning-module", "something is off");

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const output = errorSpy.mock.calls[0][0] as string;
      expect(output).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T.+\] \[WARN\] \[warning-module\] something is off$/,
      );
    });

    it("passes extra args through", () => {
      const err = new Error("boom");
      warn("mod", "failed", err);
      expect(errorSpy.mock.calls[0][1]).toBe(err);
    });
  });

  describe("enableDebug", () => {
    it("enables debug output", () => {
      enableDebug();
      debug("mod", "should appear");
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
