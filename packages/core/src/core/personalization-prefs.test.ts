import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScoutStateSchema } from "./schemas.js";

// Capture the options IssueDiscovery.searchIssues is called with so we can
// assert the persisted-preference fallback / flag-override behavior (#168).
const { searchIssuesSpy } = vi.hoisted(() => ({
  searchIssuesSpy: vi.fn(),
}));

vi.mock("./issue-discovery.js", () => ({
  IssueDiscovery: class {
    rateLimitWarning: string | null = null;
    async searchIssues(opts: unknown) {
      searchIssuesSpy(opts);
      return { candidates: [], strategiesUsed: ["broad"] };
    }
  },
}));

vi.mock("./http-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./http-cache.js")>();
  return {
    ...actual,
    getHttpCache: () =>
      ({ evictStale: () => 0 }) as unknown as ReturnType<
        typeof actual.getHttpCache
      >,
  };
});

const { OssScout } = await import("../scout.js");

function scoutWith(prefs: Record<string, unknown>) {
  const state = ScoutStateSchema.parse({ version: 1, preferences: prefs });
  return new OssScout("token", state);
}

describe("persisted personalization preferences (#168)", () => {
  beforeEach(() => searchIssuesSpy.mockClear());

  it("uses persisted preferLanguages/preferRepos/diversityRatio when no flag is passed", async () => {
    const scout = scoutWith({
      preferLanguages: ["rust", "go"],
      preferRepos: ["vercel/next.js"],
      diversityRatio: 0.3,
    });
    await scout.search({ maxResults: 5 });
    expect(searchIssuesSpy).toHaveBeenCalledTimes(1);
    const opts = searchIssuesSpy.mock.calls[0][0];
    expect(opts.preferLanguages).toEqual(["rust", "go"]);
    expect(opts.preferRepos).toEqual(["vercel/next.js"]);
    expect(opts.diversityRatio).toBe(0.3);
  });

  it("lets a per-call flag override the persisted preference", async () => {
    const scout = scoutWith({
      preferLanguages: ["rust"],
      diversityRatio: 0.3,
    });
    await scout.search({
      maxResults: 5,
      preferLanguages: ["python"],
      diversityRatio: 0,
    });
    const opts = searchIssuesSpy.mock.calls[0][0];
    expect(opts.preferLanguages).toEqual(["python"]);
    expect(opts.diversityRatio).toBe(0);
  });

  it("passes undefined boosts when neither flag nor preference is set", async () => {
    const scout = scoutWith({});
    await scout.search({ maxResults: 5 });
    const opts = searchIssuesSpy.mock.calls[0][0];
    expect(opts.preferLanguages).toBeUndefined();
    expect(opts.preferRepos).toBeUndefined();
    expect(opts.diversityRatio).toBe(0);
  });
});
