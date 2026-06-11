import { describe, it, expect, vi } from "vitest";

// Importing the package entry must have no side effects: no server boot,
// no token read, no process.exit (#148).
describe("@oss-scout/mcp library import", () => {
  it("exposes the library surface without running anything", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const mod = await import("./index.js");

    expect(typeof mod.createServer).toBe("function");
    expect(typeof mod.registerTools).toBe("function");
    expect(typeof mod.registerResources).toBe("function");
    expect(typeof mod.runServer).toBe("function");
    expect(mod.SERVER_INFO.name).toBe("oss-scout-mcp");
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("createServer wires a server without connecting a transport", async () => {
    const { createServer } = await import("./index.js");
    const scout = {
      search: vi.fn(),
      vetIssue: vi.fn(),
      features: vi.fn(),
      getPreferences: vi.fn(() => ({})),
      getSavedResults: vi.fn(() => []),
      getState: vi.fn(() => ({ repoScores: {} })),
    } as unknown as Parameters<typeof createServer>[0];
    const server = createServer(scout);
    expect(server).toBeDefined();
  });
});
