#Requires -Version 5.1
# BeeDocs local dev: API (:5080) + web (:5200) + MCP over HTTP (:5090).
#
# Set $env:SKIP_MCP="1" to run just the API and web. Agents using the stdio MCP
# transport do not need this process — it is only the HTTP transport.
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$ApiDir = Join-Path $Root 'src' 'BeeDocs.Api'
$WebDir = Join-Path $Root 'src' 'beedocs-web'
$McpDir = Join-Path $Root 'src' 'BeeDocs.Mcp'
$LogDir = Join-Path $PSScriptRoot '.logs'

$ApiPort = if ($env:API_PORT) { $env:API_PORT } else { '5080' }
$WebPort = if ($env:WEB_PORT) { $env:WEB_PORT } else { '5200' }
$McpPort = if ($env:MCP_PORT) { $env:MCP_PORT } else { '5090' }
$ApiUrl = "http://localhost:$ApiPort"
$WebUrl = "http://localhost:$WebPort"
$McpUrl = "http://localhost:$McpPort"
$McpAuthToken = if ($env:MCP_AUTH_TOKEN) { $env:MCP_AUTH_TOKEN } else { '' }
$SkipMcp = ($env:SKIP_MCP -eq '1')

$ApiProc = $null
$WebProc = $null
$McpProc = $null

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log($msg) { Write-Host "[BeeDocs] $msg" }
function Write-Err($msg) { Write-Warning $msg }

function Get-ListeningPids($port) {
    return (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
}

function Stop-ByPort($port) {
    foreach ($processId in (Get-ListeningPids $port)) {
        Write-Log "Stopping process on :$port (PID $processId)"
        $null = & taskkill /T /F /PID $processId 2>&1
    }
}

function Stop-Existing {
    Write-Log "Stopping any services already running on :$ApiPort / :$WebPort / :$McpPort"
    $ports = @($ApiPort, $WebPort, $McpPort)
    foreach ($p in $ports) { Stop-ByPort $p }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt 10) {
        $inUse = $ports | Where-Object { (Get-ListeningPids $_) }
        if (-not $inUse) {
            Write-Log "Ports are free."
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Could not free API/web/MCP ports."
}

function Test-Command($name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $name"
    }
}

function Setup-Node {
    Test-Command node
    $ver = node -v
    $major = [int]($ver -replace '^v' -split '\.' | Select-Object -First 1)
    if ($major -lt 20) {
        throw "Node.js 20+ required (found $ver). Install Node 22 for best results."
    }
    Write-Log "Using Node $ver"

    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        & corepack enable 2>&1 | Out-Null
        & corepack prepare pnpm@9.15.9 --activate 2>&1 | Out-Null
    }

    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        $script:PnpmCmd = 'pnpm'
    } elseif (Get-Command npx -ErrorAction SilentlyContinue) {
        $script:PnpmCmd = 'npx --yes pnpm@9.15.9'
    } else {
        throw "pnpm (or npx) not found. Install pnpm or Node with corepack."
    }
}

function Invoke-Pnpm($dir, $extraArgs) {
    # Run through cmd so the npx.cmd shim is used. Calling npx.ps1 directly with
    # variable arguments breaks because that shim re-evaluates the original
    # command line in its own scope.
    $cmd = "$script:PnpmCmd $($extraArgs -join ' ')"
    Push-Location $dir
    try {
        & cmd /c $cmd
        if ($LASTEXITCODE -ne 0) { throw "Command failed (exit $LASTEXITCODE): $cmd" }
    } finally {
        Pop-Location
    }
}

