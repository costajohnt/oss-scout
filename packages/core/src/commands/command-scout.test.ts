import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScoutStateSchema } from "../core/schemas.js";

const createScoutMock = vi.hoisted(() => vi.fn());
vi.mock("../scout.js", () => ({
  createScout: createScoutMock,
}));

import { buildCommandScout } from "./command-scout.js";

describe("buildCommandScout (#115)", () => {
  beforeEach(() => {
    createScoutMock.mockReset();
    createScoutMock.mockResolvedValue({});
  });

  it("uses gist mode when the persistence preference is gist", async () => {
    const state = ScoutStateSchema.parse({
      version: 1,
      preferences: { persistence: "gist" },
    });
    await buildCommandScout(state, "tok");
    expect(createScoutMock).toHaveBeenCalledWith({
      githubToken: "tok",
      persistence: "gist",
    });
  });

  it("uses provided mode (local file) when the preference is local", async () => {
    const state = ScoutStateSchema.parse({
      version: 1,
      preferences: { persistence: "local" },
    });
    await buildCommandScout(state, "tok");
    expect(createScoutMock).toHaveBeenCalledWith({
      githubToken: "tok",
      persistence: "provided",
      initialState: state,
    });
  });

  it("defaults to provided mode when the preference is unset", async () => {
    // ScoutPreferencesSchema defaults persistence to "local"
    const state = ScoutStateSchema.parse({ version: 1 });
    await buildCommandScout(state, "tok");
    expect(createScoutMock).toHaveBeenCalledWith(
      expect.objectContaining({ persistence: "provided" }),
    );
  });
});
