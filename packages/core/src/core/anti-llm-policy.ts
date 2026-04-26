/**
 * Anti-LLM Policy — scans repo policy docs (CONTRIBUTING.md, CODE_OF_CONDUCT.md,
 * README.md) for keywords that signal an anti-AI / anti-LLM contribution policy
 * (e.g. "no AI-generated code", "human-authored only", "no Copilot contributions").
 *
 * The keyword table lives here as a single source of truth so consumers
 * can rely on a structured `AntiLLMPolicyResult` rather than re-implementing
 * the scan in agent prose.
 */

import { Octokit } from "@octokit/rest";
import { errorMessage, getHttpStatusCode, isRateLimitError } from "./errors.js";
import { warn } from "./logger.js";
import { getHttpCache } from "./http-cache.js";
import type { AntiLLMPolicyResult, AntiLLMPolicySourceFile } from "./types.js";

const MODULE = "anti-llm-policy";

/** TTL for cached anti-LLM policy scan results (1 hour). Policy docs change rarely. */
const POLICY_SCAN_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Conservative anti-LLM keyword phrases. Each entry is a lowercase substring
 * that — when present in policy text — is a strong signal of an anti-AI policy.
 * Phrases are deliberately narrow to avoid flagging "we use Copilot internally"
 * style mentions; the table can grow as new patterns are observed.
 */
export const ANTI_LLM_KEYWORDS: readonly string[] = [
  "no ai-generated",
  "no ai generated",
  "no ai-assisted",
  "no ai assisted",
  "no llm-generated",
  "no llm generated",
  "no copilot-generated",
  "no chatgpt-generated",
  "human-authored only",
  "human authored only",
  "human-written only",
  "human written only",
  "ai-free contributions",
  "llm-free contributions",
  "ai-generated code is not allowed",
  "ai-generated code will not be accepted",
  "do not submit ai-generated",
  "do not submit llm-generated",
  "do not use ai to",
  "do not use llms",
  "do not use copilot",
  "do not use chatgpt",
  "without ai assistance",
  "without llm assistance",
  "no use of generative ai",
  "ban on ai-generated",
  "prohibit ai-generated",
  "prohibits ai-generated",
] as const;

/**
 * Pure scan: does this text contain any anti-LLM keyword?
 * Case-insensitive; returns the matched keywords (deduped, in table order).
 */
export function scanForAntiLLMPolicy(text: string): {
  matched: boolean;
  matchedKeywords: string[];
} {
  if (!text) return { matched: false, matchedKeywords: [] };
  const haystack = text.toLowerCase();
  const matchedKeywords = ANTI_LLM_KEYWORDS.filter((kw) =>
    haystack.includes(kw),
  );
  return { matched: matchedKeywords.length > 0, matchedKeywords };
}

/** Source-file probe families, in priority order. First match wins. */
const SOURCE_FILE_FAMILIES: ReadonlyArray<{
  canonical: AntiLLMPolicySourceFile;
  paths: readonly string[];
}> = [
  {
    canonical: "CONTRIBUTING.md",
    paths: [
      "CONTRIBUTING.md",
      ".github/CONTRIBUTING.md",
      "docs/CONTRIBUTING.md",
      "contributing.md",
    ],
  },
  {
    canonical: "CODE_OF_CONDUCT.md",
    paths: [
      "CODE_OF_CONDUCT.md",
      ".github/CODE_OF_CONDUCT.md",
      "docs/CODE_OF_CONDUCT.md",
      "code_of_conduct.md",
    ],
  },
  {
    canonical: "README.md",
    paths: ["README.md", "readme.md", "Readme.md"],
  },
];

/**
 * Fetch one path's raw text content. The `transient` flag distinguishes a
 * clean miss (404 — file absent) from a degraded miss (5xx, network) so the
 * caller can decide whether to cache "no policy" or retry. Throws on
 * 401/auth and rate-limit per documented project error strategy.
 */