function Wait-Http($url, $name, $tries = 60) {
    for ($i = 1; $i -le $tries; $i++) {
        try {
            $null = Invoke-RestMethod -Uri $url -TimeoutSec 2 -ErrorAction Stop
            return
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    throw "$name did not become ready at $url"
}

function Show-LogTail($path) {
    if (Test-Path $path) {
        Get-Content -Path $path -Tail 40
    }
}

function Start-DotNetApi {
    $env:ASPNETCORE_ENVIRONMENT = 'Development'
    $env:ASPNETCORE_URLS = "http://localhost:$ApiPort"
    $log = Join-Path $LogDir 'api.log'
    $cmd = "dotnet run --no-launch-profile > `"$log`" 2>&1"
    return Start-Process -FilePath 'cmd' -ArgumentList '/c', $cmd -WorkingDirectory $ApiDir -PassThru -WindowStyle Hidden
}

function Start-WebApp {
    $log = Join-Path $LogDir 'web.log'
    $cmd = "$script:PnpmCmd exec vite --host 127.0.0.1 --port $WebPort > `"$log`" 2>&1"
    return Start-Process -FilePath 'cmd' -ArgumentList '/c', $cmd -WorkingDirectory $WebDir -PassThru -WindowStyle Hidden
}

function Start-McpHttp {
    $env:MCP_TRANSPORT = 'http'
    $env:MCP_HTTP_PORT = $McpPort
    $env:MCP_AUTH_TOKEN = $McpAuthToken
    $env:BEEDOCS_API_URL = $ApiUrl
    $log = Join-Path $LogDir 'mcp.log'
    $cmd = "dotnet run --no-launch-profile > `"$log`" 2>&1"
    return Start-Process -FilePath 'cmd' -ArgumentList '/c', $cmd -WorkingDirectory $McpDir -PassThru -WindowStyle Hidden
}

function Stop-All {
    $procs = @($ApiProc, $WebProc, $McpProc) | Where-Object { $_ }
    foreach ($p in $procs) {
        if (-not $p.HasExited) {
            $null = & taskkill /T /F /PID $p.Id 2>&1
        }
    }
    foreach ($p in @($ApiPort, $WebPort, $McpPort)) { Stop-ByPort $p }
    Write-Log "Stopped."
}

# --- main ---

try {
    Test-Command dotnet
    Setup-Node
    Stop-Existing

    if (-not (Test-Path (Join-Path $WebDir 'node_modules') -PathType Container)) {
        Write-Log "Installing web dependencies..."
        Invoke-Pnpm $WebDir @('install')
    }

    Write-Log "Starting API on $ApiUrl ..."
    $ApiProc = Start-DotNetApi
    Wait-Http "$ApiUrl/api/health" 'API'

    Write-Log "Starting web on $WebUrl ..."
    $WebProc = Start-WebApp
    # Vite binds to 127.0.0.1; on Windows "localhost" may resolve to ::1, which
    # Invoke-RestMethod does not fall back from. Health-check the IPv4 address.
    Wait-Http "http://127.0.0.1:$WebPort" 'Web'

    $logs = @((Join-Path $LogDir 'api.log'), (Join-Path $LogDir 'web.log'))

    if (-not $SkipMcp) {
        Write-Log "Starting MCP (http) on $McpUrl/mcp ..."
        $McpProc = Start-McpHttp
        Wait-Http "http://127.0.0.1:$McpPort/healthz" 'MCP' 40
        $logs += (Join-Path $LogDir 'mcp.log')
    }

    Write-Log "BeeDocs is ready"
    Write-Log "  UI:  $WebUrl"
    Write-Log "  API: $ApiUrl  (health: $ApiUrl/api/health)"
    if (-not $SkipMcp) {
        if ($McpAuthToken) {
            Write-Log "  MCP: $McpUrl/mcp  (bearer: $McpAuthToken)"
        } else {
            Write-Log "  MCP: $McpUrl/mcp  (auth disabled; set MCP_AUTH_TOKEN to require a bearer token)"
        }
    }
    Write-Log "  Logs: $logs"
    Write-Log "Press Ctrl+C to stop everything."

    while ($true) {
        if ($ApiProc.HasExited) { throw "API exited unexpectedly." }
        if ($WebProc.HasExited) { throw "Web exited unexpectedly." }
        if ((-not $SkipMcp) -and $McpProc.HasExited) { throw "MCP exited unexpectedly." }
        Start-Sleep -Seconds 1
    }
} catch {
    Write-Err $_.Exception.Message
    if ($ApiProc -and $ApiProc.HasExited) { Show-LogTail (Join-Path $LogDir 'api.log') }
    if ($WebProc -and $WebProc.HasExited) { Show-LogTail (Join-Path $LogDir 'web.log') }
    if ($McpProc -and $McpProc.HasExited) { Show-LogTail (Join-Path $LogDir 'mcp.log') }
    throw
} finally {
    Stop-All
}
