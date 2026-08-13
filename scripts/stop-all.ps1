<#
  start-all 로 띄운 Express(node) + agent + 모든 llama-server 를 종료한다.
  사용: npm run down
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [int]$AgentPort = 0
)

$ErrorActionPreference = "SilentlyContinue"
. "$PSScriptRoot/init-console.ps1"

# serve / agent / solo 먼저 종료 (llama 는 아래에서)
& "$PSScriptRoot/stop-serve-agent.ps1" -Port $Port -AgentPort $AgentPort

# 모든 llama-server 종료
$llm = Get-Process llama-server -ErrorAction SilentlyContinue
if ($llm) {
  $llm | ForEach-Object { Stop-Process -Id $_.Id -Force; Write-Host "[down] llama-server 종료 PID=$($_.Id)" }
} else {
  Write-Host "[down] 실행 중인 llama-server 없음"
}

Write-Host "[down] 완료"
