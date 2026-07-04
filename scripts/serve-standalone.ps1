# serve-standalone.ps1 — serve the production storefront from the standalone bundle.
#
# WHY this exists: next.config.ts sets `output: 'standalone'`, which makes
# `npx next start` unusable (it errors / serves a stripped app). The standalone
# server is `.next/standalone/server.js`, but Next does NOT copy the static
# assets or `public/` into that dir — you must copy them yourself, or every
# /_next/static asset and public image 404s. This script does the copy and boots
# the server on the given port (default 4000, the verify port from CLAUDE.md).
#
#   npm run build              # first — emits .next/standalone
#   pwsh scripts/serve-standalone.ps1 [-Port 4000]
#
# Reads NEXT_PUBLIC_* from .env.local at BUILD time (already baked in), so just
# run after a build. Backend must be up on :9000 for card images to resolve.
#
# WORKTREE QUIRK: in a git worktree under .worktrees/<branch>/, Next infers the
# file-tracing root at the MAIN repo (walks up to its package-lock.json) and
# nests the bundle as .next/standalone/.worktrees/<branch>/server.js. So we
# probe for server.js (shallowest match, skipping bundled node_modules) instead
# of assuming the flat layout, and copy assets relative to wherever it landed.

param([int]$Port = 4000)

$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$STANDALONE = Join-Path $ROOT '.next\standalone'

$server = Get-ChildItem -Path $STANDALONE -Recurse -Filter server.js -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
    Sort-Object { $_.FullName.Length } |
    Select-Object -First 1
if (-not $server) {
    throw "No server.js under .next/standalone -- run 'npm run build' first (output: standalone)."
}
$APPDIR = $server.DirectoryName

# Next emits the standalone server but leaves these for you to copy. Remove any
# previous copy first: Copy-Item into an existing dir would nest (static\static).
$staticDest = Join-Path $APPDIR '.next\static'
if (Test-Path $staticDest) { Remove-Item -Recurse -Force $staticDest }
Copy-Item -Recurse -Force (Join-Path $ROOT '.next\static') $staticDest
if (Test-Path (Join-Path $ROOT 'public')) {
    $publicDest = Join-Path $APPDIR 'public'
    if (Test-Path $publicDest) { Remove-Item -Recurse -Force $publicDest }
    Copy-Item -Recurse -Force (Join-Path $ROOT 'public') $publicDest
}

$env:PORT = "$Port"
$env:HOSTNAME = '127.0.0.1'
Write-Host "[serve-standalone] $($server.FullName) -> http://localhost:$Port (Ctrl+C to stop)"
node $server.FullName
