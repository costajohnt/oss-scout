# CLAUDE.md

## Project Overview

oss-scout is a standalone tool for finding open source issues personalized to your contribution history. Currently ships as a CLI and library. MCP server and Claude Code plugin are planned.

### Architecture

**pnpm monorepo** with two packages:

1. **`packages/core`** (`@oss-scout/core`) — Library + CLI. Contains the multi-strategy search engine, issue vetting, viability scoring, and the `OssScout` public API class.

2. **`packages/mcp-server`** (`@oss-scout/mcp`) — MCP server exposing search and vet as tools.

### Key Design Decisions

- **No singletons.** The `OssScout` class accepts config via constructor injection. It implements `ScoutStateReader` to bridge state with the search engine modules.
- **Two persistence modes:** `'gist'` (standalone, state in GitHub gist) and `'provided'` (library, caller provides state — used by OSS Autopilot).
- **Extracted from OSS Autopilot.** The search modules were extracted and refactored to remove `StateManager` singleton dependencies. OSS Autopilot will import `@oss-scout/core` as a dependency.

### File Structure

```
packages/core/src/
├── index.ts              # Public API exports
├── scout.ts              # OssScout class + createScout() factory
├── cli.ts                # Commander CLI entry point
├── commands/             # CLI subcommands (search, vet)
├── core/                 # Domain logic
│   ├── schemas.ts        # Zod schemas for ScoutState
│   ├── types.ts          # Ephemeral types, config interfaces
│   ├── issue-discovery.ts # Multi-phase search orchestrator
│   ├── issue-vetting.ts  # Vetting pipeline + ScoutStateReader interface
│   ├── issue-eligibility.ts # PR existence, claim detection
│   ├── issue-scoring.ts  # Viability scoring (pure functions)
│   ├── issue-filtering.ts # Spam detection, doc-only filtering
│   ├── search-phases.ts  # Search helpers, caching, batched search
│   ├── search-budget.ts  # Rate limit management
│   ├── repo-health.ts    # Project health checks
│   ├── category-mapping.ts # Project categories → GitHub topics
│   ├── github.ts         # Throttled Octokit client
│   ├── http-cache.ts     # ETag response caching
│   ├── utils.ts          # Shared utilities
│   ├── logger.ts         # Debug/info/warn logger
│   ├── errors.ts         # Error hierarchy
│   └── pagination.ts     # Auto-pagination helper
└── formatters/
    └── json.ts           # JSON output formatter
```

## Development Commands

```bash
pnpm install              # Install all workspace dependencies
pnpm test                 # Run all tests
pnpm run bundle           # Rebuild CLI bundle
pnpm start -- search 5    # Run CLI via tsx (dev mode)
pnpm start -- search 5 --json  # Test JSON output
```

## Git Workflow

Before starting any task:
```bash
git checkout main && git pull && git checkout -b <branch-name>
```

Branch naming: `feature/description`, `fix/description`, `chore/description`.

## Code Style

- TypeScript strict mode
- ESM (`"type": "module"`)
- NodeNext module resolution
- No singletons in library code — accept dependencies via constructors
- `--json` output contract: `{ success, data?, error?, timestamp }`
