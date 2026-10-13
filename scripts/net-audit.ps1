# Outbound-TCP audit for the claude-code engine (zero-Anthropic-traffic proof).
#
#   powershell -NoProfile -File scripts/net-audit.ps1 -Out audit.jsonl [-Match 'e2e-real\.ts'] [-IntervalMs 400]
#   installed app (the core runs in the Electron main process):
#   powershell -NoProfile -File scripts/net-audit.ps1 -Out audit.jsonl -RootName 'Obsidian Code.exe' -Match '.' -Exclude '--type='
#
# Every tick it finds the root process(es) named -RootName (default node.exe) whose command line matches -Match and not
# -Exclude (e.g. the core started by scripts/e2e-real.ts, or the installed app's main process — its renderer/GPU/network
# children carry --type=), collects ALL their descendants (the bundled claude.exe, shells, subagent children ...) and reads
# `netstat -ano -p tcp` for connections owned by those PIDs. Each distinct (process, remote address, port) is written
# once to -Out as a JSON line; a summary line is added when the roots are gone. Loopback peers (127.0.0.0/8, ::1) are
# flagged; everything else must be a site a web tool fetched on purpose. Nothing is ever sent anywhere by this script.
#
# Limits: TCP only (UDP/DNS has no peer in netstat); a connection that opens and closes between two ticks is missed.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Match = 'e2e-real\.ts',
  [string]$RootName = 'node.exe',
  [string]$Exclude = '',
  [int]$IntervalMs = 400,
  [int]$StartTimeoutSec = 300,
  [int]$MaxSeconds = 7200
)
$ErrorActionPreference = 'SilentlyContinue'
$seen = @{}
$procs = @{}
$ticks = 0
$sawRoot = $false
$start = Get-Date
Set-Content -Path $Out -Value '' -Encoding utf8

function IsLoopback([string]$a) { return ($a -like '127.*' -or $a -eq '::1' -or $a -eq '[::1]' -or $a -eq 'localhost') }

while ($true) {
  $ticks++
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
  $roots = @($all | Where-Object { $_.Name -eq $RootName -and $_.CommandLine -match $Match -and -not ($Exclude -and $_.CommandLine -match $Exclude) -and $_.ProcessId -ne $PID })
  if ($roots.Count -gt 0) { $sawRoot = $true }
  elseif ($sawRoot) { break }
  elseif (((Get-Date) - $start).TotalSeconds -gt $StartTimeoutSec) { break }
  if (((Get-Date) - $start).TotalSeconds -gt $MaxSeconds) { break }

  $set = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($r in $roots) { [void]$set.Add([int]$r.ProcessId) }
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($p in $all) {
      if ($set.Contains([int]$p.ParentProcessId) -and -not $set.Contains([int]$p.ProcessId)) { [void]$set.Add([int]$p.ProcessId); $grew = $true }
    }
  }
  foreach ($p in $all) {
    if ($set.Contains([int]$p.ProcessId) -and -not $procs.ContainsKey([int]$p.ProcessId)) {
      $cmd = if ($p.CommandLine) { $p.CommandLine.Substring(0, [Math]::Min(110, $p.CommandLine.Length)) } else { '' }
      $procs[[int]$p.ProcessId] = @{ name = $p.Name; cmd = $cmd }
    }
  }

  foreach ($line in (netstat -ano -p tcp)) {
    if ($line -notmatch '^\s*TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$') { continue }
    $local = $Matches[1]; $remote = $Matches[2]; $state = $Matches[3]; $opid = [int]$Matches[4]
    if (-not $set.Contains($opid)) { continue }
    if ($state -eq 'LISTENING') { continue }
    $ci = $remote.LastIndexOf(':')
    $raddr = $remote.Substring(0, $ci).Trim('[', ']')
    $rport = $remote.Substring($ci + 1)
    $name = $procs[$opid].name
    $isLoop = IsLoopback $raddr
    # loopback peers are one row per process (the peer port of a loopback socket is just the other side's ephemeral port)
    $key = if ($isLoop) { "$name|loopback" } else { "$name|$raddr|$rport" }
    if ($seen.ContainsKey($key)) {
      $seen[$key].count++
      if ($isLoop -and $seen[$key].ports.Count -lt 40 -and -not $seen[$key].ports.Contains([int]$rport)) { [void]$seen[$key].ports.Add([int]$rport) }
      continue
    }
    $ports = New-Object 'System.Collections.Generic.List[int]'
    [void]$ports.Add([int]$rport)
    $entry = @{ t = [Math]::Round(((Get-Date) - $start).TotalSeconds, 1); pid = $opid; process = $name; remote = $(if ($isLoop) { 'loopback' } else { $raddr }); port = [int]$rport; ports = $ports; state = $state; loopback = $isLoop; count = 1; cmd = $procs[$opid].cmd }
    $seen[$key] = $entry
    if (-not $isLoop) { Add-Content -Path $Out -Value ($entry | ConvertTo-Json -Compress) -Encoding utf8 }
  }
  Start-Sleep -Milliseconds $IntervalMs
}

$summary = @{
  summary = $true
  ticks = $ticks
  seconds = [Math]::Round(((Get-Date) - $start).TotalSeconds, 0)
  processesSeen = @($procs.GetEnumerator() | ForEach-Object { "$($_.Key):$($_.Value.name)" })
  loopbackPeers = @($seen.Values | Where-Object { $_.loopback } | ForEach-Object { "$($_.process) -> loopback ports $(($_.ports | Sort-Object) -join ',') ($($_.count) samples)" } | Sort-Object -Unique)
  remoteEndpoints = @($seen.Values | Where-Object { -not $_.loopback } | ForEach-Object { "$($_.process) -> $($_.remote):$($_.port) ($($_.count) samples)" } | Sort-Object -Unique)
  remoteCount = @($seen.Values | Where-Object { -not $_.loopback }).Count
}
Add-Content -Path $Out -Value ($summary | ConvertTo-Json -Compress -Depth 4) -Encoding utf8
