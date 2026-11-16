#!/usr/bin/env bash
# Prints the commit each DigitalOcean app is running, as GitHub step outputs:
#   backend=<sha>
#   storefront=<sha>
# An app with no readable live commit prints an empty value; deploy-targets.mjs
# then falls back to the push's own diff. Needs doctl, already authenticated.
set -euo pipefail

live_commit() {
  local app_name=$1 app_id dep
  app_id=$(doctl apps list --format ID,Spec.Name --no-header | awk -v n="$app_name" '$2 == n { print $1 }')
  [ -n "$app_id" ] || return 0
  dep=$(doctl apps get "$app_id" --format ActiveDeployment.ID --no-header)
  [ -n "$dep" ] || return 0
  doctl apps get-deployment "$app_id" "$dep" --output json |
    jq -r '(if type == "array" then .[0] else . end) | [.services[]?.source_commit_hash] | map(select(. != null and . != "")) | first // ""'
}

echo "backend=$(live_commit polycards-backend || true)"
echo "storefront=$(live_commit polycards-storefront || true)"
