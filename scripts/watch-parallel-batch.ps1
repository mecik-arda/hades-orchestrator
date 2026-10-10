param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-f0-9]{16,64}$')]
  [string]$BatchId,
  [Parameter(Mandatory = $true)]
  [string]$NodeExecutable,
  [Parameter(Mandatory = $true)]
  [string]$WatcherScript,
  [Parameter(Mandatory = $true)]
  [string]$StateDirectory
)

$Host.UI.RawUI.WindowTitle = "Orkestrasyon V2 Batch $($BatchId.Substring(0, 8))"
try {
  $Host.UI.RawUI.WindowSize = New-Object System.Management.Automation.Host.Size(46, 26)
  $Host.UI.RawUI.BufferSize = New-Object System.Management.Automation.Host.Size(46, 2000)
} catch {
}

$arguments = @(
  ('"{0}"' -f $WatcherScript),
  $BatchId,
  '--state-directory',
  ('"{0}"' -f $StateDirectory)
) -join ' '
$process = Start-Process -FilePath $NodeExecutable -ArgumentList $arguments -NoNewWindow -Wait -PassThru
$global:LASTEXITCODE = $process.ExitCode
