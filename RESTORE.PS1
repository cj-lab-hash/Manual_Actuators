param(
  [string]$NewDbUrl = $env:NEW_DB,
  [string]$DumpFile
)

# --- Safety checks ---
if (-not $NewDbUrl) {
  Write-Host "? No NEW DB URL provided." -ForegroundColor Red
  Write-Host "   Set `$env:NEW_DB first, or run: .\restore.ps1 -NewDbUrl 'postgresql://...'"
  exit 1
}

if (-not $DumpFile) {
  Write-Host "? No dump file provided." -ForegroundColor Red
  Write-Host "   Example: .\restore.ps1 -DumpFile .\db_backups\backup-YYYYMMDD-HHMM.dump"
  exit 1
}

if (-not (Test-Path $DumpFile)) {
  Write-Host "? Dump file not found: $DumpFile" -ForegroundColor Red
  exit 2
}

# Require SSL for hosted DBs (Render)
$env:PGSSLMODE = "require"

Write-Host "? Starting restore..." -ForegroundColor Green
Write-Host "   Source dump: $DumpFile"
Write-Host "   Target DB:   (hidden)"

# Restore into the new DB
# --clean --if-exists helps avoid conflicts if objects already exist
pg_restore --clean --if-exists --no-owner --no-acl -d $NewDbUrl $DumpFile
$code = $LASTEXITCODE

if ($code -ne 0) {
  Write-Host "? Restore FAILED (exit code $code)" -ForegroundColor Red
  exit $code
}

Write-Host "? Restore complete!" -ForegroundColor Green

# Quick verification (optional)
Write-Host "?? Verifying tables..." -ForegroundColor Yellow
psql $NewDbUrl -c "SELECT COUNT(*) AS cells_count FROM cells;" | Out-Host