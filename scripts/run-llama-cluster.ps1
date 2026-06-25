<#
  여러 개의 llama-server 인스턴스를 연속 포트로 띄운다 (로드밸런싱용 백엔드 풀).

  사용 예:
    # 8080,8081 두 개 (GPU 0,1 에 각각)
    .\scripts\run-llama-cluster.ps1 -Count 2 -Gpus "0,1"

    # 8080 하나 (단일 GPU 기본)
    .\scripts\run-llama-cluster.ps1 -Count 1

  ※ VRAM 주의: 27B-Q4 한 인스턴스가 약 16GB 를 씁니다.
     RTX 3090(24GB) 한 장에는 보통 1개만 올라갑니다. 여러 개를 띄우려면
     서로 다른 GPU(-Gpus) 또는 여러 머신에 분산하세요. CPU 인스턴스는 -Ngl 0 으로 추가 가능(느림).
#>
[CmdletBinding()]
param(
  [int]$Count       = 1,
  [int]$BasePort    = 8080,
  [string]$BindHost = "127.0.0.1",
  [int]$Ctx         = 8192,
  [int]$Ngl         = 99,
  [string]$Gpus     = "",   # 예: "0,1" → 인스턴스별 CUDA_VISIBLE_DEVICES 매핑
  [string]$LlamaServer = "",
  [switch]$Force            # 단일 GPU에 여러 개 강제로 띄울 때
)

$ErrorActionPreference = "Stop"

# 안전장치: 여러 인스턴스를 GPU 분산(-Gpus) 없이 띄우면 VRAM 초과로 시스템이 마비됩니다.
$distinctGpus = if ($Gpus) { ($Gpus.Split(",") | ForEach-Object { $_.Trim() } | Select-Object -Unique).Count } else { 0 }
if ($Count -gt 1 -and $distinctGpus -lt $Count -and -not $Force) {
  Write-Host "[cluster] 중단: 인스턴스 $Count 개를 띄우려는데 지정된 서로 다른 GPU 는 $distinctGpus 개뿐입니다." -ForegroundColor Red
  Write-Host "          27B-Q4 한 개가 약 16GB VRAM 을 씁니다. 단일 GPU(24GB)에 2개를 올리면" -ForegroundColor Red
  Write-Host "          나머지가 시스템 RAM/CPU 로 오프로드되어 RAM 이 가득 차고 매우 느려집니다." -ForegroundColor Red
  Write-Host ""
  Write-Host "  해결: GPU 별로 분산   →  .\scripts\run-llama-cluster.ps1 -Count 2 -Gpus `"0,1`"" -ForegroundColor Yellow
  Write-Host "        단일 인스턴스    →  npm run llama" -ForegroundColor Yellow
  Write-Host "        그래도 강행      →  -Force (권장하지 않음, CPU 오프로드로 매우 느림)" -ForegroundColor Yellow
  exit 1
}
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$projectRoot = Split-Path -Parent $scriptDir

$model  = Join-Path $projectRoot "models\Qwen3.6-27B-Q4_K_M.gguf"
$mmproj = Join-Path $projectRoot "models\mmproj-Qwen3.6-27B-BF16.gguf"
$logDir = Join-Path $projectRoot "llama\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not $LlamaServer) {
  $bundled = Join-Path $projectRoot "llama\llama-server.exe"
  $LlamaServer = if (Test-Path $bundled) { $bundled } else { "llama-server" }
}
if (-not (Test-Path $model))  { throw "모델 파일을 찾을 수 없습니다: $model" }
if (-not (Test-Path $mmproj)) { throw "mmproj 파일을 찾을 수 없습니다: $mmproj" }

$gpuList = if ($Gpus) { $Gpus.Split(",") } else { @() }
$urls = @()

for ($i = 0; $i -lt $Count; $i++) {
  $port = $BasePort + $i
  $log  = Join-Path $logDir "server-$port.log"

  if ($gpuList.Count -gt 0) {
    $env:CUDA_VISIBLE_DEVICES = $gpuList[$i % $gpuList.Count].Trim()
  }

  $args = @("-m", $model, "--mmproj", $mmproj, "--host", $BindHost, "--port", "$port", "-c", "$Ctx", "-ngl", "$Ngl")
  Write-Host "[cluster] start: http://${BindHost}:${port}  (gpu=$($env:CUDA_VISIBLE_DEVICES), log=$log)"
  Start-Process -FilePath $LlamaServer -ArgumentList $args -RedirectStandardOutput $log -RedirectStandardError "$log.err" -WindowStyle Hidden | Out-Null

  $urls += "http://${BindHost}:${port}"
}

Remove-Item Env:\CUDA_VISIBLE_DEVICES -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "[cluster] $Count 개 인스턴스를 시작했습니다. (로딩에 인스턴스당 30초~1분)" -ForegroundColor Green
Write-Host "[cluster] .env 에 아래 줄을 넣으세요:" -ForegroundColor Yellow
Write-Host ("LLAMA_SERVERS=" + ($urls -join ","))
Write-Host ""
Write-Host "[cluster] 로그: $logDir\server-<port>.log"
Write-Host "[cluster] 종료: Get-Process llama-server | Stop-Process -Force"
