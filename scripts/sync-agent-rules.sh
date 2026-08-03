#!/usr/bin/env bash
#
# sync-agent-rules.sh — Generate AI agent config files from AGENTS.md
#
# AGENTS.md is the primary source of truth. This script creates copies
# for agents that don't read AGENTS.md natively (Cline, Continue,
# Amazon Q, GitHub Copilot Chat) — plus a second, unrelated mirror for
# the code-review-graph MCP doc (see below).
#
# Usage:
#   bash scripts/sync-agent-rules.sh
#
# Agents that DON'T need an AGENTS.md copy (they read AGENTS.md natively):
#   Codex CLI, OpenCode, Cursor, Windsurf, Copilot Coding Agent,
#   Roo Code, Aider, Augment Code
#   (Cursor's .cursorrules IS generated below, but for the unrelated
#   code-review-graph MCP doc, not as an AGENTS.md copy.)
#
# Agents with their own thin pointer files (created manually):
#   Claude Code  → CLAUDE.md (@AGENTS.md import)
#
# GEMINI.md and .windsurfrules are local-only (gitignored) and manually
# maintained outside this script — they are not generated or tracked here.
#
# This script also mirrors the code-review-graph MCP tool doc (a separate
# source, unrelated to AGENTS.md) into CODEBUDDY.md, QODER.md, and
# .cursorrules. Edit the CODE_REVIEW_GRAPH_DOC block below, then re-run —
# never edit one of those three files directly.

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

# code-review-graph MCP tool doc — a separate source from AGENTS.md, mirrored
# verbatim into three IDE-specific rule file formats (CodeBuddy, Qoder,
# Cursor-style .cursorrules). Edit this block, never one of the three outputs.
CODE_REVIEW_GRAPH_DOC="$(cat <<'MCPDOC'
<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes_tool` or `query_graph_tool` instead of Grep
- **Understanding impact**: `get_impact_radius_tool` instead of manually tracing imports
- **Code review**: `detect_changes_tool` + `get_review_context_tool` instead of reading entire files
- **Finding relationships**: `query_graph_tool` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview_tool` + `list_communities_tool`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes_tool` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context_tool` | Need source snippets for review — token-efficient |
| `get_impact_radius_tool` | Understanding blast radius of a change |
| `get_affected_flows_tool` | Finding which execution paths are impacted |
| `query_graph_tool` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes_tool` | Finding functions/classes by name or keyword |
| `get_architecture_overview_tool` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes_tool` for code review.
3. Use `get_affected_flows_tool` to understand impact.
4. Use `query_graph_tool` pattern="tests_for" to check coverage.
MCPDOC
)"

HEADER_MCP_DOC="<!-- AUTO-GENERATED from the CODE_REVIEW_GRAPH_DOC block in
     scripts/sync-agent-rules.sh — do not edit directly. Run
     \`bash scripts/sync-agent-rules.sh\` to regenerate. -->"

write_file "$REPO_ROOT/CODEBUDDY.md" "$CODE_REVIEW_GRAPH_DOC" "$HEADER_MCP_DOC"
write_file "$REPO_ROOT/QODER.md" "$CODE_REVIEW_GRAPH_DOC" "$HEADER_MCP_DOC"
write_file "$REPO_ROOT/.cursorrules" "$CODE_REVIEW_GRAPH_DOC" "$HEADER_MCP_DOC"

echo ""
echo "Done. Generated files are committed to the repo. .github/copilot-instructions.md,"
echo ".clinerules, .continue/rules/project.md, and .amazonq/rules/project.md are sourced"
echo "from AGENTS.md; CODEBUDDY.md, QODER.md, and .cursorrules are sourced from the"
echo "CODE_REVIEW_GRAPH_DOC block in this script. Edit the relevant source, then re-run."
