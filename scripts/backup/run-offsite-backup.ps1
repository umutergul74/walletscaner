[CmdletBinding()]
param(
  [string]$LocalBackupRoot = (Join-Path $HOME 'WalletscanerBackups'),
  [ValidateRange(1000, 1000000)]
  [int]$BandwidthKbps = 20000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$pullScript = Join-Path $PSScriptRoot 'pull-verified-postgres-backup.ps1'
$statusDirectory = Join-Path $LocalBackupRoot '_status'
New-Item -ItemType Directory -Force -Path $statusDirectory | Out-Null
$statusPath = Join-Path $statusDirectory 'latest.json'
$temporaryStatusPath = "$statusPath.partial"
$startedAt = [DateTimeOffset]::UtcNow

try {
  $parameters = @{
    LocalBackupRoot = $LocalBackupRoot
    BandwidthKbps = $BandwidthKbps
    TransferAttempts = 4
    AcknowledgeRemote = $true
  }
  $result = & $pullScript @parameters

  $status = [ordered]@{
    outcome = 'success'
    startedAt = $startedAt.ToString('yyyy-MM-ddTHH:mm:ssZ')
    completedAt = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    backup = $result
  }
} catch {
  $status = [ordered]@{
    outcome = 'error'
    startedAt = $startedAt.ToString('yyyy-MM-ddTHH:mm:ssZ')
    completedAt = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    error = $_.Exception.Message
  }
  $status | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 -LiteralPath $temporaryStatusPath
  Move-Item -LiteralPath $temporaryStatusPath -Destination $statusPath -Force
  throw
}

$status | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 -LiteralPath $temporaryStatusPath
Move-Item -LiteralPath $temporaryStatusPath -Destination $statusPath -Force
$status
