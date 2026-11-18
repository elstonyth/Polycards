#!/usr/bin/env bash
#
# sync-agent-rules.sh — Generate AI agent config files from AGENTS.md
#
# AGENTS.md is the primary source of truth. This script creates copies
# for agents that don't read AGENTS.md natively (Cline, Continue,
# Amazon Q, GitHub Copilot Chat).
#
# Usage:
#   bash scripts/sync-agent-rules.sh
#
# Agents that DON'T need an AGENTS.md copy (they read AGENTS.md natively):
#   Codex CLI, OpenCode, Cursor, Windsurf, Copilot Coding Agent,
#   Roo Code, Aider, Augment Code
#
# Agents with their own thin pointer files (created manually):
#   Claude Code  → CLAUDE.md (@AGENTS.md import)
#
# GEMINI.md and .windsurfrules are local-only (gitignored) and manually
# maintained outside this script — they are not generated or tracked here.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$REPO_ROOT/AGENTS.md"

if [[ ! -f "$SOURCE" ]]; then
  echo "Error: AGENTS.md not found at $SOURCE" >&2
  exit 1
fi

# Resolve @file imports (Claude Code syntax) into inline content.
# Lines like "@docs/research/INSPECTION_GUIDE.md" become the file's contents.
resolve_imports() {
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^@(.+)$ ]]; then
      local import_path="${BASH_REMATCH[1]}"
      local resolved="$REPO_ROOT/$import_path"
      if [[ -f "$resolved" ]]; then
        cat "$resolved"
        echo ""
      else
        echo "<!-- Import not found: $import_path -->"
      fi
    else
      echo "$line"
    fi
  done < "$SOURCE"
}

RESOLVED_CONTENT="$(resolve_imports)"

HEADER="<!-- AUTO-GENERATED from AGENTS.md — do not edit directly.
     Run \`bash scripts/sync-agent-rules.sh\` to regenerate. -->"

# Helper: write a generated file with header. Optional 3rd arg overrides
# the default (AGENTS.md-sourced) banner for non-AGENTS.md sources.
write_file() {
  local target="$1"
  local content="$2"
  local header="${3:-$HEADER}"
  mkdir -p "$(dirname "$target")"
  printf '%s\n\n%s\n' "$header" "$content" > "$target"
  echo "  ✓ $target"
}

echo "Syncing agent rules from AGENTS.md..."

# GitHub Copilot Chat — .github/copilot-instructions.md
write_file "$REPO_ROOT/.github/copilot-instructions.md" "$RESOLVED_CONTENT"

# Cline / Roo Code — .clinerules
write_file "$REPO_ROOT/.clinerules" "$RESOLVED_CONTENT"

# Continue — .continue/rules/project.md
CONTINUE_FRONTMATTER="---
description: Project conventions for AI Website Clone Template
alwaysApply: true
---"
write_file "$REPO_ROOT/.continue/rules/project.md" "$CONTINUE_FRONTMATTER
$RESOLVED_CONTENT"

# Amazon Q Developer — .amazonq/rules/project.md
write_file "$REPO_ROOT/.amazonq/rules/project.md" "$RESOLVED_CONTENT"

echo ""
echo "Done. All four copies are local (gitignored) and sourced from AGENTS.md:"
echo "edit AGENTS.md, then re-run."
