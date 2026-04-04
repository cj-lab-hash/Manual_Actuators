param(
  [string]$DbUrl = $env:RENDER_DB,
  [string]$OutDir = ".\db_backups"
)

# --- Safety checks ---
if (-not $DbUrl) {
  Write-Host "? No DB URL provided." -ForegroundColor Red
  Write-Host "   Set `$env:RENDER_DB first, or run: .\backup.ps1 -DbUrl 'postgresql://...'"
  exit 1
}

# Ensure output directory exists
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Require SSL for hosted DBs (Render)
$env:PGSSLMODE = "require"

# Timestamped filename
$ts = Get-Date -Format "yyyyMMdd-HHmm"
$backupFile = Join-Path $OutDir "backup-$ts.dump"

Write-Host "? Starting backup..." -ForegroundColor Green
Write-Host "   Output: $backupFile"

# Run pg_dump (custom format)
pg_dump -Fc --no-owner --no-acl -f $backupFile $DbUrl
$code = $LASTEXITCODE

if ($code -ne 0) {
  Write-Host "? Backup FAILED (exit code $code)" -ForegroundColor Red
  exit $code
}

# Confirm file exists and show size
if (Test-Path $backupFile) {
  $info = Get-Item $backupFile
  Write-Host "? Backup complete!" -ForegroundColor Green
  Write-Host ("   File: {0} ({1:N0} bytes)" -f $info.FullName, $info.Length)
} else {
  Write-Host "? Backup command succeeded but file not found. Check permissions/path." -ForegroundColor Red
  exit 2
}