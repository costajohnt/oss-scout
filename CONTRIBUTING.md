# Contributing to oss-scout

Thanks for considering a contribution! This document covers the basics.

## Prerequisites

- Node.js 20+
- pnpm 10+
- GitHub CLI (`gh auth login`)

## Setup

```bash
git clone https://github.com/costajohnt/oss-scout.git
cd oss-scout
pnpm install
pnpm test
```

## Development

```bash
pnpm start -- search 5          # Run CLI via tsx (dev mode)
pnpm start -- search 5 --json   # Test JSON output
pnpm run typecheck               # Type check
pnpm run lint                    # ESLint
pnpm run format                  # Prettier
pnpm test                        # Run all tests
pnpm run bundle                  # Build CLI bundle
```

## Branch Workflow

```bash
git checkout main && git pull
git checkout -b feature/your-description   # or fix/, chore/
# make changes
pnpm test && pnpm run lint && pnpm run format:check
git commit -m "feat: description"          # conventional commits
git push -u origin feature/your-description
gh pr create
```

## Commit Messages

Use [conventional commits](https://www.conventionalcommits.org/):

- `feat:` — new feature (minor version bump)
- `fix:` — bug fix (patch version bump)
- `chore:` — maintenance (no version bump)
- `refactor:` — code improvement (no version bump)
- `test:` — test additions (no version bump)
- `docs:` — documentation (no version bump)

## Architecture

The codebase is a pnpm monorepo with two packages:

- `packages/core` — CLI + library (`@oss-scout/core`)
- `packages/mcp-server` — MCP server (`@oss-scout/mcp`)

Key design principles:

- **No singletons** in the public API — constructor injection
- **Zod schemas** as single source of truth for persisted types
- **`--json`** output on every CLI command
- **Error strategy**: auth/rate-limit errors propagate, cache errors degrade gracefully

See `CLAUDE.md` for the full architecture guide.

## Testing

Tests use [Vitest](https://vitest.dev/). Co-located with source files (`*.test.ts`).

```bash
pnpm test                                    # all tests
pnpm --filter @oss-scout/core exec vitest run src/core/utils.test.ts   # one file
pnpm --filter @oss-scout/core exec vitest src/core/utils.test.ts       # watch mode
```

## Versioning

Automated via [release-please](https://github.com/googleapis/release-please). Do not manually bump versions or edit CHANGELOG.md.

## Code of Conduct

Be respectful and collaborative. We're all here to make open source better.
