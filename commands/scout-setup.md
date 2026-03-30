---
name: scout-setup
description: Configure OSS Scout preferences for personalized issue discovery
allowed-tools: Bash, Read, Write, mcp__*
---

# OSS Scout Setup

Customize your OSS Scout preferences. This is **optional** — the tool works out of the box with auto-detected settings. Use this command to fine-tune languages, labels, and search preferences.

## Step 0: Ensure CLI is Built

```bash
if [ ! -f "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" ]; then
  if ! BUILD_LOG=$(cd "${CLAUDE_PLUGIN_ROOT}/packages/core" && npm install --silent 2>&1 && npm run bundle --silent 2>&1); then
    echo "BUILD_FAILED"; echo "$BUILD_LOG" | tail -5; exit 1
  fi
fi
```

**If output starts with `BUILD_FAILED`**: Tell the user the CLI build failed and show the error lines. Suggest: `cd ${CLAUDE_PLUGIN_ROOT}/packages/core && npm install && npm run bundle`. Common causes: missing Node.js 20+, stale `node_modules`.

## Step 1: Check Prerequisites

Verify GitHub CLI is authenticated:
```bash
gh auth status 2>&1
```

If not authenticated:
> "You need the GitHub CLI authenticated. Install from https://cli.github.com/ and run `gh auth login`."

Then STOP.

## Step 2: Check Current Setup

```bash
GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN") node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --json 2>/dev/null
```

If setup is already complete, ask:
> "Setup is already configured. Would you like to reconfigure your settings?"

Options: "Yes, reconfigure" or "No, keep current settings"

If they choose to keep current settings, show current config and exit.

## Step 3: Run Interactive Setup

The CLI has an interactive setup command. Run it:

```bash
GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN") node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup
```

Alternatively, walk the user through setting individual preferences using the config command. The CLI stores configuration in `~/.oss-scout/state.json`.

### Manual Configuration

If the user prefers to set values individually:

**Languages** (what to search for):
```bash
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" config set languages "typescript,javascript,python" --json
```

**Labels** (issue labels to match):
```bash
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" config set labels "good first issue,help wanted" --json
```

**Project Categories** (types of projects):
```bash
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" config set projectCategories "devtools,infrastructure" --json
```

**Excluded Repos** (repos to skip):
```bash
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" config set excludeRepos "owner/repo1,owner/repo2" --json
```

## Step 4: Verify

After setup, verify by running a quick search:
```bash
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" search 3 --json
```

If it returns results, setup is working.

## Step 5: Confirmation

Show summary:

```markdown
## Setup Complete!

### Your Configuration
- **Languages**: [list]
- **Labels**: [list]
- **Project Categories**: [list or "No preference"]

### Next Steps
- Run `/scout` to search for contribution opportunities
- Use `vet <url>` to deep-vet specific issues
- Results are automatically saved for later review
```

## Notes

- State is stored in `~/.oss-scout/state.json`
- Configuration can be changed anytime by running `/scout-setup` again
- The tool works without setup — it will use sensible defaults
