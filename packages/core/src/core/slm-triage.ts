/**
 * Optional SLM (small language model) pre-triage pass for vetted issues
 * (oss-autopilot#1122).
 *
 * When the user has an Ollama instance running locally and a model
 * configured via `slmTriageModel`, vetting can call out to that model
 * for a structured classification of each candidate issue. The result
 * is surfaced on `IssueCandidate.slmTriage` so consumers (autopilot
 * agents, dashboard, vet-list output) can show the call up-front and
 * skip the cost of reading every issue body manually.
 *
 * Design highlights:
 * - **Fail open.** Any failure (no model configured, Ollama down,
 *   timeout, malformed JSON, schema mismatch) returns `null`. Triage
 *   must never block the rest of the vetting pipeline.
 * - **Schema-enforced JSON.** Uses Ollama's `format` parameter so the
 *   decoder produces JSON conformant to a fixed schema; eliminates the
 *   "model returned partial JSON" failure mode that plagues prompt-only
 *   structured-output schemes.
 * - **15s timeout.** Local SLMs vary widely in latency; 15s covers
 *   small-to-mid models on consumer hardware (Gemma 4 e4b, Qwen 3 4b).
 *   Slower models simply produce `null` and don't block vetting.
 */
import type { TrackedIssue, LinkedPR } from "./schemas.js";

/** Default Ollama HTTP endpoint when not overridden. */
const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

/** Default per-call timeout. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Hard cap on issue body length we send to the model. */
const MAX_BODY_CHARS = 2000;

/**
 * Result of an SLM triage call. The same shape Ollama is constrained to
 * produce via `format` schema enforcement.
 */
export interface SLMTriageResult {
  /** Three buckets that match human triage decisions. */
  decision: "pursue" | "investigate" | "skip";
  /** How sure the model is. Surface in UI; don't gate on it server-side. */
  confidence: "high" | "medium" | "low";
  /** Short phrases (not sentences) explaining the decision. 1–3 entries. */
  reasons: string[];
  /** Model id that produced this result. Useful when comparing runs. */
  modelVersion: string;
}

/** Inputs to a triage call. */
export interface SLMTriageInput {
  issue: Pick<TrackedIssue, "title" | "labels"> & { body?: string };
  linkedPRExists: boolean;
}

/** Runtime options for `triageWithSLM`. */
export interface SLMTriageOptions {
  /** Model id (e.g. `gemma4:e4b`). Empty/unset disables triage. */
  model: string;
  /** Override Ollama base URL. Defaults to `http://127.0.0.1:11434`. */
  host?: string;
  /** Override request timeout. */
  timeoutMs?: number;
  /** Override fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
}

/** JSON schema enforced server-side by Ollama's `format` parameter. */
const SLM_TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["pursue", "investigate", "skip"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    reasons: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 3,
    },
  },
  required: ["decision", "confidence", "reasons"],
} as const;

/** Build the user-message prompt from an issue. */
function buildPrompt(input: SLMTriageInput): string {
  const { issue, linkedPRExists } = input;
  const body = (issue.body ?? "").slice(0, MAX_BODY_CHARS);
  return [
    "You triage open-source issues for an autonomous contribution agent.",
    "Classify the issue into exactly one bucket:",
    "- pursue: small, concrete bug or feature with clear acceptance; safe for an autonomous agent to attempt without further design input",
    "- investigate: tractable but needs human reading first (ambiguous scope, design questions, recently-touched files)",
    "- skip: not actionable autonomously (epic, creative, blocked, requires upstream change, requires infra)",
    "",
    "Return JSON only matching the provided schema. Reasons must be short phrases, not sentences. 1-3 reasons total.",
    "",
    "Issue:",
    `Title: ${issue.title}`,
    `Body: ${body}`,
    `Labels: ${issue.labels.join(", ")}`,
    `Linked PR exists: ${linkedPRExists}`,
  ].join("\n");
}

/**
 * Run an SLM triage classification. Returns `null` on any failure path
 * — caller treats `null` as "no SLM signal available".
 */
export async function triageWithSLM(
  input: SLMTriageInput,
  options: SLMTriageOptions,
): Promise<SLMTriageResult | null> {
  if (!options.model) return null;

  const host = options.host ?? DEFAULT_OLLAMA_HOST;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchFn(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: "user", content: buildPrompt(input) }],
        stream: false,
        format: SLM_TRIAGE_SCHEMA,
        options: { temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Connection refused, timeout, DNS error, etc.
    return null;
  }

  if (!response.ok) return null;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  // Ollama `chat` returns { message: { content: string }, ... }.
  const content = (payload as { message?: { content?: string } })?.message
    ?.content;
  if (typeof content !== "string") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (!isValidTriageShape(parsed)) return null;

  return {
    decision: parsed.decision,
    confidence: parsed.confidence,
    reasons: parsed.reasons,
    modelVersion: options.model,
  };
}

/**
 * Adapter: build an `SLMTriageInput` from the standard scout types we
 * carry through `vetIssue`. Centralizes the mapping so callers don't
 * have to know about the prompt internals.
 */
export function buildTriageInput(args: {
  issue: TrackedIssue & { body?: string };
  linkedPR: LinkedPR | null | undefined;
}): SLMTriageInput {
  return {
    issue: {
      title: args.issue.title,
      labels: args.issue.labels,
      body: args.issue.body,
    },
    linkedPRExists: !!args.linkedPR,
  };
}

function isValidTriageShape(value: unknown): value is {
  decision: "pursue" | "investigate" | "skip";
  confidence: "high" | "medium" | "low";
  reasons: string[];
} {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    v.decision !== "pursue" &&
    v.decision !== "investigate" &&
    v.decision !== "skip"
  )
    return false;
  if (
    v.confidence !== "high" &&
    v.confidence !== "medium" &&
    v.confidence !== "low"
  )
    return false;
  if (
    !Array.isArray(v.reasons) ||
    v.reasons.length === 0 ||
    v.reasons.length > 3
  )
    return false;
  if (!v.reasons.every((r) => typeof r === "string")) return false;
  return true;
}
