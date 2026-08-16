$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ConfigDir = Join-Path $env:APPDATA 'chatgpt-sol-local-bridge'
$EnvFile = Join-Path $ConfigDir 'runtime.env'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node 20+ is required' }
if (-not (Get-Command tunnel-client -ErrorAction SilentlyContinue)) { throw 'Install tunnel-client from https://github.com/openai/tunnel-client/releases' }
$TunnelId = Read-Host 'Tunnel ID (tunnel_...)'
if ($TunnelId -notmatch '^tunnel_[A-Za-z0-9_-]+$') { throw 'Invalid tunnel ID' }
$SecureKey = Read-Host 'Runtime API key' -AsSecureString
$Ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureKey)
try { $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Ptr) }
$Roots = Read-Host "Workspace roots separated by ; [$Repo]"
if ([string]::IsNullOrWhiteSpace($Roots)) { $Roots = $Repo }
$FirstRoot = $Roots.Split(';')[0]
$DefaultWorkspace = Read-Host "Default workspace (one directory) [$FirstRoot]"
if ([string]::IsNullOrWhiteSpace($DefaultWorkspace)) { $DefaultWorkspace = $FirstRoot }
$Profile = Read-Host 'Tunnel profile [sol-local-bridge]'
if ([string]::IsNullOrWhiteSpace($Profile)) { $Profile = 'sol-local-bridge' }
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$Base = @()
$DevEnv = Join-Path $Repo '.env'
if (Test-Path $DevEnv) {
  $Base = Get-Content $DevEnv | Where-Object { $_ -notmatch '^(WORKSPACE_ROOTS|DEFAULT_WORKSPACE|MCP_TOKEN|CONTROL_PLANE_TUNNEL_ID|CONTROL_PLANE_API_KEY|TUNNEL_PROFILE|TUNNEL_HEALTH_PORT)=' }
} else {
  $Base = @('HOST=127.0.0.1','PORT=8765','ALLOW_TOOL_ROOT_REGISTRATION=false','INCLUDE_COMMON_WORKSPACE_ROOTS=false','DESTRUCTIVE_APPROVAL_MODE=chat','ALLOW_PRIVATE_NETWORK=false')
}
$Base + @(
  "WORKSPACE_ROOTS=$Roots", "DEFAULT_WORKSPACE=$DefaultWorkspace",
  "CONTROL_PLANE_TUNNEL_ID=$TunnelId", "CONTROL_PLANE_API_KEY=$ApiKey",
  "TUNNEL_PROFILE=$Profile", 'TUNNEL_HEALTH_PORT=8766'
) | Set-Content -Path $EnvFile -Encoding UTF8
$Principal = "$env:USERDOMAIN\$env:USERNAME"
& icacls.exe $ConfigDir /inheritance:r /grant:r "${Principal}:(OI)(CI)F" | Out-Null
& icacls.exe $EnvFile /inheritance:r /grant:r "${Principal}:F" | Out-Null
$HostValue = & node (Join-Path $Repo 'scripts\runtime-value.mjs') $EnvFile HOST
$PortValue = & node (Join-Path $Repo 'scripts\runtime-value.mjs') $EnvFile PORT
$UrlHost = if ($HostValue.Contains(':')) { "[$HostValue]" } else { $HostValue }
$HealthPort = & node (Join-Path $Repo 'scripts\runtime-value.mjs') $EnvFile TUNNEL_HEALTH_PORT
& node (Join-Path $Repo 'scripts\run-with-env.mjs') $EnvFile -- tunnel-client init --force --sample sample_mcp_remote_no_auth --profile $Profile --tunnel-id $TunnelId --health-listen-addr "127.0.0.1:$HealthPort" --mcp-server-url "http://${UrlHost}:${PortValue}/mcp"
& node (Join-Path $Repo 'scripts\run-with-env.mjs') $EnvFile -- tunnel-client doctor --profile $Profile --explain
$ApiKey = $null
Write-Host "Configured. runtime.env is authoritative for services: $EnvFile"
Write-Host 'Run: .\scripts\windows\service.ps1 install'
Write-Host 'Then create the Tunnel app at https://chatgpt.com/#settings/Connectors'
