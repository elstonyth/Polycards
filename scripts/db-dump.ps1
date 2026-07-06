# db-dump.ps1 — snapshot a Pokenic Postgres DB to backups/ (gitignored).
#
# Local (default): dumps the pokenic-postgres Docker container's dev DB — the
# only export path for the pokenic_pgdata volume (a `docker volume rm` loses
# the seeded dev world otherwise).
# Remote: pass -DatabaseUrl (e.g. the DO connection string from deploy/.env.deploy);
# pg_dump runs inside a postgres:16 container so no local client is needed.
#
#   pwsh scripts/db-dump.ps1                          # local  -> backups/local-<db>-<ts>.dump
#   pwsh scripts/db-dump.ps1 -DbName medusa           # local, explicit DB name
#   pwsh scripts/db-dump.ps1 -DatabaseUrl $url        # remote -> backups/remote-<ts>.dump
#
# Restore (custom format; local container user is 'medusa'):
#   docker exec -i pokenic-postgres pg_restore -U medusa -d <db> --clean < backups/<file>.dump
param(
    [string]$DatabaseUrl,
    [string]$DbName = 'medusa',
    [string]$Container = 'pokenic-postgres',
    [string]$OutDir = 'backups'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutDir | Out-Null
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$absOut = (Resolve-Path $OutDir).Path

if ($DatabaseUrl) {
    $file = "remote-$ts.dump"
    # -f inside the container + volume mount: avoids piping binary through
    # PowerShell redirection (which can mangle bytes).
    docker run --rm -v "${absOut}:/backups" postgres:16 `
        pg_dump -Fc -d $DatabaseUrl -f "/backups/$file"
} else {
    $file = "local-$DbName-$ts.dump"
    # The container's own POSTGRES_USER (local dev uses 'medusa', not 'postgres').
    docker exec $Container sh -c "pg_dump -U `"`${POSTGRES_USER:-postgres}`" -Fc -d $DbName -f /tmp/$file"
    docker cp "${Container}:/tmp/$file" (Join-Path $absOut $file)
    docker exec $Container rm -f "/tmp/$file"
}
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit $LASTEXITCODE)" }
$size = (Get-Item (Join-Path $absOut $file)).Length
Write-Host "[db-dump] $file ($([math]::Round($size/1MB,2)) MB) -> $absOut"
