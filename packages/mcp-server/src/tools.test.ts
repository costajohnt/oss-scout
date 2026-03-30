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
    saveResults: vi.fn(),
    getSavedResults: vi.fn().mockReturnValue([]),
    getSkippedIssues: vi.fn().mockReturnValue([]),
    skipIssue: vi.fn(),
    unskipIssue: vi.fn(),
    clearSkippedIssues: vi.fn(),
    checkpoint: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as OssScout;
}

/**
 * Extract the handler for a given tool name from the McpServer spy.
 * Tool registration signature: server.tool(name, description, schema?, handler)
 * The handler is always the last argument.
 */
function getToolHandler(
  server: McpServer,
  toolName: string,
): (...args: unknown[]) => Promise<unknown> {
  const calls = vi.mocked(server.tool).mock.calls;
  const call = calls.find((c) => c[0] === toolName);
  if (!call) throw new Error(`Tool "${toolName}" not registered`);
  // Handler is the last argument
  return call[call.length - 1] as (...args: unknown[]) => Promise<unknown>;
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

  it("registers all five tools", () => {
    expect(server.tool).toHaveBeenCalledTimes(5);

    const calls = vi.mocked(server.tool).mock.calls;
    const names = calls.map((c) => c[0]);
    expect(names).toContain("search");
    expect(names).toContain("vet");
    expect(names).toContain("skip");
    expect(names).toContain("config");
    expect(names).toContain("config-set");
  });

  describe("search tool execution", () => {
    it("returns JSON text content on success", async () => {
      const handler = getToolHandler(server, "search");
      const result = (await handler({ maxResults: 5 }, {})) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.candidates).toHaveLength(1);
      expect(parsed.candidates[0].issue.repo).toBe("test/repo");
    });

    it("calls scout.search with parsed options", async () => {
      const handler = getToolHandler(server, "search");
      await handler({ maxResults: 3, strategies: "broad,merged" }, {});

      expect(scout.search).toHaveBeenCalledWith({
        maxResults: 3,
        strategies: ["broad", "merged"],
      });
    });

    it("saves results and checkpoints after search", async () => {
      const handler = getToolHandler(server, "search");
      await handler({ maxResults: 5 }, {});

      expect(scout.saveResults).toHaveBeenCalled();
      expect(scout.checkpoint).toHaveBeenCalled();
    });

    it("returns isError on failure", async () => {
      const errorScout = createMockScout({
        search: vi.fn().mockRejectedValue(new Error("API rate limited")),
      });
      const errorServer = new McpServer({ name: "test", version: "0.0.1" });
      vi.spyOn(errorServer, "tool");
      registerTools(errorServer, errorScout);

      const handler = getToolHandler(errorServer, "search");
      const result = (await handler({}, {})) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("API rate limited");
    });
  });

  describe("vet tool execution", () => {
    it("returns JSON text content on success", async () => {
      const handler = getToolHandler(server, "vet");
      const result = (await handler(
        { issueUrl: "https://github.com/test/repo/issues/1" },
        {},
      )) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.recommendation).toBe("approve");
      expect(parsed.issue.repo).toBe("test/repo");
    });

    it("calls scout.vetIssue with the URL", async () => {
      const handler = getToolHandler(server, "vet");
      await handler(
        { issueUrl: "https://github.com/owner/repo/issues/99" },
        {},
      );

      expect(scout.vetIssue).toHaveBeenCalledWith(
        "https://github.com/owner/repo/issues/99",
      );
    });

    it("returns isError on failure", async () => {
      const errorScout = createMockScout({
        vetIssue: vi.fn().mockRejectedValue(new Error("Issue not found")),
      });
      const errorServer = new McpServer({ name: "test", version: "0.0.1" });
      vi.spyOn(errorServer, "tool");
      registerTools(errorServer, errorScout);

      const handler = getToolHandler(errorServer, "vet");
      const result = (await handler(
        { issueUrl: "https://github.com/test/repo/issues/999" },
        {},
      )) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Issue not found");
    });
  });

  describe("config tool execution", () => {
    it("returns preferences as JSON", async () => {
      const handler = getToolHandler(server, "config");
      const result = (await handler({}, {})) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.languages).toEqual(["typescript"]);
      expect(parsed.minStars).toBe(50);
    });

    it("calls scout.getPreferences", async () => {
      const handler = getToolHandler(server, "config");
      await handler({}, {});

      expect(scout.getPreferences).toHaveBeenCalled();
    });
  });

  describe("config-set tool execution", () => {
    it("returns updated preferences on valid key", async () => {
      const handler = getToolHandler(server, "config-set");
      const result = (await handler({ key: "minStars", value: "100" }, {})) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(scout.updatePreferences).toHaveBeenCalledWith({ minStars: 100 });
      expect(scout.checkpoint).toHaveBeenCalled();
    });

    it("returns isError for invalid key", async () => {
      const handler = getToolHandler(server, "config-set");
      const result = (await handler(
        { key: "nonExistentKey", value: "whatever" },
        {},
      )) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown config key");
      expect(result.content[0].text).toContain("nonExistentKey");
    });

    it("parses array values from comma-separated strings", async () => {
      const handler = getToolHandler(server, "config-set");
      await handler({ key: "languages", value: "rust, python, go" }, {});

      expect(scout.updatePreferences).toHaveBeenCalledWith({
        languages: ["rust", "python", "go"],
      });
    });

    it("parses boolean values", async () => {
      const handler = getToolHandler(server, "config-set");
      await handler({ key: "includeDocIssues", value: "false" }, {});

      expect(scout.updatePreferences).toHaveBeenCalledWith({
        includeDocIssues: false,
      });
    });

    it("returns isError for invalid number", async () => {
      const handler = getToolHandler(server, "config-set");
      const result = (await handler(
        { key: "minStars", value: "not-a-number" },
        {},
      )) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid number");
    });

    it("returns isError for invalid boolean", async () => {
      const handler = getToolHandler(server, "config-set");
      const result = (await handler(
        { key: "includeDocIssues", value: "maybe" },
        {},
      )) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid boolean");
    });
  });
});
