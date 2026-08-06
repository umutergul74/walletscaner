[CmdletBinding()]
param(
  [ValidatePattern('^[A-Za-z0-9._@-]+$')]
  [string]$Server = 'bot',

  [ValidateRange(1, 65535)]
  [int]$SshPort = 443,

  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$Container = 'walletscaner-postgres-1',

  [string]$LocalBackupRoot = (Join-Path $HOME 'WalletscanerBackups')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$backupName = "memecoin_alpha_stream_$timestamp.dump"
$targetDirectory = Join-Path $LocalBackupRoot ($backupName -replace '\.dump$', '')
New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
$dumpPath = Join-Path $targetDirectory $backupName
$partialPath = "$dumpPath.partial"
$sidecarPath = "$dumpPath.sha256"
$statusPath = Join-Path $targetDirectory 'stream-manifest.json'

$processInfo = [Diagnostics.ProcessStartInfo]::new()
$processInfo.FileName = 'ssh.exe'
$processInfo.UseShellExecute = $false
$processInfo.RedirectStandardOutput = $true
$processInfo.RedirectStandardError = $true
$remoteCommand =
  "docker exec $Container sh -c 'exec pg_dump -U postgres -d `$POSTGRES_DB -Fc --no-owner --no-acl'"
$processInfo.Arguments = "-p $SshPort $Server `"$remoteCommand`""

$process = [Diagnostics.Process]::new()
$process.StartInfo = $processInfo
$startedAt = [DateTimeOffset]::UtcNow
try {
  Remove-Item -LiteralPath $partialPath -Force -ErrorAction SilentlyContinue
  [void]$process.Start()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $stream = [IO.File]::Open(
    $partialPath,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
  )
  try {
    $copyTask = $process.StandardOutput.BaseStream.CopyToAsync($stream)
    $copyTask.GetAwaiter().GetResult()
  } finally {
    $stream.Dispose()
  }
  $process.WaitForExit()
  $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
  if ($process.ExitCode -ne 0) {
    throw "Remote pg_dump failed with exit code $($process.ExitCode): $stderr"
  }
  if ($stderr) {
    throw "Remote pg_dump wrote unexpected stderr: $stderr"
  }
  $bytes = (Get-Item -LiteralPath $partialPath).Length
  if ($bytes -le 0) {
    throw 'Remote pg_dump produced an empty archive.'
  }
  $sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $partialPath).Hash.ToLowerInvariant()
  Move-Item -LiteralPath $partialPath -Destination $dumpPath
  [IO.File]::WriteAllText(
    $sidecarPath,
    "$sha256  $backupName`n",
    [Text.Encoding]::ASCII
  )
  $manifest = [ordered]@{
    backupName = $backupName
    source = "$Server`:$Container"
    localPath = $dumpPath
    bytes = $bytes
    sha256 = $sha256
    archiveListVerified = $false
    fullRestoreVerified = $false
    startedAt = $startedAt.ToString('yyyy-MM-ddTHH:mm:ssZ')
    completedAt = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  }
  $manifest | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath $statusPath
  [pscustomobject]$manifest
} catch {
  if (-not $process.HasExited) {
    $process.Kill($true)
    $process.WaitForExit()
  }
  Remove-Item -LiteralPath $partialPath -Force -ErrorAction SilentlyContinue
  throw
} finally {
  $process.Dispose()
}
