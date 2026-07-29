<#
  3000번 Express(node) 만 재시작한다. 모델 서버(llama-server)는 그대로 둔다.
  사용: npm run restart   (또는)  powershell -ExecutionPolicy Bypass -File scripts/restart-express.ps1

  config.js 가 servers.json 을 백엔드 소스로 읽으므로 LLAMA_BACKENDS 를 다시 구성할 필요는 없다.
#>
[CmdletBinding()]
param([int]$Port = 3000)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot/init-console.ps1"
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$root = Split-Path -Parent $scriptDir
$logDir = Join-Path $root "llama\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 해당 포트를 점유한 Express(node) 만 종료 — llama-server 는 건드리지 않는다.
$killed = 0
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object {
    $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
    Write-Host "[restart] Express 종료 PID=$_ ($($p.ProcessName))" -ForegroundColor DarkGray
    $script:killed++
  }
if ($killed -eq 0) { Write-Host "[restart] 실행 중인 Express 없음 → 새로 기동" -ForegroundColor DarkGray }

Start-Sleep -Milliseconds 600

# 새 Express 기동 (백엔드 목록은 servers.json 에서 읽음)
$env:PORT = "$Port"
$expLog = Join-Path $logDir "express.log"
Start-Process -FilePath "node" -ArgumentList @("src/server.js") -WorkingDirectory $root `
  -RedirectStandardOutput $expLog -RedirectStandardError "$expLog.err" -WindowStyle Hidden | Out-Null

Start-Sleep -Seconds 2
Write-Host ""
Write-Host "[restart] Express 재시작 완료 (모델 서버 유지)" -ForegroundColor Green
Write-Host "     테스트 콘솔 : http://localhost:$Port/"
Write-Host "     모델 관리   : http://localhost:$Port/models.html"
Write-Host "     서버 모니터 : http://localhost:$Port/monitor.html"
Write-Host "     로그        : $expLog (.err)"
