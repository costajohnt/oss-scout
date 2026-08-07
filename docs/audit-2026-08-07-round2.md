# Repository Audit, Round 2 — 2026-08-07

Second-pass review of oss-scout at `71a7633` (post-release: core 1.5.1,
mcp 0.10.1), after all 27 findings from the first audit
(`docs/audit-2026-08-07.md`) were fixed via PR #301. This round had three
angles: an adversarial review of the fix batch itself, a deep dive into
modules the first audit did not examine closely, and a second-round
security probe that actively tested bypasses instead of reading for them.

## Baseline (verified by running everything)

Build, lint, format, typecheck, 1,173 tests, bundle: all pass.
`pnpm audit --prod --audit-level=high`: passes (3 low/moderate remain, all
transitive via `@modelcontextprotocol/sdk`'s HTTP stack, which the
stdio-only server never loads).

## A. Regressions introduced by the round-1 fixes

### A1. Local-mode checkpoint merge resurrects PRs that `sync` just removed — HIGH (verified)

The #294 fix made local-mode `checkpoint()` run
`mergeStates(this.state, loadLocalState())` (`scout.ts:1014`) before
saving. But `mergeStates` merges `openPRs` with `unionByUrl`
(`gist-state-store.ts:535,612-617`) and tombstones cover only
`savedResults`/`skippedIssues` — removals from `openPRs` have no
tombstone. `syncOpenPRs` sets `state.openPRs = remaining` then calls
`checkpoint()` (`scout.ts:774-776`), which reloads the on-disk state that
still lists the resolved PRs and unions them back in.

**Impact:** in any `persistLocal` scout — notably the MCP server
(`persistence: "local"`) — `openPRs` can never shrink. Every subsequent
`sync` re-checks every resolved PR forever (one wasted API call each per
run) and `getReposWithOpenPRs()` over-reports permanently: the exact #164
bug, reintroduced for the MCP flow. 100% reproducible. The CLI is
unaffected (provided mode saves without merging). The same union-based
resurrection exists in gist `push()` but predates round 1.

**Fix direction:** on `recordMergedPR`/`recordClosedPR`/sync-prune, either
tombstone the removed open-PR URL (extend tombstones beyond
savedResults/skips) or have `mergeStates` treat `openPRs` presence in
`mergedPRs`/`closedPRs` as authoritative removal (a resolved PR must not
reappear in `openPRs` — derivable without new state). The latter is
self-healing for existing corrupted states.

### A2. `results clear` hard-fails for gist-preference users without a token — MEDIUM (traced)

