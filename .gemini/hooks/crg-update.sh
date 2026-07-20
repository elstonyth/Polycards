#!/usr/bin/env bash
# code-review-graph: incremental update after write/replace (Gemini CLI hook)
# Must output ONLY JSON on stdout. Low-noise: no systemMessage.
set -euo pipefail

cat > /dev/null || true

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"

code-review-graph update --skip-flows ${repo_root:+--repo "$repo_root"} >/dev/null 2>&1 || true
echo '{"suppressOutput": true}'
exit 0
