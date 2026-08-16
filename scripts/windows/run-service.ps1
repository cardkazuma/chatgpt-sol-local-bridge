param(
  [Parameter(Mandatory=$true)][ValidateSet('server','tunnel')][string]$Kind,
  [Parameter(Mandatory=$true)][string]$Repo,
  [Parameter(Mandatory=$true)][string]$EnvFile,
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$TunnelPath
)
$ErrorActionPreference = 'Stop'
$Node = $NodePath
$State = Join-Path $env:USERPROFILE '.chatgpt-sol-local-bridge\logs'
New-Item -ItemType Directory -Force -Path $State | Out-Null
$Out = Join-Path $State "$Kind.out.log"
$Err = Join-Path $State "$Kind.err.log"
$Wrapper = Join-Path $Repo 'scripts\run-with-env.mjs'
if ($Kind -eq 'server') {
  & $Node $Wrapper $EnvFile --exclude=CONTROL_PLANE_API_KEY -- $Node (Join-Path $Repo 'src\server.js') 1>>$Out 2>>$Err
} else {
  & $Node $Wrapper $EnvFile -- $Node (Join-Path $Repo 'scripts\run-tunnel.mjs') $TunnelPath 1>>$Out 2>>$Err
}
$Code = $LASTEXITCODE
if ($Code -eq 0) { exit 1 } # a supervised long-running service should not exit cleanly on its own
exit $Code
