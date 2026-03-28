/**
 * Shared utility functions for oss-scout.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, execFile } from 'child_process';
import { ConfigurationError } from './errors.js';
import { debug } from './logger.js';

export const DEFAULT_CONCURRENCY = 5;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MODULE = 'utils';

let cachedGitHubToken: string | null = null;
let tokenFetchAttempted = false;

export function getDataDir(): string {
  const dir = path.join(os.homedir(), '.oss-scout');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function getGistIdPath(): string {
  return path.join(getDataDir(), 'gist-id');
}

export function getStateCachePath(): string {
  return path.join(getDataDir(), 'state-cache.json');
}

export function getCacheDir(): string {
  const dir = path.join(getDataDir(), 'cache');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  number: number;
  type: 'pull' | 'issues';
}

const OWNER_PATTERN = /^[a-zA-Z0-9_-]+$/;
const REPO_PATTERN = /^[a-zA-Z0-9_.-]+$/;

function isValidOwnerRepo(owner: string, repo: string): boolean {
  return OWNER_PATTERN.test(owner) && REPO_PATTERN.test(repo);
}

export function parseGitHubUrl(url: string): ParsedGitHubUrl | null {
  if (!url.startsWith('https://github.com/')) return null;

  const prMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (prMatch) {
    const owner = prMatch[1];
    const repo = prMatch[2];
    if (!isValidOwnerRepo(owner, repo)) return null;
    return { owner, repo, number: parseInt(prMatch[3], 10), type: 'pull' };
  }

  const issueMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (issueMatch) {
    const owner = issueMatch[1];
    const repo = issueMatch[2];
    if (!isValidOwnerRepo(owner, repo)) return null;
    return { owner, repo, number: parseInt(issueMatch[3], 10), type: 'issues' };
  }

  return null;
}

export function extractOwnerRepo(url: string): { owner: string; repo: string } | null {
  if (!url.startsWith('https://github.com/')) return null;
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  if (!isValidOwnerRepo(owner, repo)) return null;
  return { owner, repo };
}

export function daysBetween(from: Date, to: Date = new Date()): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)));
}

export function splitRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid repo format: expected "owner/repo", got "${repoFullName}"`);
  }
  return { owner, repo };
}

export function isOwnRepo(owner: string, username: string): boolean {
  return owner.toLowerCase() === username.toLowerCase();
}

export function getCLIVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(process.argv[1]), '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
  } catch {
    return '0.0.0';
  }
}

export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return 'just now';
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
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
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 2000,
    }).trim();
    if (token && token.length > 0) {
      cachedGitHubToken = token;
      debug(MODULE, 'Using GitHub token from gh CLI');
      return cachedGitHubToken;
    }
  } catch (err) {
    debug(MODULE, 'gh auth token failed', err);
  }

  return null;
}

export function requireGitHubToken(): string {
  const token = getGitHubToken();
  if (!token) {
    throw new ConfigurationError(
      'GitHub authentication required.\n\n' +
        'Options:\n' +
        '  1. Use gh CLI: gh auth login\n' +
        '  2. Set GITHUB_TOKEN environment variable\n\n' +
        'The gh CLI is recommended - install from https://cli.github.com',
    );
  }
  return token;
}

export function resetGitHubTokenCache(): void {
  cachedGitHubToken = null;
  tokenFetchAttempted = false;
}

export async function getGitHubTokenAsync(): Promise<string | null> {
  if (cachedGitHubToken) return cachedGitHubToken;
  if (tokenFetchAttempted) return null;
  tokenFetchAttempted = true;

  if (process.env.GITHUB_TOKEN) {
    cachedGitHubToken = process.env.GITHUB_TOKEN;
    return cachedGitHubToken;
  }

  try {
    const token = await new Promise<string>((resolve, reject) => {
      execFile('gh', ['auth', 'token'], { encoding: 'utf-8', timeout: 2000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
    if (token && token.length > 0) {
      cachedGitHubToken = token;
      debug(MODULE, 'Using GitHub token from gh CLI (async)');
      return cachedGitHubToken;
    }
  } catch (err) {
    debug(MODULE, 'gh auth token failed', err);
  }

  return null;
}

const GITHUB_USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

export async function detectGitHubUsername(): Promise<string | null> {
  try {
    const login = await new Promise<string>((resolve, reject) => {
      execFile('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf-8', timeout: 5000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
    if (login && GITHUB_USERNAME_RE.test(login)) {
      debug(MODULE, `Detected GitHub username: ${login}`);
      return login;
    }
    debug(MODULE, `gh api user returned invalid username: "${login}"`);
    return null;
  } catch (err) {
    debug(MODULE, 'detectGitHubUsername failed', err);
    return null;
  }
}