async function fetchFileText(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
): Promise<{ text: string | null; transient: boolean }> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path });
    if ("content" in data && typeof data.content === "string") {
      return {
        text: Buffer.from(data.content, "base64").toString("utf-8"),
        transient: false,
      };
    }
    return { text: null, transient: false };
  } catch (error) {
    const status = getHttpStatusCode(error);
    if (status === 404) return { text: null, transient: false };
    if (status === 401 || isRateLimitError(error)) throw error;
    warn(
      MODULE,
      `Unexpected error fetching ${path} from ${owner}/${repo}: ${errorMessage(error)}`,
    );
    return { text: null, transient: true };
  }
}

/**
 * Result of probing one source-file family. `hadTransientFailure` lets the
 * caller decide whether to skip caching a "no match" result that may have
 * been incomplete due to a 5xx / network blip.
 */
interface FamilyFetchResult {
  text: string | null;
  hadTransientFailure: boolean;
}

/**
 * Fetch the first available file from a family. Probes are issued in parallel,
 * but auth/rate-limit rejections re-throw so the IssueVetter's existing
 * rate-limit handling kicks in instead of silently caching a wrong answer.
 */
async function fetchFamilyText(
  octokit: Octokit,
  owner: string,
  repo: string,
  paths: readonly string[],
): Promise<FamilyFetchResult> {
  const results = await Promise.allSettled(
    paths.map((p) => fetchFileText(octokit, owner, repo, p)),
  );
  let hadTransientFailure = false;
  for (const result of results) {
    if (result.status === "fulfilled") {
      if (result.value.transient) hadTransientFailure = true;
      if (result.value.text)
        return { text: result.value.text, hadTransientFailure };
    } else {
      // Re-throw so vetIssuesParallel's isRateLimitError classifier sees it.
      if (
        isRateLimitError(result.reason) ||
        getHttpStatusCode(result.reason) === 401
      ) {
        throw result.reason;
      }
      hadTransientFailure = true;
    }
  }
  return { text: null, hadTransientFailure };
}

/** Cached value passes runtime shape checks for AntiLLMPolicyResult. */
function isAntiLLMPolicyResult(value: unknown): value is AntiLLMPolicyResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.matched !== "boolean") return false;
  if (!Array.isArray(v.matchedKeywords)) return false;
  if (v.sourceFile !== null && typeof v.sourceFile !== "string") return false;
  return true;
}

/**
 * Fetch CONTRIBUTING/CODE_OF_CONDUCT/README in priority order and return the
 * first family whose text matches an anti-LLM keyword. Returns
 * `{matched: false, matchedKeywords: [], sourceFile: null}` when no source
 * file matches. Cached per-repo for POLICY_SCAN_CACHE_TTL_MS.
 *
 * Sequential by design: if CONTRIBUTING throws auth/rate-limit, we want to
 * short-circuit rather than burn API budget on COC + README probes.
 */
export async function fetchAndScanAntiLLMPolicy(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<AntiLLMPolicyResult> {
  const cache = getHttpCache();
  const cacheKey = `anti-llm-policy:${owner}/${repo}`;
  const cached = cache.getIfFresh(cacheKey, POLICY_SCAN_CACHE_TTL_MS);
  if (isAntiLLMPolicyResult(cached)) return cached;

  let anyTransientFailure = false;
  for (const family of SOURCE_FILE_FAMILIES) {
    const { text, hadTransientFailure } = await fetchFamilyText(
      octokit,
      owner,
      repo,
      family.paths,
    );
    if (hadTransientFailure) anyTransientFailure = true;
    if (!text) continue;
    const { matched, matchedKeywords } = scanForAntiLLMPolicy(text);
    if (matched) {
      const result: AntiLLMPolicyResult = {
        matched: true,
        matchedKeywords,
        sourceFile: family.canonical,
      };
      cache.set(cacheKey, "", result);
      return result;
    }
  }

  const noMatch: AntiLLMPolicyResult = {
    matched: false,
    matchedKeywords: [],
    sourceFile: null,
  };
  // Skip the cache write when probes failed transiently — otherwise a
  // single 5xx pin "no policy" for an hour for a repo that may actually have one.
  if (!anyTransientFailure) {
    cache.set(cacheKey, "", noMatch);
  }
  return noMatch;
}
