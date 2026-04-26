import { describe, it, expect, vi } from "vitest";
import { triageWithSLM, buildTriageInput } from "./slm-triage.js";

const ISSUE = {
  title: "Add a way to escape special characters in repo names",
  labels: ["good first issue"],
  body: "Repo names with `+` get URL-encoded incorrectly. Should fix the encoding pass.",
};

function mockFetchOk(body: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

describe("triageWithSLM", () => {
  it("returns null when no model is configured", async () => {
    const result = await triageWithSLM(
      { issue: ISSUE, linkedPRExists: false },
      { model: "" },
    );
    expect(result).toBeNull();
  });

  it("returns the parsed SLM result on a valid response", async () => {
    const fetchImpl = mockFetchOk({
      message: {
        content: JSON.stringify({
          decision: "pursue",
          confidence: "high",
          reasons: ["small scope", "clear acceptance"],
        }),
      },
    });

    const result = await triageWithSLM(
      { issue: ISSUE, linkedPRExists: false },
      { model: "gemma4:e4b", fetchImpl },
    );

    expect(result).toEqual({
      decision: "pursue",
      confidence: "high",
      reasons: ["small scope", "clear acceptance"],
      modelVersion: "gemma4:e4b",
    });
  });

  it("returns null when Ollama returns a non-200 status", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("server error", { status: 500 }),
    ) as unknown as typeof fetch;

    const result = await triageWithSLM(
      { issue: ISSUE, linkedPRExists: false },
      { model: "gemma4:e4b", fetchImpl },
    );

    expect(result).toBeNull();
  });

  it("returns null when fetch rejects (e.g. connection refused)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await triageWithSLM(
      { issue: ISSUE, linkedPRExists: false },
      { model: "gemma4:e4b", fetchImpl },
    );

    expect(result).toBeNull();
  });

  it("returns null when the response body is not valid JSON", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not valid json", { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await triageWithSLM(
      { issue: ISSUE, linkedPRExists: false },
      { model: "gemma4:e4b", fetchImpl },
    );

    expect(result).toBeNull();
  });

  it("returns null when the model content is not parseable JSON (schema enforcement disagreement)", async () => {
    const fetchImpl = mockFetchOk({
      message: { content: "this is not json" },
    });

    const result = await triageWithSLM(
      { issue: ISSUE, linkedPRExists: false },
      { model: "gemma4:e4b", fetchImpl },
    );

    expect(result).toBeNull();
  });

  it("returns null when decision is outside the allowed enum", async () => {
    const fetchImpl = mockFetchOk({
      message: {
        content: JSON.stringify({
          decision: "maybe", // invalid
          confidence: "low",
          reasons: ["unsure"],
        }),
      },
    });

    const result = await triageWithSLM(
      { issue: ISSUE, linkedPRExists: false },
      { model: "gemma4:e4b", fetchImpl },
    );

    expect(result).toBeNull();
  });

  it("returns null when reasons is empty", async () => {
    const fetchImpl = mockFetchOk({
      message: {
        content: JSON.stringify({
          decision: "skip",
          confidence: "high",
          reasons: [],
        }),
      },
    });

    const result = await triageWithSLM(
      { issue: ISSUE, linkedPRExists: false },
      { model: "gemma4:e4b", fetchImpl },
    );

    expect(result).toBeNull();
  });

  it("returns null when reasons has more than three entries", async () => {
    const fetchImpl = mockFetchOk({
      message: {
        content: JSON.stringify({
          decision: "skip",
          confidence: "high",
          reasons: ["a", "b", "c", "d"],
        }),
      },
    });

    const result = await triageWithSLM(
      { issue: ISSUE, linkedPRExists: false },
      { model: "gemma4:e4b", fetchImpl },
    );

    expect(result).toBeNull();
  });

  it("posts to the configured host", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                decision: "skip",
                confidence: "low",
                reasons: ["x"],
              }),
            },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    await triageWithSLM(
      { issue: ISSUE, linkedPRExists: false },
      { model: "gemma4:e4b", host: "http://example.test:99999", fetchImpl },
    );

    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "http://example.test:99999/api/chat",
    );
  });

  it("includes the configured model in the request body", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                decision: "skip",
                confidence: "low",
                reasons: ["x"],
              }),
            },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    await triageWithSLM(
      { issue: ISSUE, linkedPRExists: false },
      { model: "qwen3:4b", fetchImpl },
    );

    const body = JSON.parse(
      (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body.model).toBe("qwen3:4b");
    expect(body.format).toBeDefined();
    expect(body.options.temperature).toBe(0.1);
  });
});

describe("buildTriageInput", () => {
  it("flattens issue and linkedPR existence into prompt input", () => {
    const result = buildTriageInput({
      issue: { title: "T", labels: ["L"], body: "B" } as Parameters<
        typeof buildTriageInput
      >[0]["issue"],
      linkedPR: {
        number: 1,
        author: "x",
        state: "open",
        merged: false,
        url: "https://x",
      },
    });
    expect(result).toEqual({
      issue: { title: "T", labels: ["L"], body: "B" },
      linkedPRExists: true,
    });
  });

  it("sets linkedPRExists to false when null", () => {
    const result = buildTriageInput({
      issue: { title: "T", labels: [], body: "" } as Parameters<
        typeof buildTriageInput
      >[0]["issue"],
      linkedPR: null,
    });
    expect(result.linkedPRExists).toBe(false);
  });
});
