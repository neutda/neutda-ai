<#
  llama.cpp 의 llama-server 를 Qwen 비전 모델 + mmproj 로 실행한다.

  사용 예:
    # llama-server.exe 가 PATH 에 있을 때
    .\scripts\run-llama-server.ps1

    # 직접 경로 지정
    .\scripts\run-llama-server.ps1 -LlamaServer "C:\tools\llama\llama-server.exe" -Ngl 99

  llama-server 바이너리는 https://github.com/ggml-org/llama.cpp/releases 에서
  Windows 용 prebuilt zip(예: llama-*-bin-win-vulkan-x64.zip / -cuda- / -cpu-)을 받아 압축 해제하면 됩니다.
#>
[CmdletBinding()]
param(
  [string]$LlamaServer = "",
  [string]$Model       = "",
  [string]$Mmproj      = "",
  [string]$BindHost    = "127.0.0.1",
  [int]$Port           = 8080,
  [int]$Ctx            = 8192,
  [int]$Ngl            = 99
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot/init-console.ps1"

# npm 등으로 실행 시 $PSScriptRoot 가 비어있는 경우가 있어 견고하게 스크립트 경로를 구한다.
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$projectRoot = Split-Path -Parent $scriptDir

if (-not $Model)  { $Model  = Join-Path $projectRoot "models\Qwen3.6-27B-Q4_K_M.gguf" }
if (-not $Mmproj) { $Mmproj = Join-Path $projectRoot "models\mmproj-Qwen3.6-27B-BF16.gguf" }
if (-not $LlamaServer) {
  $bundled = Join-Path $projectRoot "llama\llama-server.exe"
  $LlamaServer = if (Test-Path $bundled) { $bundled } else { "llama-server" }
}

if (-not (Test-Path $Model)) { throw "모델 파일을 찾을 수 없습니다: $Model" }
if (-not (Test-Path $Mmproj)) { throw "mmproj 파일을 찾을 수 없습니다: $Mmproj" }

Write-Host "[llama-server] model : $Model"
Write-Host "[llama-server] mmproj: $Mmproj"
Write-Host "[llama-server] http://${BindHost}:${Port}  (ctx=$Ctx, ngl=$Ngl)"

& $LlamaServer `
  -m $Model `
  --mmproj $Mmproj `
  --host $BindHost `
  --port $Port `
  -c $Ctx `
  -ngl $Ngl
