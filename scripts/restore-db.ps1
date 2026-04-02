param (
  [string]$DumpFile
)

if (-not $DumpFile) {
  Write-Error "Usage: ./restore-db.ps1 backups/file.sql"
  exit 1
}

$env:DATABASE_URL="postgresql://NEW_USER:NEW_PASS@NEW_HOST:5432/NEW_DB"
psql $env:DATABASE_URL < $DumpFile