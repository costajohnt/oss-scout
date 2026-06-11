/**
 * Shared utility functions for oss-scout.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { ConfigurationError, errorMessage } from "./errors.js";
import { debug } from "./logger.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MODULE = "utils";

let cachedGitHubToken: string | null = null;
let tokenFetchAttempted = false;

export function getDataDir(): string {
  const dir = path.join(os.homedir(), ".oss-scout");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function getCacheDir(): string {
  const dir = path.join(getDataDir(), "cache");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/**
 * Extract "owner/repo" from any GitHub URL format:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo/pull/123
 * - https://github.com/owner/repo/issues/123
 * - https://api.github.com/repos/owner/repo
 * - https://api.github.com/repos/owner/repo/...
 */
export function extractRepoFromUrl(url: string): string | null {
  // Real URL parsing: the previous regexes were unanchored (any host
  // containing "github.com" matched) and leaked query/fragment text into
  // the repo segment ("repo?tab=readme").
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const segments = parsed.pathname.split("/").filter(Boolean);

  // API URLs: https://api.github.com/repos/owner/repo[/...]
  if (host === "api.github.com") {
    if (segments[0] === "repos" && segments.length >= 3) {
      return `${segments[1]}/${segments[2]}`;
    }
    return null;
  }

  // Web URLs: https://github.com/owner/repo[/...]
  if (host === "github.com" && segments.length >= 2) {
    return `${segments[0]}/${segments[1]}`;
  }

  return null;
}

interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  number: number;
  type: "pull" | "issues";
}

const OWNER_PATTERN = /^[a-zA-Z0-9_-]+$/;
const REPO_PATTERN = /^[a-zA-Z0-9_.-]+$/;

function isValidOwnerRepo(owner: string, repo: string): boolean {
  return OWNER_PATTERN.test(owner) && REPO_PATTERN.test(repo);
}

export function parseGitHubUrl(url: string): ParsedGitHubUrl | null {
  // Accept pasteable variants: http://, www., and bare github.com/... forms
  // normalize to a parseable URL. Strict canonical-form validation for
  // command input lives in commands/validation.ts; this parser is lenient.
  const normalized = /^(?:www\.)?github\.com\//i.test(url)
    ? `https://${url}`
    : url;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "github.com") return null;

  // Exactly owner/repo/(pull|issues)/<digits>; trailing slash tolerated via
  // filter(Boolean), query/fragment excluded by pathname. A malformed number
  // segment ("123abc") no longer half-parses to 123.
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return null;
  const [owner, repo, type, num] = segments;
  if (type !== "pull" && type !== "issues") return null;
  if (!isValidOwnerRepo(owner, repo)) return null;
  if (!/^\d+$/.test(num)) return null;
  return { owner, repo, number: parseInt(num, 10), type };
}

export function daysBetween(from: Date, to: Date = new Date()): number {
  return Math.max(
    0,
    Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)),
  );
}

export function getCLIVersion(): string {
  try {
    const pkgPath = path.join(
      path.dirname(process.argv[1]),
      "..",
      "package.json",
    );
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version;
  } catch (err) {
    debug(MODULE, `Could not read CLI version: ${errorMessage(err)}`);
    return "unknown";
  }
}

export function getGitHubToken(): string | null {
  if (cachedGitHubToken) return cachedGitHubToken;
  if (tokenFetchAttempted) return null;
  tokenFetchAttempted = true;

  // Trim: a trailing newline (e.g. GITHUB_TOKEN=$(cat file)) produces a
  // malformed Authorization header with confusing 401s. A whitespace-only
  // value falls through to the gh CLI.
  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (envToken) {
    cachedGitHubToken = envToken;
    return cachedGitHubToken;
  }

  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2000,
    }).trim();
    if (token && token.length > 0) {
      cachedGitHubToken = token;
      debug(MODULE, "Using GitHub token from gh CLI");
      return cachedGitHubToken;
    }
  } catch (err) {
    // Log only the message: the raw execFileSync error carries stdout/stderr
    // buffers that could include a token if gh half-succeeded.
    debug(MODULE, `gh auth token failed: ${errorMessage(err)}`);
  }

  return null;
}

export function requireGitHubToken(): string {
  const token = getGitHubToken();
  if (!token) {
    throw new ConfigurationError(
      "GitHub authentication required.\n\n" +
        "Options:\n" +
        "  1. Use gh CLI: gh auth login\n" +
        "  2. Set GITHUB_TOKEN environment variable\n\n" +
        "The gh CLI is recommended - install from https://cli.github.com",
    );
  }
  return token;
}
