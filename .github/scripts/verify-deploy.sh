#!/usr/bin/env bash
# Checks a DigitalOcean app after its deployment went ACTIVE.
# Used by .github/workflows/deploy.yml and rollback.yml. Needs doctl, already
# authenticated, plus curl and jq.
#
#   bash .github/scripts/verify-deploy.sh <app-name> [expected-sha [deployment-id]]
#
# With expected-sha, every component of the deployment must run that commit:
# deployment-id (the one do-deploy.sh watched go ACTIVE), else the app's
# active deployment. A mismatch means master moved between the CI gate and App Platform's
# build, so the live commit skipped this run's gate: that fails loudly.
# Then the health path must answer 200 on the app's App Platform default
# ingress (read at run time; retried, the edge can lag). The custom domain is
# curled once more for information only: Cloudflare challenges GitHub runner
# IPs there (403, cf-mitigated: challenge), so it only ever warns.
set -euo pipefail

usage='usage: verify-deploy.sh <app-name> [expected-sha [deployment-id]]'
app_name=${1:?$usage}
want=${2:-}
dep=${3:-}

case "$app_name" in
  polycards-backend) path=/health public=https://admin.polycards.gg ;;
  polycards-storefront) path=/healthz public=https://polycards.gg ;;
  *) echo "::error::Unknown app $app_name"; exit 1 ;;
esac

# Retry a command on transient errors: 3 tries, 10 s then 30 s apart, so one
# API blip doesn't fail a good deploy. Same as do-deploy.sh.
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
[ -n "$app_id" ] || { echo "::error::App $app_name not found"; exit 1; }

if [ -n "$want" ]; then
  if [ -z "$dep" ]; then
    dep=$(retry doctl apps get "$app_id" --format ActiveDeployment.ID --no-header)
  fi
  # One line per component: "<name> <commit>". The spec is never printed.
  commits=$(retry doctl apps get-deployment "$app_id" "$dep" --output json |
    jq -r '(if type == "array" then .[0] else . end)
      | [.services[]?, .workers[]?, .jobs[]?, .static_sites[]?]
      | .[] | "\(.name) \(.source_commit_hash // "")"')
  if [ -z "$commits" ]; then
    echo "::error::Deployment $dep of $app_name lists no components"
    exit 1
  fi
  bad=$(awk -v w="$want" '$2 != w' <<<"$commits")
  if [ -n "$bad" ]; then
    echo "::error::$app_name deployment $dep is not running ${want:0:9}. Master likely moved during the deploy, so this commit skipped its CI gate. Live components:"
    echo "$bad"
    exit 1
  fi
  echo "$app_name deployment $dep runs ${want:0:9} on every component"
fi

ingress=$(retry doctl apps get "$app_id" --format DefaultIngress --no-header)
case "$ingress" in
  https://*) ;;
  *) echo "::error::$app_name has no default ingress (got '$ingress')"; exit 1 ;;
esac

headers=$(mktemp)
trap 'rm -f "$headers"' EXIT
edge_headers() { grep -i -E '^(server|cf-ray|cf-mitigated|cf-cache-status):' "$headers" || true; }

url=${ingress%/}$path
code=000
for attempt in 1 2 3 4 5 6; do
  code=$(curl -sS -o /dev/null -D "$headers" -w '%{http_code}' --max-time 15 "$url" || true)
  if [ "$code" = 200 ]; then
    echo "$url answered 200"
    break
  fi
  echo "::warning::$url answered ${code} (attempt $attempt of 6)"
  [ "$attempt" -eq 6 ] || sleep 10
done
if [ "$code" != 200 ]; then
  echo "::error::$url did not answer 200 (last: $code). Edge headers:"
  edge_headers
  exit 1
fi

# Informational only: never fails the job.
url=$public$path
code=$(curl -sS -o /dev/null -D "$headers" -w '%{http_code}' --max-time 15 "$url" || true)
if [ "$code" = 200 ]; then
  echo "$url answered 200"
elif grep -qi '^cf-mitigated: *challenge' "$headers"; then
  echo "::warning::Cloudflare challenged this runner at $url ($code, cf-mitigated: challenge); the default ingress answered 200, so the app is up"
else
  echo "::warning::$url answered $code (informational; the default ingress answered 200). Edge headers:"
  edge_headers
fi
