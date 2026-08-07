import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OssScout } from "@oss-scout/core";
import { registerResources } from "./resources.js";

function createMockScout(overrides: Partial<OssScout> = {}): OssScout {
  return {
    getPreferences: vi.fn().mockReturnValue({
      languages: ["typescript"],
      minStars: 50,
    }),
    getSavedResults: vi.fn().mockReturnValue([
      {
        issueUrl: "https://github.com/o/r/issues/1",
        repo: "o/r",
        viabilityScore: 80,
      },
    ]),
    getState: vi.fn().mockReturnValue({
      version: 1,
      repoScores: {
        "o/r": { mergedPRCount: 3, closedWithoutMergeCount: 0, score: 8 },
      },
    }),
    ...overrides,
  } as unknown as OssScout;
}

/**
 * Extract the read callback for a given resource name from the McpServer spy.
 * Registration signature: server.resource(name, uri, metadata, readCallback)
 * — the callback is always the last argument.
 */
function getResourceHandler(
  server: McpServer,
  name: string,
): (...args: unknown[]) => Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}> {
  const calls = vi.mocked(server.resource).mock.calls;
  const call = calls.find((c) => c[0] === name);
  if (!call) throw new Error(`Resource "${name}" not registered`);
  return call[call.length - 1] as (...args: unknown[]) => Promise<{
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  }>;
}

describe("registerResources", () => {
  let server: McpServer;
  let scout: OssScout;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.1" });
    scout = createMockScout();
    vi.spyOn(server, "resource");
    registerResources(server, scout);
  });

  it("registers all three resources with their scout:// URIs", () => {
    expect(server.resource).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(server.resource).mock.calls;
    const byName = new Map(calls.map((c) => [c[0], c[1]]));
    expect(byName.get("config")).toBe("scout://config");
    expect(byName.get("results")).toBe("scout://results");
    expect(byName.get("scores")).toBe("scout://scores");
  });

  it("scout://config returns the current preferences as JSON", async () => {
    const read = getResourceHandler(server, "config");
    const { contents } = await read();

    expect(contents).toHaveLength(1);
    expect(contents[0].uri).toBe("scout://config");
    expect(contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(contents[0].text)).toEqual({
      languages: ["typescript"],
      minStars: 50,
    });
  });

  it("scout://results returns the saved results as JSON", async () => {
    const read = getResourceHandler(server, "results");
    const { contents } = await read();

    expect(contents[0].uri).toBe("scout://results");
    const parsed = JSON.parse(contents[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].issueUrl).toBe("https://github.com/o/r/issues/1");
  });

  it("scout://scores returns the state's repoScores as JSON", async () => {
    const read = getResourceHandler(server, "scores");
    const { contents } = await read();

    expect(contents[0].uri).toBe("scout://scores");
    const parsed = JSON.parse(contents[0].text);
    expect(parsed["o/r"].score).toBe(8);
  });

  it("reads reflect live scout state, not a boot-time snapshot", async () => {
    // Resources must call through on every read; a captured snapshot would
    // go stale as tools mutate the scout between reads.
    const read = getResourceHandler(server, "results");
    await read();
    vi.mocked(scout.getSavedResults).mockReturnValue([]);
    const { contents } = await read();
    expect(JSON.parse(contents[0].text)).toEqual([]);
    expect(scout.getSavedResults).toHaveBeenCalledTimes(2);
  });
});
