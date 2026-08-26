<!-- AUTO-GENERATED from the CODE_REVIEW_GRAPH_DOC block in
     scripts/sync-agent-rules.sh — do not edit directly. Run
     `bash scripts/sync-agent-rules.sh` to regenerate. -->

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

> **PRECEDENCE (settled 2026-08-26).** `CLAUDE.md` §"Code exploration:
> codebase-memory MCP is primary" **wins over this section** for general code
> exploration — that is the later, benchmarked, repo-specific decision
> (2026-07-06). Use **codebase-memory** to find code; use the
> **code-review-graph** tools below for their review-specific capabilities
> (`detect_changes_tool`, `get_review_context_tool`, `get_impact_radius_tool`,
> `get_affected_flows_tool`), which codebase-memory does not provide.
>
> Keep this block in step with the matching section of `AGENTS.md`. The two are
> separate sources with no equality gate: this heredoc generates CODEBUDDY.md,
> QODER.md and .cursorrules, while AGENTS.md generates the other four copies.
> Editing one and not the other is how they drift.

This project has a knowledge graph. Prefer its tools over raw Grep/Glob/Read
where they fit — the graph is cheaper in tokens and gives structural context
(callers, dependents, test coverage) that file scanning cannot.

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
