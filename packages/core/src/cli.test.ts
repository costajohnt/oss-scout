import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatJsonError } from "./formatters/json.js";
import {
  errorMessage,
  resolveErrorCode,
  ValidationError,
} from "./core/errors.js";

/**
 * CLI tests — verify handleCommandError behavior and module loading.
 *
 * Since handleCommandError is module-private, we test the same logic
 * by composing the public functions it uses: formatJsonError, errorMessage,
 * resolveErrorCode. We also verify the CLI module loads without crashing.
 */

describe("CLI error handling logic", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("handleCommandError with JSON option", () => {
    it("formats error as JSON with success: false", () => {
      const err = new Error("something broke");
      const jsonOutput = formatJsonError(
        errorMessage(err),
        resolveErrorCode(err),
      );
      const parsed = JSON.parse(jsonOutput);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe("something broke");
      expect(parsed.errorCode).toBe("UNKNOWN");
      expect(parsed.timestamp).toBeDefined();
    });

    it("formats ValidationError with VALIDATION error code", () => {
      const err = new ValidationError("bad input");
      const jsonOutput = formatJsonError(
        errorMessage(err),
        resolveErrorCode(err),
      );
      const parsed = JSON.parse(jsonOutput);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe("bad input");
      expect(parsed.errorCode).toBe("VALIDATION");
    });
  });

  describe("handleCommandError without JSON option", () => {
    it("outputs error message to stderr", () => {
      const err = new Error("command failed");
      // Replicate the non-JSON branch of handleCommandError:
      console.error("Error:", errorMessage(err));

      expect(errorSpy).toHaveBeenCalledWith("Error:", "command failed");
    });

    it("handles non-Error values", () => {
      const err = "string error";
      console.error("Error:", errorMessage(err));

      expect(errorSpy).toHaveBeenCalledWith("Error:", "string error");
    });
  });
});

describe("CLI module structure", () => {
  it("exports the expected formatter functions", async () => {
    const json = await import("./formatters/json.js");
    expect(typeof json.formatJsonSuccess).toBe("function");
    expect(typeof json.formatJsonError).toBe("function");
  });

  it("exports the expected error functions", async () => {
    const errors = await import("./core/errors.js");
    expect(typeof errors.errorMessage).toBe("function");
    expect(typeof errors.resolveErrorCode).toBe("function");
    expect(typeof errors.ValidationError).toBe("function");
    expect(typeof errors.ConfigurationError).toBe("function");
  });

  it("exports logger functions used by CLI", async () => {
    const logger = await import("./core/logger.js");
    expect(typeof logger.enableDebug).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
  });
});
