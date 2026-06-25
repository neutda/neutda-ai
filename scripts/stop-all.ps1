<#
  start-all 로 띄운 Express(node) + 모든 llama-server 를 종료한다.
  사용: npm run down
#>
[CmdletBinding()]
param([int]$Port = 3000)

$ErrorActionPreference = "SilentlyContinue"
. "$PSScriptRoot/init-console.ps1"

# Express(해당 포트 점유 node) 종료
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { $p = Get-Process -Id $_; Stop-Process -Id $_ -Force; Write-Host "[down] Express 종료 PID=$_ ($($p.ProcessName))" }

# 모든 llama-server 종료
$llm = Get-Process llama-server
if ($llm) {
  $llm | ForEach-Object { Stop-Process -Id $_.Id -Force; Write-Host "[down] llama-server 종료 PID=$($_.Id)" }
} else {
  Write-Host "[down] 실행 중인 llama-server 없음"
}

Write-Host "[down] 완료"
