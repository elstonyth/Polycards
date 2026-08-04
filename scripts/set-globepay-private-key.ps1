#!/usr/bin/env pwsh
# Copy OUR GlobePay365 merchant RSA private key into deploy/.env.deploy.
#
#   pwsh scripts/set-globepay-private-key.ps1
#
# Exists because the value is the one deploy secret that is NOT handed over by
# GlobePay — it is our own key, sitting on the operator's disk — and pasting a
# one-liner that reads it has twice been mangled by shell quoting. Prints the
# LENGTH only; the key body never reaches a terminal, a transcript, or git.
#
# Writes the bare base64 body on ONE line: no PEM armor, no newlines. packs/
# globepay.ts toPem() re-wraps it, and do-apply.ps1 substitutes it literally
# into the spec, so armor or a line break would break both.
[CmdletBinding()]
param(
  [string]$Pem = "$env:USERPROFILE\.secrets\globepay\merchant_private_prod.pem"
)
$ErrorActionPreference = 'Stop'

$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'deploy/.env.deploy'
if (-not (Test-Path $Pem)) { throw "Missing private key: $Pem" }
if (-not (Test-Path $envFile)) { throw "Missing $envFile" }

$body = ((Get-Content $Pem) | Where-Object { $_ -notmatch '^-----' }) -join ''
$body = $body.Trim()
if ($body.Length -lt 100 -or $body -notmatch '^[A-Za-z0-9+/=]+$') {
  throw "Extracted body does not look like a base64 key (length $($body.Length)) — check $Pem"
}

$key = 'GLOBEPAY_MERCHANT_PRIVATE_KEY'
$lines = Get-Content $envFile
if (-not ($lines | Where-Object { $_ -like "$key=*" })) { throw "$envFile has no $key line" }
$lines = $lines | ForEach-Object { if ($_ -like "$key=*") { "$key=$body" } else { $_ } }
Set-Content $envFile $lines -Encoding utf8

Write-Output "$key written to deploy/.env.deploy — length $($body.Length), armor stripped, single line"
