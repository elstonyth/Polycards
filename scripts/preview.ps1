# preview.ps1 — start the full PixelSlot dev stack (storefront + backend + admin)
# Used by Claude when the user says "run preview" / "launch dev".
# Dev mode (no build wait) = fastest. For prod visual verify:
#   npm run build; pwsh scripts/serve-standalone.ps1 -Port 4000
#
#   Storefront  http://localhost:3001  (next dev)
#   Backend     http://localhost:9000  (medusa develop)
#   Admin       http://localhost:7000  (vite)
#
# Each server runs detached in its own window so this script returns immediately.

$ErrorActionPreference = 'Stop'
# Derived from this script's own location (scripts/ -> repo root) so renaming or
# moving the checkout doesn't break it.
$ROOT = Split-Path $PSScriptRoot -Parent

function Test-Port($port) {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Start-Server($title, $dir, $cmd, $port) {
    if (Test-Port $port) {
        Write-Host "[skip] $title already on :$port"
        return
    }
    Write-Host "[boot] $title on :$port"
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $cmd -WorkingDirectory $dir -WindowStyle Minimized | Out-Null
}

# Infra (no-op if already up / not using docker)
docker start pokenic-postgres 2>$null | Out-Null
docker start pokenic-redis    2>$null | Out-Null

Start-Server 'Backend'    "$ROOT\backend\packages\api" 'corepack yarn dev' 9000
Start-Server 'Storefront' "$ROOT"                       'npm run dev'       3001
# Admin: yarn dev fails (vite not on PATH); call the hoisted bin directly.
Start-Server 'Admin'      "$ROOT\backend\apps\admin"    '..\..\node_modules\.bin\vite.CMD --port 7000' 7000

Write-Host ''
Write-Host 'Stack starting (detached). URLs:'
Write-Host '  Storefront  http://localhost:3001'
Write-Host '  Backend     http://localhost:9000'
Write-Host '  Admin       http://localhost:7000'
Write-Host 'Kill all node: Get-Process node | Stop-Process -Force'
