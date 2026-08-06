[CmdletBinding()]
param(
  [ValidatePattern('^[A-Za-z0-9._@-]+$')]
  [string]$Server = 'bot',

  [ValidateRange(1, 65535)]
  [int]$SshPort = 443,

  [ValidatePattern('^/[A-Za-z0-9._/-]+$')]
  [string]$RemoteBackupDirectory = '/opt/walletscaner/backups',

  [string]$LocalBackupRoot = (Join-Path $HOME 'WalletscanerBackups'),

  [ValidatePattern('^memecoin_alpha_[A-Za-z0-9_.-]+\.dump$')]
  [string]$BackupName,

  [ValidateRange(1000, 1000000)]
  [int]$BandwidthKbps = 20000,

  [ValidateRange(1, 10)]
  [int]$TransferAttempts = 4,

  [switch]$AcknowledgeRemote
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Native {
  param(
    [Parameter(Mandatory)]
    [scriptblock]$Command,
    [Parameter(Mandatory)]
    [string]$FailureMessage
  )

  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw $FailureMessage
  }
}

if (-not $BackupName) {
  $remoteDiscovery = "find '$RemoteBackupDirectory' -maxdepth 1 -type f -name 'memecoin_alpha_*.dump' -printf '%T@|%f\n' | sort -nr | head -n 1"
  $latestOutput = & ssh -p $SshPort $Server $remoteDiscovery
  $latest = if ($null -eq $latestOutput) { '' } else { ([string]$latestOutput).Trim() }
  if ($LASTEXITCODE -ne 0 -or -not $latest) {
    throw "No PostgreSQL dump found in $Server`:$RemoteBackupDirectory"
  }

  $BackupName = ($latest -split '\|', 2)[1]
  if ($BackupName -notmatch '^memecoin_alpha_[A-Za-z0-9_.-]+\.dump$') {
    throw "Remote backup name failed validation: $BackupName"
  }
}

$backupStem = $BackupName -replace '\.dump$', ''
$targetDirectory = Join-Path $LocalBackupRoot $backupStem
New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
$targetDirectory = (Resolve-Path -LiteralPath $targetDirectory).Path
$backupRoot = (Resolve-Path -LiteralPath $LocalBackupRoot).Path
if (-not $targetDirectory.StartsWith($backupRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to write outside the configured local backup root.'
}

$dumpPath = Join-Path $targetDirectory $BackupName
$partialDumpPath = "$dumpPath.partial"
$sidecarName = "$BackupName.sha256"
$sidecarPath = Join-Path $targetDirectory $sidecarName
$partialSidecarPath = "$sidecarPath.partial"
$remoteDump = "$RemoteBackupDirectory/$BackupName"
$remoteSidecar = "$remoteDump.sha256"

Remove-Item -LiteralPath $partialSidecarPath -Force -ErrorAction SilentlyContinue
Invoke-Native -FailureMessage 'Checksum sidecar transfer failed.' -Command {
  scp -P $SshPort "${Server}:$remoteSidecar" $partialSidecarPath
}
Move-Item -LiteralPath $partialSidecarPath -Destination $sidecarPath -Force

$expectedLine = (Get-Content -Raw -Encoding utf8 -LiteralPath $sidecarPath).Trim()
$expectedHash = (($expectedLine -split '\s+')[0]).ToLowerInvariant()
if ($expectedHash -notmatch '^[a-f0-9]{64}$') {
  throw 'Remote checksum sidecar is invalid.'
}

$needsTransfer = $true
if (Test-Path -LiteralPath $dumpPath) {
  $existingHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dumpPath).Hash.ToLowerInvariant()
  $needsTransfer = $existingHash -ne $expectedHash
}

if ($needsTransfer) {
  $sftpBatchPath = Join-Path $targetDirectory ".sftp-$PID.txt"
  $sftpLocalPath = $partialDumpPath.Replace('\', '/')
  @(
    "reget `"$remoteDump`" `"$sftpLocalPath`""
    'bye'
  ) | Set-Content -Encoding ascii -LiteralPath $sftpBatchPath

  $transferComplete = $false
  try {
    for ($attempt = 1; $attempt -le $TransferAttempts; $attempt++) {
      & sftp -q -P $SshPort -l $BandwidthKbps -o ServerAliveInterval=30 -o ServerAliveCountMax=10 -b $sftpBatchPath $Server
      if ($LASTEXITCODE -eq 0) {
        $transferComplete = $true
        break
      }
      if ($attempt -lt $TransferAttempts) {
        Start-Sleep -Seconds ([Math]::Min(30, 5 * $attempt))
      }
    }
  } finally {
    Remove-Item -LiteralPath $sftpBatchPath -Force -ErrorAction SilentlyContinue
  }

  if (-not $transferComplete) {
    throw "PostgreSQL dump transfer failed after $TransferAttempts resumable attempts."
  }

  $partialHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $partialDumpPath).Hash.ToLowerInvariant()
  if ($partialHash -ne $expectedHash) {
    Remove-Item -LiteralPath $partialDumpPath -Force
    throw "Transferred dump checksum mismatch: expected=$expectedHash actual=$partialHash"
  }
  Move-Item -LiteralPath $partialDumpPath -Destination $dumpPath -Force
}

