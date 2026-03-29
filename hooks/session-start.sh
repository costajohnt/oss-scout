#!/usr/bin/env bash
# SessionStart hook for oss-scout plugin
# Auto-builds CLI bundle if stale, checks for updates

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

messages=""
NL=$'\n'

# --- Step 1: Rebuild stale CLI bundle (if needed) ---
if [ -f "${PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" ] && [ "${PLUGIN_ROOT}/packages/core/package.json" -nt "${PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" ]; then
  if (cd "${PLUGIN_ROOT}/packages/core" && npm install --silent 2>/dev/null && npm run bundle --silent 2>/dev/null); then
    messages="CLI bundle rebuilt after plugin update."
  else
    messages="Warning: CLI bundle rebuild failed. Run: cd ${PLUGIN_ROOT}/packages/core && npm install && npm run bundle"
  fi
fi

# --- Step 2: Build CLI bundle if missing ---
if [ ! -f "${PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" ]; then
  if (cd "${PLUGIN_ROOT}/packages/core" && npm install --silent 2>/dev/null && npm run bundle --silent 2>/dev/null); then
    messages="${messages:+${messages}${NL}}CLI bundle built successfully."
  else
    messages="${messages:+${messages}${NL}}Warning: CLI bundle build failed. Run: cd ${PLUGIN_ROOT}/packages/core && npm install && npm run bundle"
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
    LATEST=$(gh api repos/costajohnt/oss-scout/releases/latest --jq '.tag_name' 2>/dev/null | sed 's/^[^0-9]*//' || echo "")
    if [ -n "$LATEST" ] && echo "$LATEST" | grep -qE '^[0-9]+\.'; then
      touch "$LAST_CHECK"
      if [ "$LATEST" != "$CURRENT" ]; then
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
