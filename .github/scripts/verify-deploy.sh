#!/usr/bin/env bash
# Checks a DigitalOcean app after its deployment went ACTIVE.
# Used by .github/workflows/deploy.yml and rollback.yml. Needs doctl, already
# authenticated, plus curl and jq.
#
#   bash .github/scripts/verify-deploy.sh <app-name> <health-url> [expected-sha]
#
# With expected-sha, every component of the live deployment must run that
# commit. A mismatch means master moved between the CI gate and App Platform's
# build, so the live commit skipped this run's gate: that fails loudly.
# Then the public health URL must answer 200 (retried, the edge can lag).
set -euo pipefail

app_name=${1:?usage: verify-deploy.sh <app-name> <health-url> [expected-sha]}
url=${2:?usage: verify-deploy.sh <app-name> <health-url> [expected-sha]}
want=${3:-}

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

if [ -n "$want" ]; then
  apps=$(retry doctl apps list --format ID,Spec.Name --no-header)
  app_id=$(awk -v n="$app_name" '$2 == n { print $1 }' <<<"$apps")
  [ -n "$app_id" ] || { echo "::error::App $app_name not found"; exit 1; }
  dep=$(retry doctl apps get "$app_id" --format ActiveDeployment.ID --no-header)
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

headers=$(mktemp)
code=000
for attempt in 1 2 3 4 5 6; do
  code=$(curl -sS -o /dev/null -D "$headers" -w '%{http_code}' --max-time 15 "$url" || true)
  if [ "$code" = 200 ]; then
    echo "$url answered 200"
    exit 0
  fi
  echo "::warning::$url answered ${code} (attempt $attempt of 6)"
  sleep 10
done

# A Cloudflare challenge to the runner's IP is not the app being down.
echo "::error::$url did not answer 200 (last: $code). Edge headers, to tell a Cloudflare block from an outage:"
grep -i -E '^(server|cf-ray|cf-mitigated|cf-cache-status):' "$headers" || true
exit 1
