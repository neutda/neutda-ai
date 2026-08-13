<#
  백그라운드(또는 포그라운드)에서 돌아가는 serve / agent / solo 를 종료한다.
  llama-server 는 건드리지 않는다 (모델은 npm run down).

  사용: npm run stop
  옵션:
    -Port       Express(serve/solo) 포트 (기본 3000, .env PORT)
    -AgentPort  agent 포트 (기본 4100, .env AGENT_PORT)
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [int]$AgentPort = 0
)

$ErrorActionPreference = "SilentlyContinue"
. "$PSScriptRoot/init-console.ps1"

$root = Split-Path $PSScriptRoot -Parent

# .env 에서 PORT / AGENT_PORT 읽기 (인자 미지정 시)
function Read-EnvNum([string]$key, [int]$fallback) {
    $file = Join-Path $root ".env"
    if (-not (Test-Path $file)) { return $fallback }
    $line = Get-Content $file | Where-Object { $_ -match "^\s*$key\s*=" } | Select-Object -First 1
    if (-not $line) { return $fallback }
    $raw = ($line -split "=", 2)[1].Trim().Trim('"').Trim("'")
    $n = 0
    if ([int]::TryParse($raw, [ref]$n) -and $n -gt 0) { return $n }
    return $fallback
}

if ($Port -le 0) { $Port = Read-EnvNum "PORT" 3000 }
if ($AgentPort -le 0) { $AgentPort = Read-EnvNum "AGENT_PORT" 4100 }

$stopped = [System.Collections.Generic.HashSet[int]]::new()

function Stop-Pid([int]$procId, [string]$why) {
    if ($procId -le 0 -or $stopped.Contains($procId)) { return }
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return }
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    [void]$stopped.Add($procId)
    Write-Host "[stop] 종료 PID=$procId ($($p.ProcessName)) — $why"
}

# 1) 커맨드라인으로 serve / agent / solo 식별
$pattern = 'src[\\/]+(server|agent|solo)\.js'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match $pattern) } |
    ForEach-Object {
        $kind = if ($_.CommandLine -match 'solo\.js') { "solo" }
                elseif ($_.CommandLine -match 'agent\.js') { "agent" }
                else { "serve" }
        Stop-Pid $_.ProcessId $kind
    }

# 2) 포트 점유 프로세스 폴백 (커맨드라인 조회 실패·다른 진입점 대비)
foreach ($pair in @(
    @{ Port = $Port; Label = "serve/solo :$Port" },
    @{ Port = $AgentPort; Label = "agent :$AgentPort" }
)) {
    Get-NetTCPConnection -LocalPort $pair.Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object {
            $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
            if ($p -and $p.ProcessName -match '^(node|nodejs)$') {
                Stop-Pid $_ $pair.Label
            }
        }
}

if ($stopped.Count -eq 0) {
    Write-Host "[stop] 실행 중인 serve/agent/solo 없음"
} else {
    Write-Host "[stop] 완료 ($($stopped.Count)개 프로세스)"
}
