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
  // API URLs: https://api.github.com/repos/owner/repo[/...]
  const apiMatch = url.match(/api\.github\.com\/repos\/([^/]+\/[^/]+)/);
  if (apiMatch) return apiMatch[1];

  // Web URLs: https://github.com/owner/repo[/...]
  const webMatch = url.match(/github\.com\/([^/]+\/[^/]+)/);
  if (webMatch) return webMatch[1];

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
  if (!url.startsWith("https://github.com/")) return null;

  const prMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (prMatch) {
    const owner = prMatch[1];
    const repo = prMatch[2];
    if (!isValidOwnerRepo(owner, repo)) return null;
    return { owner, repo, number: parseInt(prMatch[3], 10), type: "pull" };
  }

  const issueMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (issueMatch) {
    const owner = issueMatch[1];
    const repo = issueMatch[2];
    if (!isValidOwnerRepo(owner, repo)) return null;
    return { owner, repo, number: parseInt(issueMatch[3], 10), type: "issues" };
  }

  return null;
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

  if (process.env.GITHUB_TOKEN) {
    cachedGitHubToken = process.env.GITHUB_TOKEN;
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
    debug(MODULE, "gh auth token failed", err);
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
