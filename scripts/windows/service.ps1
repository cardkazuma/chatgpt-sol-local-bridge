param([ValidateSet('install','uninstall','start','stop','restart','status','logs','logs-follow')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$EnvFile = if ($env:BRIDGE_ENV_FILE) { $env:BRIDGE_ENV_FILE } else { Join-Path $env:APPDATA 'chatgpt-sol-local-bridge\runtime.env' }
$Names = @('ChatGPTSolBridge-Server','ChatGPTSolBridge-Tunnel')
$Kinds = @('server','tunnel')

switch ($Action) {
  'install' {
    if (-not (Test-Path $EnvFile)) { throw "Missing $EnvFile; run configure-tunnel.ps1" }
    $NodePath = (Get-Command node -ErrorAction Stop).Source
    $TunnelPath = (Get-Command tunnel-client -ErrorAction Stop).Source
    for ($i=0; $i -lt $Names.Count; $i++) {
      $taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\run-service.ps1`" -Kind $($Kinds[$i]) -Repo `"$Repo`" -EnvFile `"$EnvFile`" -NodePath `"$NodePath`" -TunnelPath `"$TunnelPath`""
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
      $settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
      $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $Names[$i] -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
      Start-ScheduledTask -TaskName $Names[$i]
    }
    Start-Sleep -Seconds 2
    & $PSCommandPath status
  }
  'uninstall' { foreach ($name in $Names) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue }; Write-Host 'Tasks removed; config/state kept' }
  'start' { foreach ($name in $Names) { Start-ScheduledTask -TaskName $name } }
  'stop' { foreach ($name in $Names) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue } }
  'restart' { & $PSCommandPath stop; & $PSCommandPath start }
  'status' {
    foreach ($Name in $Names) {
      $Task = Get-ScheduledTask -TaskName $Name
      $Info = Get-ScheduledTaskInfo -TaskName $Name
      [pscustomobject]@{ TaskName=$Name; State=$Task.State; LastTaskResult=$Info.LastTaskResult; LastRunTime=$Info.LastRunTime }
    }
    $Config = @{}; Get-Content $EnvFile | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object { $k,$v=$_.Split('=',2); $Config[$k]=$v }
    $HostName = if ($Config.HOST) { $Config.HOST } else { '127.0.0.1' }
    $Port = if ($Config.PORT) { $Config.PORT } else { '8765' }
    $UrlHost = if ($HostName.Contains(':')) { "[$HostName]" } else { $HostName }
    $TunnelHealthPort = if ($Config.TUNNEL_HEALTH_PORT) { $Config.TUNNEL_HEALTH_PORT } else { '8766' }
    try { Invoke-RestMethod "http://${UrlHost}:${Port}/healthz" | ConvertTo-Json -Depth 5 } catch { Write-Error $_ }
    try { Invoke-RestMethod "http://127.0.0.1:${TunnelHealthPort}/readyz" | ConvertTo-Json -Depth 5 } catch { Write-Error "Tunnel not ready: $_" }
  }
  'logs' {
    $Files = Get-ChildItem (Join-Path $env:USERPROFILE '.chatgpt-sol-local-bridge\logs\*.log') -ErrorAction SilentlyContinue
    if ($Files) { $Files | ForEach-Object { Write-Host "=== $($_.Name) ==="; Get-Content $_.FullName -Tail 100 } } else { Write-Host 'No logs yet' }
  }
  'logs-follow' {
    $Dir = Join-Path $env:USERPROFILE '.chatgpt-sol-local-bridge\logs'; New-Item -ItemType Directory -Force $Dir | Out-Null
    Write-Host 'Following logs; press Ctrl-C to stop'
    $Files = Get-ChildItem "$Dir\*.log" -ErrorAction SilentlyContinue
    if ($Files) { Get-Content -Path $Files.FullName -Tail 100 -Wait } else { Write-Host 'No logs exist yet; start the tasks first' }
  }
}
