#!/usr/bin/env bash
# SessionStart hook for oss-scout plugin
# Auto-builds CLI bundle if stale, checks for updates

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

messages=""
NL=$'\n'

# Install + bundle. Prefers pnpm with the committed lockfile; falls back to
# npm. Scripts are ignored either way (pnpm 10 blocks dependency lifecycle
# scripts by default and the bundle builds fine in CI under that policy, so
# a tampered transitive dependency cannot execute code at session start;
# esbuild's binary ships via optional dependencies, no postinstall needed)
# (#146).
build_bundle() {
  if command -v pnpm >/dev/null 2>&1 && [ -f "${PLUGIN_ROOT}/pnpm-lock.yaml" ]; then
    (cd "${PLUGIN_ROOT}" \
      && pnpm install --frozen-lockfile --silent 2>/dev/null \
      && pnpm --filter @oss-scout/core run bundle --silent 2>/dev/null)
  else
    (cd "${PLUGIN_ROOT}/packages/core" \
      && npm install --silent --ignore-scripts 2>/dev/null \
      && npm run bundle --silent 2>/dev/null)
  fi
}

BUNDLE="${PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs"
BUILD_HINT="Run: cd ${PLUGIN_ROOT} && pnpm install && pnpm --filter @oss-scout/core run bundle"

# --- Step 1: Rebuild stale CLI bundle (if needed) ---
if [ -f "$BUNDLE" ] && [ "${PLUGIN_ROOT}/packages/core/package.json" -nt "$BUNDLE" ]; then
  if build_bundle; then
    messages="CLI bundle rebuilt after plugin update."
  else
    messages="Warning: CLI bundle rebuild failed. ${BUILD_HINT}"
  fi
fi

# --- Step 2: Build CLI bundle if missing ---
if [ ! -f "$BUNDLE" ]; then
  if build_bundle; then
    messages="${messages:+${messages}${NL}}CLI bundle built successfully."
  else
    messages="${messages:+${messages}${NL}}Warning: CLI bundle build failed. ${BUILD_HINT}"
  fi
fi

# --- Step 3: Check for updates (every 6 hours) ---
LAST_CHECK="${HOME}/.oss-scout/.last-update-check"
CURRENT=$(node -e "console.log(require('${PLUGIN_ROOT}/packages/core/package.json').version)" 2>/dev/null || echo "")

if [ -n "$CURRENT" ]; then
  should_check=false
  if [ ! -f "$LAST_CHECK" ]; then
    should_check=true
  elif [ -n "$(find "$LAST_CHECK" -mmin +360 2>/dev/null)" ]; then
    should_check=true
  fi

  if [ "$should_check" = true ]; then
    mkdir -p "${HOME}/.oss-scout"
    # release-please cuts per-component tags (core-vX, mcp-server-vY) and
    # the releases API is publish-date ordered, not version ordered, so
    # take the semver max of the core releases specifically (#146)
    LATEST=$(gh api repos/costajohnt/oss-scout/releases --jq '.[].tag_name' 2>/dev/null | sed -n 's/^core-v//p' | sort -V | tail -1 || echo "")
    if [ -n "$LATEST" ] && echo "$LATEST" | grep -qE '^[0-9]+\.'; then
      touch "$LAST_CHECK"
      # Nag only when the release is strictly newer than the local version;
      # inequality alone nagged users running ahead of the latest release
      newest=$(printf '%s\n%s\n' "$CURRENT" "$LATEST" | sort -V | tail -1)
      if [ "$LATEST" != "$CURRENT" ] && [ "$newest" = "$LATEST" ]; then
        messages="${messages:+${messages}${NL}}oss-scout v${LATEST} available (you have v${CURRENT}). Run: /plugin update oss-scout"
      fi
    fi
  fi
fi

# --- Output JSON ---
if [ -n "$messages" ]; then
  if command -v jq &>/dev/null; then
    escaped=$(printf '%s' "$messages" | jq -Rrs '@json | .[1:-1]')
  else
    escaped=$(printf '%s' "$messages" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr '\n' ' ')
  fi
  cat <<EOF
{
  "systemMessage": "${escaped}",
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "${escaped}"
  }
}
EOF
else
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart"
  }
}
EOF
fi

exit 0
