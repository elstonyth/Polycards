#!/usr/bin/env pwsh
# Apply a committed .do/<app>.app.yaml spec to its DigitalOcean App Platform app.
#
# Backend secrets are redacted in the committed spec (.do/backend.app.yaml) and
# injected here from gitignored deploy/.env.deploy at apply time, so no secret
# is ever committed. The committed .do/*.yaml is the single source of truth —
# edit it, then run this; never edit the app in the DO UI (that causes drift).
#
#   pwsh scripts/do-apply.ps1 backend -Validate     # validate only, NO live change
#   pwsh scripts/do-apply.ps1 backend               # validate + REDEPLOY prod
#   pwsh scripts/do-apply.ps1 storefront -Validate
#
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('backend', 'storefront')][string]$App,
  [switch]$Validate
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

$ids = @{
  backend    = '7fd66ea2-0105-420b-87eb-8a4606262561'
  storefront = '4bf179e0-70a8-4fd7-bd25-9be43e9d0319'
}

$tmpl = Join-Path $root ".do/$App.app.yaml"
if (-not (Test-Path $tmpl)) { throw "Missing committed spec: $tmpl" }
$spec = Get-Content $tmpl -Raw

if ($App -eq 'backend') {
  $envFile = Join-Path $root 'deploy/.env.deploy'
  if (-not (Test-Path $envFile)) {
    throw "Missing $envFile (gitignored secrets). Recreate from the DO managed-DB connection strings + generated JWT/COOKIE secrets."
  }
  $secrets = @{}
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $kv = $line -split '=', 2
    $secrets[$kv[0].Trim()] = $kv[1].Trim()
  }
  # GLOBEPAY_* added 2026-07-29 with the real gateway. Both key values are the
  # bare base64 body on ONE line (no PEM armor) — the module re-wraps them, and
  # a multi-line value would break the literal substitution below.
  #
  # TWILIO_* added 2026-08-04 with the phone-verification cutover. Every name
  # here is required unconditionally — the list and the spec placeholders move
  # together, and both only after deploy/.env.deploy carries the real values,
  # or the throw below blocks EVERY backend apply rather than one feature.
  #
  # TELEGRAM_BOT_TOKEN added 2026-08-21 with the apex-pull board. The live app
  # already carries the value (applied straight through `doctl apps update` on
  # the day), so this entry exists to stop the next full-spec apply from
  # DELETING it — App Platform replaces the whole spec, it does not merge.
  #
  # TGPAY_PUBLIC_KEY / TGPAY_SECRET_KEY added 2026-09-06 for the TGPay cutover
  # (plan 130); values from the production back office, 2FA-gated.
  foreach ($k in 'DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'COOKIE_SECRET', 'ADMIN_PASSWORD', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'GOOGLE_CLIENT_SECRET', 'RESEND_API_KEY', 'PRICECHARTING_API_TOKEN', 'GLOBEPAY_AES_KEY', 'GLOBEPAY_PUBLIC_KEY', 'GLOBEPAY_MERCHANT_PRIVATE_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SERVICE_SID', 'TELEGRAM_BOT_TOKEN', 'TGPAY_PUBLIC_KEY', 'TGPAY_SECRET_KEY') {
    if (-not $secrets.ContainsKey($k) -or [string]::IsNullOrWhiteSpace($secrets[$k])) {
      throw "deploy/.env.deploy is missing a value for $k"
    }
    $token = "__SECRET__${k}__"
    if (-not $spec.Contains($token)) { throw "Spec has no placeholder $token" }
    # Literal replace (both args literal) — safe for $ / regex-special chars in secrets.
    $spec = $spec.Replace($token, $secrets[$k])
  }
}

if ($spec -match '__SECRET__') {
  throw 'Unresolved secret placeholder remains — aborting (would push a redacted secret to prod).'
}

# Resolved spec is written to gitignored deploy/ (never committed).
$out = Join-Path $root "deploy/$App.app.yaml"
[System.IO.File]::WriteAllText($out, $spec)

Write-Host "Validating $out ..."
# Output SUPPRESSED on purpose: doctl echoes the fully RESOLVED spec, which at
# this point holds every production secret in plaintext (DB/Redis URLs, JWT and
# COOKIE secrets, admin password, S3 and API keys). Printing it put the lot in a
# terminal scrollback and a chat log on 2026-07-29. Only the failure output is
# surfaced, and only when validation actually fails.
$validateOutput = doctl apps spec validate $out 2>&1
if ($LASTEXITCODE -ne 0) {
  # Even here, print only the lines that look like errors — never the spec body.
  $validateOutput | Where-Object { $_ -match '(?i)error|invalid|failed' } | Write-Host
  throw 'doctl apps spec validate failed (spec body withheld: it contains resolved secrets)'
}

if ($Validate) {
  Write-Host 'Validation OK (no live change; -Validate set).' -ForegroundColor Green
  return
}

Write-Host "Updating app $($ids[$App]) ($App) — this REDEPLOYS production." -ForegroundColor Yellow
doctl apps update $ids[$App] --spec $out
if ($LASTEXITCODE -ne 0) { throw 'doctl apps update failed' }
Write-Host 'Applied.' -ForegroundColor Green
