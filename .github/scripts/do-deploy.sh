#!/usr/bin/env bash
# Starts a DigitalOcean App Platform deployment for one app and waits for it.
# Used by .github/workflows/deploy.yml. Needs doctl, already authenticated.
#
#   bash .github/scripts/do-deploy.sh <app-name>
#
# Never cancels a deployment: a cancelled deploy once rolled production back.
set -euo pipefail

app_name=${1:?usage: do-deploy.sh <app-name>}

# Retry a doctl call on transient API errors: 3 tries, 10 s then 30 s apart.
# Warnings go to stderr so callers can capture stdout.
retry() {
  local delay
  for delay in 10 30 0; do
    if "$@"; then return 0; fi
    if [ "$delay" -eq 0 ]; then return 1; fi
    echo "::warning::'$*' failed; retrying in ${delay}s" >&2
    sleep "$delay"
  done
}

apps=$(retry doctl apps list --format ID,Spec.Name --no-header)
app_id=$(awk -v n="$app_name" '$2 == n { print $1 }' <<<"$apps")
if [ -z "$app_id" ]; then
  echo "::error::App $app_name not found"
  exit 1
fi

dep=$(retry doctl apps create-deployment "$app_id" --format ID --no-header)
echo "Started deployment $dep for $app_name"

phase=unknown
for _ in $(seq 1 80); do
  phase=$(retry doctl apps get-deployment "$app_id" "$dep" --format Phase --no-header)
  case "$phase" in
    ACTIVE)
      echo "$app_name is live on deployment $dep"
      exit 0
      ;;
    SUPERSEDED)
      echo "::notice::Deployment $dep was superseded by a newer deployment"
      exit 0
      ;;
    CANCELED)
      # App Platform marks a deploy replaced by a newer one as CANCELED too.
      # Only a newer deployment makes that a success.
      newest=$(retry doctl apps list-deployments "$app_id" --format ID --no-header | sed -n 1p)
      if [ -n "$newest" ] && [ "$newest" != "$dep" ]; then
        echo "::notice::Deployment $dep was replaced by newer deployment $newest"
        exit 0
      fi
      echo "::error::Deployment $dep was cancelled and nothing newer replaced it"
      exit 1
      ;;
    ERROR)
      echo "::error::Deployment $dep failed. See: doctl apps logs $app_id --deployment $dep --type build"
      exit 1
      ;;
  esac
  sleep 30
done

echo "::error::Deployment $dep did not finish within 40 minutes (last phase: $phase)"
exit 1
