# 데블스랜드를 클라우드 서버(Ubuntu 24.04)에 올린다. Windows PowerShell 5.1 이상, 프로젝트 폴더에서 실행.
#   처음 한 번:  .\deploy\deploy.ps1 -HostName 54.253.64.26 -Setup
#   그 뒤:       .\deploy\deploy.ps1 -HostName 54.253.64.26
# 빌드 → dist 와 package.json·package-lock.json 묶기 → scp 로 올리기 → 서버에서 install-release.sh 실행.
# -Setup 을 붙이면 그 전에 setup-server.sh(Node 설치, 실행 계정, 스왑, 서비스 등록)를 bash 로 돌린다.
# Lightsail 시작 스크립트는 /bin/sh 로 합쳐져 돌아서 bash 전용 문법이 깨지므로 첫 설정도 이렇게 SSH 로 한다.
# 접속 키는 기본으로 ~/.ssh/devilsland_aws 를 쓴다.
param(
  [Parameter(Mandatory = $true)] [string]$HostName,
  [string]$User = 'ubuntu',
  [string]$Key = (Join-Path $HOME '.ssh\devilsland_aws'),
  [switch]$Setup,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Invoke-Native([string]$exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$exe 실패 (종료 코드 $LASTEXITCODE)" }
}

$sshOpts = @('-i', $Key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15')
$target = "$User@$HostName"

if ($Setup) {
  Invoke-Native 'scp.exe' ($sshOpts + @((Join-Path $PSScriptRoot 'setup-server.sh'), "${target}:/tmp/"))
  Invoke-Native 'ssh.exe' ($sshOpts + @($target, "sed -i 's/\r$//' /tmp/setup-server.sh && sudo bash /tmp/setup-server.sh"))
}

if (-not $SkipBuild) { Invoke-Native 'npm.cmd' @('run', 'build') }
foreach ($f in @('dist\server\index.js', 'dist\client\index.html', 'package.json', 'package-lock.json')) {
  if (-not (Test-Path $f)) { throw "$f 이 없습니다. 먼저 npm run build 를 실행하세요." }
}

$pkg = Join-Path $env:TEMP 'devilsland.tgz'
if (Test-Path $pkg) { Remove-Item $pkg -Force }
Invoke-Native 'tar.exe' @('-czf', $pkg, 'dist', 'package.json', 'package-lock.json')
'묶음 크기: {0:N1} MB' -f ((Get-Item $pkg).Length / 1MB)

Invoke-Native 'scp.exe' ($sshOpts + @($pkg, (Join-Path $PSScriptRoot 'install-release.sh'), "${target}:/tmp/"))
Invoke-Native 'ssh.exe' ($sshOpts + @($target, "sed -i 's/\r$//' /tmp/install-release.sh && sudo bash /tmp/install-release.sh"))
Remove-Item $pkg -Force
"올렸습니다: http://$HostName/"
