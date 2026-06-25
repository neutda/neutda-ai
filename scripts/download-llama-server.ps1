<#
  llama.cpp 의 Windows 용 llama-server prebuilt 바이너리를 다운로드해 ./llama 에 설치한다.
  GPU(NVIDIA) 가 있으면 CUDA 빌드 + CUDA 런타임(cudart) 을 함께 받는다.

  사용 예:
    .\scripts\download-llama-server.ps1                 # 최신 + CUDA 12.4
    .\scripts\download-llama-server.ps1 -Cuda 13.3      # CUDA 13.3
    .\scripts\download-llama-server.ps1 -Tag b9467      # 특정 빌드 고정
#>
[CmdletBinding()]
param(
  [string]$Tag  = "latest",
  [string]$Cuda = "12.4",
  [string]$Dest = "$PSScriptRoot\..\llama"
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot/init-console.ps1"
$ProgressPreference = "SilentlyContinue"   # 다운로드 속도 향상
$headers = @{ "User-Agent" = "neutda-ai" }
$repo = "ggml-org/llama.cpp"

if ($Tag -eq "latest") {
  $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
} else {
  $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/tags/$Tag" -Headers $headers
}
$Tag = $rel.tag_name
Write-Host "[download] llama.cpp tag: $Tag (CUDA $Cuda)"

$wanted = @(
  "llama-$Tag-bin-win-cuda-$Cuda-x64.zip",
  "cudart-llama-bin-win-cuda-$Cuda-x64.zip"
)

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$tmp = Join-Path $env:TEMP "llama-dl"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

foreach ($name in $wanted) {
  $asset = $rel.assets | Where-Object { $_.name -eq $name }
  if (-not $asset) { throw "릴리스 자산을 찾을 수 없습니다: $name" }
  $zip = Join-Path $tmp $name
  Write-Host "[download] $name ($([math]::Round($asset.size/1MB,1)) MB) ..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -Headers $headers
  Write-Host "[extract ] -> $Dest"
  Expand-Archive -Path $zip -DestinationPath $Dest -Force
}

$exe = Join-Path $Dest "llama-server.exe"
if (Test-Path $exe) {
  Write-Host "[done] llama-server: $exe" -ForegroundColor Green
} else {
  $found = Get-ChildItem -Path $Dest -Recurse -Filter "llama-server.exe" | Select-Object -First 1
  if ($found) { Write-Host "[done] llama-server: $($found.FullName)" -ForegroundColor Green }
  else { throw "llama-server.exe 를 찾지 못했습니다. 압축 내용을 확인하세요: $Dest" }
}
