# CLAUDE.md

## Project Overview

oss-scout is a standalone tool for finding open source issues personalized to your contribution history. Ships as CLI, library, MCP server, and Claude Code plugin. Published as `@oss-scout/core` and `@oss-scout/mcp` on npm.

### Architecture

**pnpm monorepo** with two packages:

1. **`packages/core`** (`@oss-scout/core`) — Library + CLI. Multi-strategy search engine, issue vetting, viability scoring, and the `OssScout` public API class.

2. **`packages/mcp-server`** (`@oss-scout/mcp`) — MCP server exposing search, vet, config tools and scout:// resources.

### Key Design Decisions

- **No singletons in public API.** `OssScout` accepts config via constructor injection. Implements `ScoutStateReader` to bridge state with the search engine.
- **Two persistence modes:** `'gist'` (standalone, state in private GitHub gist) and `'provided'` (library, caller provides state — used by OSS Autopilot).
- **Extracted from OSS Autopilot.** Search modules refactored to remove `StateManager` singleton. OSS Autopilot imports `@oss-scout/core` as a dependency.
- **5-phase search** with configurable strategy selection (merged, orgs, starred, broad, maintained).
- **Error strategy:** Auth/rate-limit errors propagate. Cache/filesystem errors degrade gracefully with warn logging. Documented in errors.ts.

### File Structure

```
packages/core/src/
├── index.ts              # Public API exports
├── scout.ts              # OssScout class + createScout() factory
├── cli.ts                # Commander CLI (10 commands)
├── commands/             # CLI subcommands
│   ├── setup.ts          # Interactive first-run configuration
│   ├── config.ts         # View/update preferences (strategy map pattern)
│   ├── search.ts         # Multi-strategy search with result persistence
│   ├── vet.ts            # Single issue vetting
│   ├── vet-list.ts       # Batch re-vetting of saved results
│   ├── results.ts        # View/clear saved search results
│   └── validation.ts     # URL validation helpers
├── core/                 # Domain logic
│   ├── schemas.ts        # Zod schemas for ScoutState, ScoutPreferences
│   ├── types.ts          # Ephemeral types, config interfaces
│   ├── issue-discovery.ts # 5 extracted phase functions + orchestrator
│   ├── issue-vetting.ts  # Parallel vetting pipeline + ScoutStateReader
│   ├── issue-eligibility.ts # PR existence, claim detection, requirements
│   ├── issue-scoring.ts  # Viability scoring (pure functions, 0-100)
│   ├── issue-filtering.ts # Spam detection, doc-only filtering
│   ├── search-phases.ts  # Search helpers, caching, batched search
│   ├── search-budget.ts  # Rate limit management (30 req/min sliding window)
│   ├── repo-health.ts    # Project health checks, CONTRIBUTING.md parsing
│   ├── category-mapping.ts # Project categories → GitHub topics
│   ├── github.ts         # Throttled Octokit client
│   ├── http-cache.ts     # ETag response caching, in-flight deduplication
│   ├── gist-state-store.ts # Gist-backed persistence with conflict resolution
│   ├── local-state.ts    # Local file persistence (~/.oss-scout/state.json)
│   ├── bootstrap.ts      # First-run: fetch starred repos + PR history
│   ├── utils.ts          # URL parsing, token detection, extractRepoFromUrl
│   ├── logger.ts         # Debug/info/warn logger (stderr)
│   ├── errors.ts         # Error hierarchy + strategy documentation
│   └── pagination.ts     # Auto-pagination helper
└── formatters/
    └── json.ts           # JSON output formatter

packages/mcp-server/src/
├── index.ts              # MCP server entry point (stdio transport)
├── tools.ts              # 4 tools: search, vet, config, config-set
├── resources.ts          # 3 resources: scout://config, results, scores
└── tools.test.ts         # Tool registration tests

Plugin (repo root):
├── commands/scout.md, scout-setup.md
├── agents/issue-scout.md, repo-evaluator.md
├── skills/oss-search/SKILL.md
└── .claude-plugin/plugin.json
```

## Development Commands

```bash
pnpm install              # Install all workspace dependencies
pnpm test                 # Run all tests (331 tests, 22 files)
pnpm run bundle           # Rebuild CLI bundle
pnpm run lint             # ESLint
pnpm run format:check     # Prettier check
pnpm start -- search 5    # Run CLI via tsx (dev mode)
pnpm start -- search 5 --json --strategy starred  # Test specific strategy
```

## Git Workflow

Before starting any task:
```bash
git checkout main && git pull && git checkout -b <branch-name>
```

Branch naming: `feature/description`, `fix/description`, `chore/description`.

## CI/CD

- **CI:** GitHub Actions on Node 20, 22, 24. Runs: audit, lint, format, typecheck, test, bundle.
- **Release:** release-please auto-creates version bump PRs from conventional commits.
- **Publish:** Merging a release-please PR auto-publishes to npm via granular token.

## Code Style

- TypeScript strict mode
- ESM (`"type": "module"`) with NodeNext resolution
- No singletons in library code — accept dependencies via constructors
- `--json` output contract: `{ success, data?, error?, errorCode?, timestamp }`
- Error strategy: auth/rate-limit propagate, cache/fs degrade gracefully
- Config field handling uses strategy map pattern (FIELD_CONFIGS in config.ts)