The #276 fix routes `runResultsClear` through `withScout(...,
{ requireToken: false, persist: true })`. In gist-preference mode,
`buildCommandScout` constructs a gist scout with the empty token;
`gistStore.bootstrap()` then runs unauthenticated and its 401
**rethrows by design** (`gist-state-store.ts:124`) — `results clear`
crashes with a raw Octokit 401 before clearing anything, where it was
previously pure local file I/O. Even with a token, the command can now
throw mid-run on a rate-limited push. `skip clear`/`skip remove` share
this shape but predate round 1.

**Fix direction:** for local-only mutations (`results clear`, skip ops),
build a provided-mode scout over the local state and record tombstones
there; let the next authenticated command push the tombstones to the
gist. Or catch bootstrap 401 in this path and degrade to local-with-
tombstones plus a warning.

### A3. Batch auth-abort discards partial results on repo-scoped 403s — MEDIUM

The #290 fix aborts `vetIssuesParallel` on any non-rate-limit 403. But
such 403s are often **per-repo**, not token-global: SAML-SSO-enforced
orgs, fine-grained PATs without a grant for one repo. One SSO-gated issue
among ten candidates now throws away nine good vetted results and fails
the whole search ("discarding partial results", `issue-vetting.ts:884`).
The 401 case (token-global) is correctly aborted.

**Fix direction:** distinguish scope: abort on 401 always; on bare 403,
count per-repo failures and only abort if *every* attempted repo 403s (or
after N distinct repos fail), otherwise skip the repo and keep the batch.

### A4. Scoped command allowlists don't match the commands the bodies run — MEDIUM

The #299 scoping set `allowed-tools: Bash(node:*), Bash(gh:*),
Bash(npm:*), Bash(cd:*), Read`, but nearly every documented invocation is
env-prefixed with command substitution (`GITHUB_TOKEN=$(gh auth token)
node …`) or an `if`/`$( )` compound (the build fallback), which prefix
rules do not match. Practical effect: `/scout` and `/scout-setup` likely
prompt on every step instead of auto-running — safe, but the scoping is
decorative and the UX regressed. Agent `tools` lists are fine.

**Fix direction:** either restructure the command bodies so invocations
are plain prefixes (export the token in a first approved step:
`export GITHUB_TOKEN=$(gh auth token)` … then bare `node …` calls), or
revert commands to unscoped `Bash` and keep the (working) agent scoping,
documenting the tradeoff.

### A5. Smaller notes on round-1 fixes — LOW

- #288 residue: the preflight-failure fallback renders the fabricated
  budget in user-facing text — "critically low API quota (4 remaining)"
  when the preflight merely *failed*. Word the message as "quota unknown"
  in that path (`issue-discovery.ts:657,943-946`).
- #294 residue: preferences merge is whole-object last-stamp-wins, so the
  fix protects list-shaped state but not interleaved preference edits
  from two processes (no worse than before; noted for expectations). The
  critical case — config-set clobbering its own fresh change — was traced
  and is safe.
- #295 note: `maxResults .max(50)` is a breaking MCP schema change vs.
  1.5.0 clients, and the CLI has no matching upper bound — the two
  surfaces disagree.
- #300 residue: the host allowlist survived every bypass probe (hex/octal
  /decimal IP forms, IPv4-mapped IPv6, userinfo tricks — tested, not just
  read), but `fetch` follows redirects: an allowed private host can
  307/308-redirect the issue-text POST to a public origin. Add
  `redirect: "error"` to the triage fetch.
- #274 watch item: overrides force `fast-uri@4.1.2` under `ajv` (declares
  `^3`) and `ip-address@10.4.0` under `express-rate-limit` (pins 10.1.0
  exactly). Verified working at runtime (ajv compiles/validates; server
  imports cleanly), but keep in mind on SDK bumps. Also the
  `@hono/node-server` pin (`>=1.19.13`) sits below its current advisory
  (patched in 2.0.5) — unreachable (stdio-only), but the comment claims
  coverage it no longer provides.

### Verified clean (adversarially, in the fix batch)

Sync double-persistence in gist mode (dirty-flag short-circuits), all six
budget reservation call sites (recordCall in finally; no leak path),
`canAfford` semantic change (no external callers), checkNotClaimed's
extra-page heuristic (sound under GitHub pagination invariants), orphaned
old-version health cache entries (GC'd by `evictStale`), null-prototype
`repoScores` (survives stringify/spread/entries; no hasOwnProperty
callers), `--concurrency` retype (also fixed a latent commander
radix bug), gist invalid-remote guard, tombstone GC, hook JSON escaping,
action.yml env passing, NaN age guard, strategies parsing, packaging.

## B. New findings in previously-unaudited modules

- **B1 (MEDIUM):** `scout features` ignores `excludeRepos` and
  `aiPolicyBlocklist` on the anchor path, and `aiPolicyBlocklist` on the
  broad path (`feature-discovery.ts:311-325`, `scout.ts:405-426`) — an
  excluded or anti-LLM-blocklisted repo still yields feature candidates,
  unlike the search path which filters both.
- **B2 (MEDIUM):** markdown digest injection — `markdown.ts:9-11` escapes
  only newlines and pipes, so an attacker-authored issue title can put a
  live phishing link or tracking image into the digest issue that
  `action.yml` posts. (Workflow-command injection was separately ruled
  out: digest content goes to a file, never step stdout.) Escape inline
  markdown (`[`, `]`, `(`, `)`, backticks, `!`, `<`) in table cells.
- **B3 (LOW/MEDIUM):** `splitByHorizon` doesn't clamp `ratio`
  (`feature-discovery.ts:104-106`) — library callers passing >1 can make
  `features()` return more than `count` (CLI/zod paths validate; the
  public API doesn't).
- **B4 (LOW):** bootstrap reports `starredRepoCount` from the partial
  in-memory list even when the fetch failed and nothing was saved
  (`bootstrap.ts:71-94,222`); similarly `reposScoredCount` counts
  pre-existing scores, masking a fully-failed run.
- **B5 (LOW):** interactive setup accepts silently-dropped invalid
  multi-select tokens, unbounded/negative `minStars`, and an empty
  username that then dead-ends bootstrap (`setup.ts:87-194`).
- **B6 (LOW):** roadmap's bare-`#N` regex matches hex colors and
  code-fence content (`roadmap.ts:85`) — `color: #333` marks issue 333
  as on-roadmap (bucket placement only; score unaffected).

### Verified clean (new-module sweep)

personalization boost/penalty arithmetic and comparator transitivity,
diversity-slot math (clamped, exact fill), scoring NaN paths, filtering
regexes, linked-PR thresholds, http-cache in-flight dedup (rejections
evicted; no stuck-failure caching), local-state atomicity + corrupt-file
backup, github throttle/retry interplay, pagination termination, command
persist coverage, human formatter, eval exclusion from the published
package.

## C. Security round 2 — no high/critical

All round-1 fixes hold under active probing. Tested (not just read):
IP-form bypasses of the triage-host guard (hex/octal/decimal/IPv4-mapped
IPv6 — all defeated; WHATWG URL normalization strengthens the check),
prototype pollution through `parseScoutState` and `mergeStates` (clean),
gist push to a non-owned gist (fails safely, no cross-user write),
`npm pack --dry-run` contents (dist-only, no fixtures/secrets; grep for
token patterns in eval fixtures clean), action.yml stdout paths (no
untrusted content reaches step stdout, so no workflow-command injection).

Low/informational: `@hono/node-server` pin below current advisory with a
stale comment (unreachable — stdio only); `session-start.sh` version gate
is prefix-anchored only (`^[0-9]+\.` without `$`) — harmless today
because everything downstream is jq-escaped, but tighten to
`^[0-9]+(\.[0-9]+)+$`; single-label/`.local` triage hosts remain allowed
by design (needs local config access to abuse) — worth a comment.

## Suggested fix order

1. A1 — the openPRs resurrection regression (breaks MCP sync compounding).
2. A3 — repo-scoped 403 abort (kills whole searches on one SSO repo).
3. A2 — `results clear`/skip-ops crash for tokenless gist users.
4. B2 — digest markdown escaping (outward-facing content).
5. B1 — features honoring excludeRepos/aiPolicyBlocklist.
6. A4 — command allowlist restructuring (UX).
7. The lows: A5 batch (message wording, redirect: "error", override
   comment), B3-B6, session-start version-gate anchor.
