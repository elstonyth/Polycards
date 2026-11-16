#!/usr/bin/env bash
# Rolls a DigitalOcean app back to an earlier deployment, through App
# Platform's rollback API (doctl has no rollback commands).
# Used by .github/workflows/rollback.yml. Needs doctl, already authenticated,
# DIGITALOCEAN_ACCESS_TOKEN in the environment, curl and jq.
#
#   bash .github/scripts/do-rollback.sh <app-name> validate [deployment-id]
#   bash .github/scripts/do-rollback.sh <app-name> rollback [deployment-id]
#   bash .github/scripts/do-rollback.sh <app-name> commit
#   bash .github/scripts/do-rollback.sh <app-name> revert
#
# validate  dry run: says whether the rollback would work, changes nothing.
# rollback  validates, then rolls back and waits. The app stays PINNED to that
#           deployment: every new deployment, Deploy workflow included, fails
#           until you commit or revert.
# commit    keeps the rollback and unpins; the next master push deploys again.
# revert    undoes the rollback: deploys the latest app spec again and unpins.
#
# Without a deployment id, the target is the newest earlier deployment that
# finished every step. App Platform only rolls back to its ten most recent
# successful deployments, and a rollback restores code, config and app spec,
# never database data: migrations already applied stay applied.
set -euo pipefail

app_name=${1:?usage: do-rollback.sh <app-name> validate|rollback|commit|revert [deployment-id]}
action=${2:?usage: do-rollback.sh <app-name> validate|rollback|commit|revert [deployment-id]}
target=${3:-}
: "${DIGITALOCEAN_ACCESS_TOKEN:?DIGITALOCEAN_ACCESS_TOKEN is not set}"
here=$(dirname "$0")

case "$app_name" in
  polycards-backend) health=https://admin.polycards.gg/health ;;
  polycards-storefront) health=https://polycards.gg/healthz ;;
  *) echo "::error::Unknown app $app_name"; exit 1 ;;
esac

uuid_re='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
if [ -n "$target" ] && ! [[ $target =~ $uuid_re ]]; then
  echo "::error::deployment_id must be a deployment UUID (doctl apps list-deployments <app-id>)"
  exit 1
fi

app_id=$(doctl apps list --format ID,Spec.Name --no-header | awk -v n="$app_name" '$2 == n { print $1 }')
[ -n "$app_id" ] || { echo "::error::App $app_name not found"; exit 1; }

# POST to the app's rollback API. --fail-with-body keeps DO's error JSON.
# The token header goes in on stdin (-H @-; printf is a builtin), never argv,
# so it doesn't show up in the process list.
do_post() {
  printf 'Authorization: Bearer %s\n' "$DIGITALOCEAN_ACCESS_TOKEN" |
    curl -sS --fail-with-body --max-time 60 -X POST -H @- \
      -H 'Content-Type: application/json' \
      -d "${2:-}" "https://api.digitalocean.com/v2/apps/$app_id/$1"
}

pick_target() {
  local active deps
  active=$(doctl apps get "$app_id" --format ActiveDeployment.ID --no-header)
  # Only id, phase, time, progress and commit leave jq: the spec never prints.
  deps=$(doctl apps list-deployments "$app_id" --output json |
    jq -r '.[:20][] | [.id, .phase, .created_at,
      "\(.progress.success_steps // 0)/\(.progress.total_steps // 0)",
      ([.services[]?, .workers[]?, .static_sites[]?] | map(.source_commit_hash // "") | first // "")]
      | @tsv')
  echo "Recent deployments (active: $active):" >&2
  awk -F'\t' '{ printf "  %s  %-11s %s  %s  %.9s\n", $1, $2, $3, $4, $5 }' <<<"$deps" >&2
  # Newest earlier deployment that went live: SUPERSEDED (replaced by a later
  # one) with every step done. One cut short mid-build is never a target.
  awk -F'\t' -v a="$active" '
    $1 == a { seen = 1; next }
    seen && $2 == "SUPERSEDED" { split($4, p, "/"); if (p[2] > 0 && p[1] == p[2]) { print $1; exit } }
  ' <<<"$deps"
}

wait_and_check() {
  local dep
  dep=$(jq -r '.deployment.id // empty' <<<"$1")
  [ -n "$dep" ] || { echo "::error::No deployment in the response"; exit 1; }
  echo "Waiting for deployment $dep"
  bash "$here/do-deploy.sh" "$app_name" "$dep"
  bash "$here/verify-deploy.sh" "$app_name" "$health"
}

validate() {
  local body res
  body=$(jq -n --arg d "$target" '{deployment_id: $d, skip_pin: false}')
  if ! res=$(do_post rollback/validate "$body"); then
    echo "::error::Validate request failed: $res"
    exit 1
  fi
  jq . <<<"$res"
  if [ "$(jq -r '.valid' <<<"$res")" != true ]; then
    echo "::error::DigitalOcean says $app_name can't roll back to $target: $(jq -c '.error // {}' <<<"$res")"
    exit 1
  fi
  echo "$app_name can roll back to $target"
}

case "$action" in
  validate | rollback)
    if [ -z "$target" ]; then target=$(pick_target); fi
    [ -n "$target" ] || { echo "::error::No earlier successful deployment found; pass deployment_id"; exit 1; }
    echo "Target deployment: $target"
    validate
    if [ "$action" = rollback ]; then
      res=$(do_post rollback "$(jq -n --arg d "$target" '{deployment_id: $d, skip_pin: false}')") ||
        { echo "::error::Rollback request failed: $res"; exit 1; }
      wait_and_check "$res"
      echo "::notice::$app_name rolled back to $target and is PINNED: deploys fail until you run this workflow with action commit (keep it) or revert (undo it)."
    fi
    ;;
  commit)
    res=$(do_post rollback/commit) || { echo "::error::Commit request failed: $res"; exit 1; }
    echo "::notice::Rollback of $app_name committed; the app is unpinned. The next master push deploys the master tip, so revert the bad change on master first."
    ;;
  revert)
    res=$(do_post rollback/revert) || { echo "::error::Revert request failed: $res"; exit 1; }
    wait_and_check "$res"
    echo "::notice::Rollback of $app_name reverted; the app runs its latest spec again and is unpinned."
    ;;
  *)
    echo "::error::Unknown action $action (validate, rollback, commit or revert)"
    exit 1
    ;;
esac
