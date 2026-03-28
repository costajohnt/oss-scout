import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OssScout } from "@oss-scout/core";
import { registerTools } from "./tools.js";

function createMockScout(overrides: Partial<OssScout> = {}): OssScout {
  return {
    search: vi.fn().mockResolvedValue({
      candidates: [
        {
          issue: { repo: "test/repo", number: 1, title: "Test issue" },
          viabilityScore: 85,
        },
      ],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ["broad"],
    }),
    vetIssue: vi.fn().mockResolvedValue({
      issue: { repo: "test/repo", number: 1, title: "Test issue" },
      viabilityScore: 90,
      recommendation: "approve",
    }),
    getPreferences: vi.fn().mockReturnValue({
      languages: ["typescript"],
      minStars: 50,
    }),
    updatePreferences: vi.fn(),
    ...overrides,
  } as unknown as OssScout;
}

describe("registerTools", () => {
  let server: McpServer;
  let scout: OssScout;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.1" });
    scout = createMockScout();
    vi.spyOn(server, "tool");
    registerTools(server, scout);
  });

  it("registers all four tools", () => {
    expect(server.tool).toHaveBeenCalledTimes(4);

    const calls = vi.mocked(server.tool).mock.calls;
    const names = calls.map((c) => c[0]);
    expect(names).toContain("search");
    expect(names).toContain("vet");
    expect(names).toContain("config");
    expect(names).toContain("config-set");
  });
});
