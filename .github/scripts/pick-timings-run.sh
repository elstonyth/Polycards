#!/usr/bin/env bash
# Picks the ci.yml run that refresh-test-timings.mjs reads, for
# refresh-test-timings.yml. Prints "<run id> <head sha> <kind>", or nothing
# when no run qualifies.
#
#   pick-timings-run.sh            newest qualifying run (see below)
#   pick-timings-run.sh RUN_ID     validate RUN_ID instead (exit 1 if unusable)
#
# A run qualifies when it is green, its integration-http shards ran, and every
# integration-http / backend-unit job passed; AND it is either a master push
# run or the pull_request run of a PR merged into master. Master pushes often
# skip the shards (path gate, and the fast path that trusts the merged PR's
# own run), so both kinds are searched and the newer run wins: a push run
# from before the fast path would otherwise win for weeks.
#
# Needs GH_TOKEN (actions: read) and GH_REPO. PUSH_LIMIT / PR_LIMIT set how
# far back to look (default 50 / 30; 0 skips that kind, for a self-check).
set -euo pipefail

shards_ok() {
  # shellcheck disable=SC2016 # $s is a jq variable
  gh run view "$1" --json workflowName,conclusion,jobs -q '
    [.jobs[] | select(.name | test("^(integration-http|backend-unit) \\("))] as $s
    | .workflowName == "CI" and .conclusion == "success"
      and ([$s[] | select(.name | startswith("integration-http ("))] | length > 0)
      and ($s | all(.conclusion == "success"))'
}

# Prints the run's kind (push / pr) when it is trusted, else nothing.
trusted_kind() {
  local event branch sha
  read -r event branch sha < <(gh run view "$1" --json event,headBranch,headSha -q '"\(.event) \(.headBranch) \(.headSha)"')
  if [ "$event" = push ] && [ "$branch" = master ]; then
    echo push
  elif [ "$event" = pull_request ] && [ "$(gh api "repos/$GH_REPO/commits/$sha/pulls" -q '[.[] | select(.merged_at != null and .base.ref == "master")] | length > 0')" = true ]; then
    echo pr
  fi
}

emit() {
  echo "$1 $(gh run view "$1" --json headSha -q .headSha) $2"
}

if [ -n "${1:-}" ]; then
  case "$1" in *[!0-9]*) echo "::error::run_id must be numeric" >&2; exit 1 ;; esac
  kind=$(trusted_kind "$1")
  if [ -z "$kind" ] || [ "$(shards_ok "$1")" != true ]; then
    echo "::error::Run $1 must be a green CI run, either a master push or the pull_request run of a PR merged into master, whose integration-http and backend-unit shards all ran and passed." >&2
    exit 1
  fi
  emit "$1" "$kind"
  exit 0
fi

push_id=
if [ "${PUSH_LIMIT:-50}" -gt 0 ]; then
  for c in $(gh run list --workflow ci.yml --branch master --event push --status success -L "${PUSH_LIMIT:-50}" --json databaseId -q '.[].databaseId'); do
    if [ "$(shards_ok "$c")" = true ]; then push_id=$c; break; fi
  done
fi

# The last CI run on each merged PR's final head, newest merge first.
pr_id=
if [ "${PR_LIMIT:-30}" -gt 0 ]; then
  for head in $(gh pr list --state merged --base master -L "${PR_LIMIT:-30}" --json mergedAt,headRefOid -q 'sort_by(.mergedAt) | reverse | .[].headRefOid'); do
    for c in $(gh run list --workflow ci.yml --event pull_request --commit "$head" --status success -L 5 --json databaseId -q '.[].databaseId'); do
      if [ "$(shards_ok "$c")" = true ]; then pr_id=$c; break 2; fi
    done
  done
fi

created() { gh run view "$1" --json createdAt -q .createdAt; }
if [ -n "$push_id" ] && [ -n "$pr_id" ]; then
  # ISO-8601 UTC timestamps sort as strings.
  if [[ "$(created "$pr_id")" > "$(created "$push_id")" ]]; then emit "$pr_id" pr; else emit "$push_id" push; fi
elif [ -n "$push_id" ]; then
  emit "$push_id" push
elif [ -n "$pr_id" ]; then
  emit "$pr_id" pr
fi