$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dumpPath).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
  throw "Local dump checksum mismatch: expected=$expectedHash actual=$actualHash"
}

$archiveListVerification = $null
$localPgRestore = Get-Command pg_restore -ErrorAction SilentlyContinue
if ($localPgRestore) {
  Invoke-Native -FailureMessage 'Local pg_restore could not read the downloaded archive.' -Command {
    & $localPgRestore.Source --list $dumpPath *> $null
  }
  $archiveListVerification = 'offsite-pg_restore-binary'
} else {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  docker info *> $null
  $dockerAvailable = $LASTEXITCODE -eq 0
  $ErrorActionPreference = $previousErrorActionPreference
  if ($dockerAvailable) {
    Invoke-Native -FailureMessage 'Docker pg_restore could not read the downloaded archive.' -Command {
      docker run --rm -v "${targetDirectory}:/backup:ro" postgres:16-alpine pg_restore --list "/backup/$BackupName" *> $null
    }
    $archiveListVerification = 'offsite-docker-postgres16'
  } else {
    # The downloaded file already matched the source SHA-256 byte for byte. If
    # no local PostgreSQL runtime is available, parsing that identical archive
    # on the source host still proves format readability without weakening the
    # independent offsite checksum gate.
    $remoteVerify = "docker run --rm --name walletscaner-offsite-verify-$PID --label com.docker.compose.project=walletscaner --memory=64m --cpus=0.02 --pids-limit=32 -v '${RemoteBackupDirectory}:/backup:ro' postgres:16-alpine pg_restore --list '/backup/$BackupName' >/dev/null"
    Invoke-Native -FailureMessage 'Source PostgreSQL 16 pg_restore could not read the byte-identical archive.' -Command {
      ssh -p $SshPort $Server $remoteVerify
    }
    $archiveListVerification = 'offsite-sha256+source-postgres16-byte-identical'
  }
}

$verifiedAt = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
$manifestPath = Join-Path $targetDirectory 'backup-manifest.json'
$fullRestoreVerified = $false
$fullRestoreVerifiedAt = $null
if (Test-Path -LiteralPath $manifestPath) {
  try {
    $existingManifest = Get-Content -Raw -Encoding utf8 -LiteralPath $manifestPath | ConvertFrom-Json
    if (
      $existingManifest.sha256 -eq $actualHash -and
      $existingManifest.fullRestoreVerified -eq $true
    ) {
      $fullRestoreVerified = $true
      $fullRestoreVerifiedAt = $existingManifest.fullRestoreVerifiedAt
    }
  } catch {
    Write-Warning "Ignoring unreadable prior backup manifest: $($_.Exception.Message)"
  }
}
$manifest = [ordered]@{
  backupName = $BackupName
  source = "$Server`:$remoteDump"
  localPath = $dumpPath
  bytes = (Get-Item -LiteralPath $dumpPath).Length
  sha256 = $actualHash
  archiveListVerified = $true
  archiveListVerification = $archiveListVerification
  fullRestoreVerified = $fullRestoreVerified
  fullRestoreVerifiedAt = $fullRestoreVerifiedAt
  verifiedAt = $verifiedAt
}
$manifest | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath $manifestPath

if ($AcknowledgeRemote) {
  $ackName = "$BackupName.offsite-verified"
  $ackPath = Join-Path $targetDirectory $ackName
  $remoteAck = "$RemoteBackupDirectory/$ackName"
  $remoteAckTemp = "$remoteAck.partial"
  $ackLines = @(
    "sha256=$actualHash"
    "verified_at=$verifiedAt"
    "verification=$archiveListVerification"
  )
  [IO.File]::WriteAllText($ackPath, (($ackLines -join "`n") + "`n"), [Text.Encoding]::ASCII)

  Invoke-Native -FailureMessage 'Remote off-site acknowledgement upload failed.' -Command {
    scp -P $SshPort $ackPath "${Server}:$remoteAckTemp"
  }
  $remoteCommit = "test -f '$remoteDump' && test -f '$remoteSidecar' && mv '$remoteAckTemp' '$remoteAck'"
  Invoke-Native -FailureMessage 'Remote off-site acknowledgement commit failed.' -Command {
    ssh -p $SshPort $Server $remoteCommit
  }
}

[pscustomobject]$manifest
