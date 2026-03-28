/**
 * First-run bootstrap — fetches starred repos and PR history from GitHub
 * to seed the scout's state with the user's contribution context.
 */

import { getOctokit, checkRateLimit } from "./github.js";
import { debug, warn } from "./logger.js";
import { errorMessage } from "./errors.js";
import { extractRepoFromUrl } from "./utils.js";
import type { OssScout } from "../scout.js";

const MODULE = "bootstrap";

export interface BootstrapResult {
  starredRepoCount: number;
  mergedPRCount: number;
  closedPRCount: number;
  reposScoredCount: number;
  skippedDueToRateLimit: boolean;
  errors: string[];
}

const STARRED_MAX_PAGES = 5;
const SEARCH_MAX_PAGES = 3;
const PER_PAGE = 100;

export async function bootstrapScout(
  scout: OssScout,
  token: string,
): Promise<BootstrapResult> {
  const username = scout.getPreferences().githubUsername;
  if (!username) {
    throw new Error(
      "GitHub username not configured. Run `oss-scout setup` first.",
    );
  }

  const rateLimit = await checkRateLimit(token);
  debug(
    MODULE,
    `Rate limit: ${rateLimit.remaining}/${rateLimit.limit}, resets at ${rateLimit.resetAt}`,
  );

  if (rateLimit.remaining < 15) {
    debug(MODULE, "Insufficient rate limit, skipping bootstrap");
    return {
      starredRepoCount: 0,
      mergedPRCount: 0,
      closedPRCount: 0,
      reposScoredCount: 0,
      skippedDueToRateLimit: true,
      errors: [],
    };
  }

  const octokit = getOctokit(token);
  const errors: string[] = [];

  // 1. Fetch starred repos (up to 500)
  const starredRepos: string[] = [];
  try {
    let starredPage = 0;
    for await (const response of octokit.paginate.iterator(
      octokit.activity.listReposStarredByAuthenticatedUser,
      {
        per_page: PER_PAGE,
        headers: { accept: "application/vnd.github.v3+json" },
      },
    )) {
      for (const repo of response.data) {
        const r = repo as { full_name: string };
        starredRepos.push(r.full_name);
      }
      starredPage++;
      if (starredPage >= STARRED_MAX_PAGES) break;
    }
    debug(MODULE, `Fetched ${starredRepos.length} starred repos`);
    scout.setStarredRepos(starredRepos);
  } catch (err) {
    warn(MODULE, `Failed to fetch starred repos: ${errorMessage(err)}`);
    errors.push("starred repos fetch failed");
  }

  // 2. Fetch merged PRs via Search API
  let mergedPRCount = 0;
  try {
    for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
      const { data } = await octokit.search.issuesAndPullRequests({
        q: `is:pr is:merged author:${username}`,
        per_page: PER_PAGE,
        page,
      });

      for (const item of data.items) {
        const repo = extractRepoFromUrl(item.html_url);
        if (!repo) continue;

        scout.recordMergedPR({
          url: item.html_url,
          title: item.title,
          mergedAt: item.closed_at ?? new Date().toISOString(),
          repo,
        });
        mergedPRCount++;
      }

      if (data.items.length < PER_PAGE) break;
    }
    debug(MODULE, `Imported ${mergedPRCount} merged PRs`);
  } catch (err) {
    warn(MODULE, `Failed to fetch merged PRs: ${errorMessage(err)}`);
    errors.push("merged PR fetch failed");
  }

  // 3. Fetch closed-without-merge PRs via Search API
  let closedPRCount = 0;
  try {
    for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
      const { data } = await octokit.search.issuesAndPullRequests({
        q: `is:pr is:closed is:unmerged author:${username}`,
        per_page: PER_PAGE,
        page,
      });

      for (const item of data.items) {
        const repo = extractRepoFromUrl(item.html_url);
        if (!repo) continue;

        scout.recordClosedPR({
          url: item.html_url,
          title: item.title,
          closedAt: item.closed_at ?? new Date().toISOString(),
          repo,
        });
        closedPRCount++;
      }

      if (data.items.length < PER_PAGE) break;
    }
    debug(MODULE, `Imported ${closedPRCount} closed PRs`);
  } catch (err) {
    warn(MODULE, `Failed to fetch closed PRs: ${errorMessage(err)}`);
    errors.push("closed PR fetch failed");
  }

  const state = scout.getState();
  const reposScoredCount = Object.keys(state.repoScores).length;

  return {
    starredRepoCount: starredRepos.length,
    mergedPRCount,
    closedPRCount,
    reposScoredCount,
    skippedDueToRateLimit: false,
    errors,
  };
}
