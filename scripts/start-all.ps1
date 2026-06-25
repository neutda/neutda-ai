<#
  servers.json 에 정의된 LLM 서버들 + Express 를 한 번에 기동한다.

  사용: npm run up   (또는)  powershell -ExecutionPolicy Bypass -File scripts/start-all.ps1

  동작:
    1) servers.json 읽기
    2) 각 LLM 서버를 백그라운드로 실행 (해당 포트가 이미 떠 있으면 건너뜀)
    3) 모든 LLM 서버가 /health 응답할 때까지 대기
    4) LLAMA_BACKENDS 환경변수를 구성해 Express 실행
  종료: npm run down
#>
[CmdletBinding()]
param(
  [int]$Port = 3000,           # Express 포트
  [int]$WaitSec = 180          # LLM 헬스 대기 최대 시간
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot/init-console.ps1"
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$root = Split-Path -Parent $scriptDir

$exe = Join-Path $root "llama\llama-server.exe"
if (-not (Test-Path $exe)) { $exe = "llama-server" }
$logDir = Join-Path $root "llama\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$cfg = Get-Content (Join-Path $root "servers.json") -Raw | ConvertFrom-Json
$servers = $cfg.llmServers

function Test-Listen($p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }
function Test-Health($url) { try { (Invoke-WebRequest "$url/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false } }

$backends = @()

foreach ($s in $servers) {
  $url = "http://127.0.0.1:$($s.port)"
  $device = if ([int]$s.ngl -gt 0) { "gpu" } else { "cpu" }
  $backends += "$($s.tier)@$url@$device"

  if (Test-Listen $s.port) {
    Write-Host "[up] $($s.name) (:$($s.port)) 이미 실행 중 → 건너뜀" -ForegroundColor DarkGray
    continue
  }

  $model = Join-Path $root $s.model
  if (-not (Test-Path $model)) { throw "모델 파일 없음: $model" }

  $args = @("-m", $model, "--host", "127.0.0.1", "--port", "$($s.port)", "-c", "$($s.ctx)", "-ngl", "$($s.ngl)")
  if ($s.mmproj) {
    $mmproj = Join-Path $root $s.mmproj
    if (Test-Path $mmproj) { $args += @("--mmproj", $mmproj) }
  }
  if ($s.gpu -ne $null -and $s.gpu -ne "") { $env:CUDA_VISIBLE_DEVICES = "$($s.gpu)" }

  $log = Join-Path $logDir "server-$($s.port).log"
  Write-Host "[up] $($s.name) [$($s.tier)] → $url  (model=$($s.model))"
  Start-Process -FilePath $exe -ArgumentList $args -RedirectStandardOutput $log -RedirectStandardError "$log.err" -WindowStyle Hidden | Out-Null

  Remove-Item Env:\CUDA_VISIBLE_DEVICES -ErrorAction SilentlyContinue
}

# 헬스 대기
Write-Host "[up] LLM 서버 헬스 대기 (최대 ${WaitSec}s)..." -ForegroundColor Yellow
$deadline = (Get-Date).AddSeconds($WaitSec)
do {
  $pending = @($servers | Where-Object { -not (Test-Health "http://127.0.0.1:$($_.port)") })
  if ($pending.Count -eq 0) { break }
  Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)

if ($pending.Count -gt 0) {
  Write-Host "[up] 경고: 아직 응답 없는 서버: $($pending.port -join ', ') (로그 확인: $logDir)" -ForegroundColor Red
} else {
  Write-Host "[up] 모든 LLM 서버 정상" -ForegroundColor Green
}

# Express (기존 것이 있으면 정리 후 새 설정으로 기동)
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

$env:LLAMA_BACKENDS = ($backends -join ",")
$env:PORT = "$Port"
Write-Host "[up] LLAMA_BACKENDS=$($env:LLAMA_BACKENDS)"
$expLog = Join-Path $logDir "express.log"
Start-Process -FilePath "node" -ArgumentList @("src/server.js") -WorkingDirectory $root `
  -RedirectStandardOutput $expLog -RedirectStandardError "$expLog.err" -WindowStyle Hidden | Out-Null

Start-Sleep -Seconds 2
Write-Host ""
Write-Host "[up] 완료!" -ForegroundColor Green
Write-Host "     테스트 콘솔 : http://localhost:$Port/"
Write-Host "     모니터링    : http://localhost:$Port/monitor.html"
Write-Host "     종료        : npm run down"
