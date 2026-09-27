---
test_command: pnpm -r build && pnpm test
lint_command: pnpm run typecheck && pnpm run lint && pnpm run format:check
base_branch: main
never_touch: [packages/core/CHANGELOG.md, packages/mcp-server/CHANGELOG.md, .release-please-manifest.json, release-please-config.json]
---

This file is HUMAN-OWNED. Simon reads it and never writes it: if you are an
agent running a phase, do not edit, extend, or "correct" it — say what you
think is wrong in your envelope instead.

Layout: a pnpm monorepo with two packages. `packages/core` (`@oss-scout/core`)
is the library and CLI: search engine, issue vetting, viability scoring, the
`OssScout` public API class. `packages/mcp-server` (`@oss-scout/mcp`) exposes
the same as MCP tools and resources. `CLAUDE.md` at the root maps every file.

Testing: vitest, tests colocated as `*.test.ts` next to the source, plus
`packages/core/src/e2e/search-flow.test.ts` with only Octokit mocked.
`test_command` builds first because the mcp-server tests import the built
core package. `pnpm --filter @oss-scout/core run test` is the fast loop.

Conventions:
- TypeScript strict mode, ESM with NodeNext resolution. Persisted state is
  described by Zod schemas in `packages/core/src/core/schemas.ts`; persisted
  schemas are loose so unknown keys round-trip, and `parseScoutState` is the
  single entry point for loading state (migrations live there).
- No singletons in library code; dependencies arrive via constructors.
- Error strategy: auth and rate-limit errors propagate; cache and filesystem
  errors degrade gracefully with a warn log.
- `--json` CLI output keeps the `{ success, data?, error?, errorCode?,
  timestamp }` envelope.
- Conventional commits. release-please derives versions and CHANGELOGs from
  them, so never hand-edit a CHANGELOG, `.release-please-manifest.json`, or a
  version field (`.claude-plugin/plugin.json` and the mcp-server's announced
  version are bumped by release PRs).
- Branch names: `feature/description`, `fix/description`, `chore/description`.
- CI runs audit, lint, format:check, typecheck, test and bundle on Node 20,
  22 and 24; `lint_command` is the local equivalent of everything but the tests.
