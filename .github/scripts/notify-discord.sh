#!/usr/bin/env bash
# Posts one plain message to a Discord channel webhook.
# Used by .github/workflows/deploy.yml and rollback.yml when a step fails.
#
#   DISCORD_WEBHOOK=<url> bash .github/scripts/notify-discord.sh "<message>"
#
# Does nothing when DISCORD_WEBHOOK is unset, so workflows work before the
# secret exists. Never fails the job: the alert is best effort, the failure
# it reports already turned the run red.
set -euo pipefail

message=${1:?usage: notify-discord.sh <message>}

if [ -z "${DISCORD_WEBHOOK:-}" ]; then
  echo "DISCORD_WEBHOOK is not set; skipping the Discord alert"
  exit 0
fi

# Discord caps content at 2000 characters; parse:[] stops @everyone pings.
payload=$(jq -n --arg c "${message:0:1900}" '{content: $c, allowed_mentions: {parse: []}}')
if curl -fsS --max-time 15 --retry 2 -H 'Content-Type: application/json' \
  -d "$payload" "$DISCORD_WEBHOOK" >/dev/null; then
  echo "Posted the alert to Discord"
else
  echo "::warning::Could not post the alert to Discord"
fi
