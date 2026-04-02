# scripts/backup-db.ps1

if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
    Write-Error "❌ pg_dump not found. Install PostgreSQL client tools first."
    exit 1
}

$env:DATABASE_URL = "postgresql://database_sql_w7vd_user:WPMdfpGi6LHAliH5UWfLoLGhqlArHab0@dpg-d76tck95pdvs7385omhg-a.oregon-postgres.render.com:5432/database_sql_w7vd"

$ProjectRoot = "C:\Users\ccondada\Desktop\BACKUP\Manual_Actuators_WORK"
$BackupDir = "$ProjectRoot\backups"

if (!(Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir | Out-Null
}

$Timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
$BackupFile = "$BackupDir\manual_actuators_$Timestamp.sql"

pg_dump $env:DATABASE_URL > $BackupFile

if ((Get-Item $BackupFile).Length -lt 1000) {
    Write-Error "❌ Backup file is too small. Backup failed."
    exit 1
}

Write-Output "✅ Backup completed: $BackupFile"