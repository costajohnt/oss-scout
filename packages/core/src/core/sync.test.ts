import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScoutStateSchema } from "./schemas.js";

const { pullsGet } = vi.hoisted(() => ({ pullsGet: vi.fn() }));

vi.mock("./github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github.js")>();
  return {
    ...actual,
    getOctokit: () =>
      ({ pulls: { get: pullsGet } }) as unknown as ReturnType<
        typeof actual.getOctokit
      >,
  };
});

const { OssScout } = await import("../scout.js");

function pr(n: number) {
  return {
    url: `https://github.com/owner/repo/pull/${n}`,
    title: `PR ${n}`,
    openedAt: "2026-01-01T00:00:00.000Z",
  };
}

function reply(state: string, merged: boolean) {
  return {
    data: {
      state,
      merged,
      merged_at: merged ? "2026-06-01T00:00:00.000Z" : null,
      closed_at: state === "closed" ? "2026-06-02T00:00:00.000Z" : null,
    },
  };
}

describe("syncOpenPRs (#164)", () => {
  beforeEach(() => pullsGet.mockReset());

  it("transitions merged and closed PRs, keeps open ones, and prunes resolved", async () => {
    const state = ScoutStateSchema.parse({ version: 1 });
    state.openPRs = [pr(1), pr(2), pr(3)];
    const scout = new OssScout("token", state);

    pullsGet
      .mockResolvedValueOnce(reply("closed", true)) // #1 merged
      .mockResolvedValueOnce(reply("closed", false)) // #2 closed-unmerged
      .mockResolvedValueOnce(reply("open", false)); // #3 still open

    const result = await scout.syncOpenPRs();

    expect(result).toMatchObject({
      checked: 3,
      merged: 1,
      closed: 1,
      stillOpen: 1,
      errors: 0,
    });
    // Only the still-open PR remains tracked.
    const remaining = scout.getState().openPRs ?? [];
    expect(remaining.map((p) => p.url)).toEqual([
      "https://github.com/owner/repo/pull/3",
    ]);
    // The merge was recorded (feeds repo scoring).
    expect(
      scout.getState().mergedPRs.some((p) => p.url.endsWith("/pull/1")),
    ).toBe(true);
    expect(
      scout.getState().closedPRs.some((p) => p.url.endsWith("/pull/2")),
    ).toBe(true);
  });

  it("leaves an entry in place on a transient (non-fatal) error", async () => {
    const state = ScoutStateSchema.parse({ version: 1 });
    state.openPRs = [pr(9)];
    const scout = new OssScout("token", state);

    pullsGet.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );

    const result = await scout.syncOpenPRs();
    expect(result).toMatchObject({ checked: 1, errors: 1, stillOpen: 0 });
    expect((scout.getState().openPRs ?? []).length).toBe(1);
  });

  it("propagates a rate-limit error (fatal)", async () => {
    const state = ScoutStateSchema.parse({ version: 1 });
    state.openPRs = [pr(5)];
    const scout = new OssScout("token", state);

    pullsGet.mockRejectedValueOnce(
      Object.assign(new Error("API rate limit exceeded"), { status: 403 }),
    );

    await expect(scout.syncOpenPRs()).rejects.toThrow("rate limit");
  });
});
