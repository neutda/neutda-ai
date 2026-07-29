<#
  servers.json 에 정의된 LLM 서버들 + Express 를 한 번에 기동한다.

  사용: npm run up   (또는)  powershell -ExecutionPolicy Bypass -File scripts/start-all.ps1

  동작:
    1) servers.json 읽기
    2) large → medium → small 순, 같은 티어에선 GPU 우선으로 기동
       (GPU 모델은 하나씩 헬스 확인 후 다음 — VRAM 선점 보장)
    3) 실패/스킵 사유를 data/server-status.json 에 기록 (모니터에 표시)
    4) LLAMA_BACKENDS 환경변수를 구성해 Express 실행
  종료: npm run down
#>
[CmdletBinding()]
param(
  [int]$Port = 3000,           # Express 포트
  [int]$WaitSec = 180          # 서버당 헬스 대기 최대 시간
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
$dataDir = Join-Path $root "data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$statusFile = Join-Path $dataDir "server-status.json"

$cfg = Get-Content (Join-Path $root "servers.json") -Raw | ConvertFrom-Json
$servers = @($cfg.llmServers)

# large → medium → small, 같은 티어에선 GPU(ngl>0) 우선
$tierRank = @{ large = 0; medium = 1; small = 2 }
$servers = @(
  $servers | Sort-Object `
    @{ Expression = { if ($tierRank.ContainsKey([string]$_.tier)) { $tierRank[[string]$_.tier] } else { 9 } } },
    @{ Expression = { if ([int]$_.ngl -gt 0) { 0 } else { 1 } } },
    @{ Expression = { [int]$_.port } }
)

function Test-Listen($p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }
function Test-Health($url) { try { (Invoke-WebRequest "$url/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false } }

function Get-GpuFreeMb([string]$gpuId) {
  try {
    $rows = & nvidia-smi --query-gpu=index,memory.free --format=csv,noheader,nounits 2>$null
    if (-not $rows) { return $null }
    $parsed = @()
    foreach ($line in @($rows)) {
      $parts = ($line -split ",") | ForEach-Object { $_.Trim() }
      if ($parts.Count -ge 2) {
        $parsed += [PSCustomObject]@{ index = [int]$parts[0]; freeMb = [int]$parts[1] }
      }
    }
    if (-not $parsed.Count) { return $null }
    if ($gpuId -ne $null -and "$gpuId".Trim() -ne "") {
      $first = [int](("$gpuId" -split ",")[0])
      $t = $parsed | Where-Object { $_.index -eq $first } | Select-Object -First 1
      if ($t) { return [int]$t.freeMb }
      return $null
    }
    return [int](($parsed | Measure-Object -Property freeMb -Maximum).Maximum)
  } catch {
    return $null
  }
}

function Get-RequiredVramMb($s) {
  if ([int]$s.ngl -le 0) { return 0 }
  try {
    $env:VRAM_EST_JSON = ($s | ConvertTo-Json -Compress -Depth 5)
    Push-Location $root
    $out = & node --input-type=module -e "import { estimateVramMb } from './src/serverManager.js'; const d=JSON.parse(process.env.VRAM_EST_JSON); process.stdout.write(String(await estimateVramMb({ name:d.name, model:d.model, mmproj:d.mmproj, ngl:d.ngl, ctx:d.ctx, layers:d.layers, gpu:d.gpu })));" 2>$null
    Pop-Location
    Remove-Item Env:\VRAM_EST_JSON -ErrorAction SilentlyContinue
    if ($out -match '^\d+$') { return [int]$out }
  } catch {
    Pop-Location -ErrorAction SilentlyContinue
    Remove-Item Env:\VRAM_EST_JSON -ErrorAction SilentlyContinue
  }
  $model = Join-Path $root $s.model
  if (-not (Test-Path $model)) { return 0 }
  $bytes = (Get-Item $model).Length
  if ($s.mmproj) {
    $mm = Join-Path $root $s.mmproj
    if (Test-Path $mm) { $bytes += (Get-Item $mm).Length }
  }
  $ngl = [int]$s.ngl
  $frac = if ($ngl -ge 99) { 1.0 } else { [math]::Min(1.0, $ngl / 99.0) }
  return [int]([math]::Round(($bytes / 1MB) * $frac + 512))
}

# name → { error, at }
$statusMap = @{}
if (Test-Path $statusFile) {
  try {
    $raw = Get-Content $statusFile -Raw | ConvertFrom-Json
    $raw.PSObject.Properties | ForEach-Object {
      $statusMap[$_.Name] = @{
        error = [string]$_.Value.error
        at    = [string]$_.Value.at
      }
    }
  } catch {}
}

function Save-StatusMap {
  $obj = [ordered]@{}
  foreach ($k in ($statusMap.Keys | Sort-Object)) {
    $obj[$k] = @{ error = $statusMap[$k].error; at = $statusMap[$k].at }
  }
  ($obj | ConvertTo-Json -Depth 5) + "`n" | Set-Content -Path $statusFile -Encoding utf8
}

function Set-Fail($name, $msg) {
  $statusMap[$name] = @{ error = $msg; at = (Get-Date).ToUniversalTime().ToString("o") }
  Save-StatusMap
  Write-Host "[up] ✗ $name — $msg" -ForegroundColor Red
}

function Clear-Fail($name) {
  if ($statusMap.ContainsKey($name)) {
    $statusMap.Remove($name)
    Save-StatusMap
  }
}

function Wait-Health($s, $sec) {
  $url = "http://127.0.0.1:$($s.port)"
  $deadline = (Get-Date).AddSeconds($sec)
  do {
    if (Test-Health $url) { return $true }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  return $false
}

$backends = @()
$okNames = @()
$failNames = @()

Write-Host "[up] 기동 순서 (큰 모델 우선): $($servers.name -join ' → ')" -ForegroundColor Cyan

foreach ($s in $servers) {
  $url = "http://127.0.0.1:$($s.port)"
  $device = if ([int]$s.ngl -gt 0) { "gpu" } else { "cpu" }
  $backends += "$($s.tier)@$url@$device"
  $isGpu = [int]$s.ngl -gt 0

  if (Test-Listen $s.port) {
    Write-Host "[up] $($s.name) (:$($s.port)) 이미 실행 중 → 건너뜀" -ForegroundColor DarkGray
    Clear-Fail $s.name
    $okNames += $s.name
    continue
  }

  $model = Join-Path $root $s.model
  if (-not (Test-Path $model)) {
    Set-Fail $s.name "모델 파일 없음: $($s.model)"
    $failNames += $s.name
    continue
  }

  # GPU: VRAM 사전 점검 (큰 모델부터 올리므로 large 가 먼저 VRAM 선점)
  if ($isGpu) {
    $need = Get-RequiredVramMb $s
    $free = Get-GpuFreeMb $s.gpu
    if ($null -ne $free -and $need -gt 0 -and $free -lt $need) {
      $needGb = [math]::Round($need / 1024, 1)
      $freeGb = [math]::Round($free / 1024, 1)
      Set-Fail $s.name "GPU 메모리 부족: 약 ${needGb}GB 필요, 가용 ${freeGb}GB (큰 모델 우선 기동으로 VRAM 선점됨). ngl=0(CPU)으로 바꾸거나 다른 GPU 모델을 내리세요."
      $failNames += $s.name
      continue
    }
  }

  $args = @("-m", $model, "--host", "127.0.0.1", "--port", "$($s.port)", "-c", "$($s.ctx)", "-ngl", "$($s.ngl)")
  if ($s.mmproj) {
    $mmproj = Join-Path $root $s.mmproj
    if (Test-Path $mmproj) { $args += @("--mmproj", $mmproj) }
  }
  if ($s.gpu -ne $null -and $s.gpu -ne "") { $env:CUDA_VISIBLE_DEVICES = "$($s.gpu)" }

  $log = Join-Path $logDir "server-$($s.port).log"
  Write-Host "[up] $($s.name) [$($s.tier)/$device] → $url  (model=$($s.model))"
  try {
    Start-Process -FilePath $exe -ArgumentList $args -RedirectStandardOutput $log -RedirectStandardError "$log.err" -WindowStyle Hidden | Out-Null
  } catch {
    Set-Fail $s.name "프로세스 기동 실패: $($_.Exception.Message)"
    $failNames += $s.name
    Remove-Item Env:\CUDA_VISIBLE_DEVICES -ErrorAction SilentlyContinue
    continue
  }
  Remove-Item Env:\CUDA_VISIBLE_DEVICES -ErrorAction SilentlyContinue

  # GPU 는 VRAM 할당 후 다음으로 — CPU 는 짧게만 대기
  $wait = if ($isGpu) { $WaitSec } else { [Math]::Min(45, $WaitSec) }
  if (Wait-Health $s $wait) {
    Write-Host "[up] ✓ $($s.name) 헬스 OK" -ForegroundColor Green
    Clear-Fail $s.name
    $okNames += $s.name
  } else {
    $hint = "헬스 응답 없음 (최대 ${wait}s). 로그: $log.err"
    if ($isGpu) { $hint += " — GPU OOM 또는 모델 로딩 실패 가능" }
    Set-Fail $s.name $hint
    $failNames += $s.name
  }
}

Write-Host ""
Write-Host "[up] 성공 $($okNames.Count) / 실패 $($failNames.Count) (전체 $($servers.Count))" -ForegroundColor $(if ($failNames.Count) { "Yellow" } else { "Green" })
if ($failNames.Count -gt 0) {
  Write-Host "[up] 실패한 서버 (사유는 모니터·$statusFile 참고):" -ForegroundColor Yellow
  foreach ($n in $failNames) {
    Write-Host "     - $n : $($statusMap[$n].error)" -ForegroundColor Red
  }
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
Write-Host "     모델 관리   : http://localhost:$Port/models.html"
Write-Host "     서버 모니터 : http://localhost:$Port/monitor.html"
Write-Host "     종료        : npm run down"
