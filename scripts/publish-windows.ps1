#Requires -Version 7.0
# Build a self-contained Windows deployment folder for BeeDocs.Host.
#
# Output layout (dist/windows/ by default):
#   BeeDocs.Host.exe          supervisor (run this with NSSM or as a Windows service)
#   appsettings.json          ports, MCP token, paths
#   api/                      published BeeDocs.Api + wwwroot
#   mcp/                      built MCP server + production node_modules
#   data/                     created at runtime (SurrealDB + uploads)
#   logs/                     child-process logs (api.log, mcp.log)
#
# Prerequisites on the build machine: .NET 10 SDK, Node 20+, pnpm (or npx).
# Prerequisites on the server: .NET 10 runtime, Node 20+ on PATH.
#
# Usage:
#   .\scripts\publish-windows.ps1
#   .\scripts\publish-windows.ps1 -OutputDir C:\deploy\beedocs -SelfContained
#   .\scripts\publish-windows.ps1 -SkipZip
#   $env:NO_BUMP = '1'; .\scripts\publish-windows.ps1   # rebuild without bumping
#   .\scripts\publish-windows.ps1 -NoBump
#   .\scripts\publish-windows.ps1 -Sign
#   .\scripts\publish-windows.ps1 -Sign -CertificatePath .\scripts\CodeCertificates\code.pfx
#   .\scripts\publish-windows.ps1 -UiPathBase /beedocs -ApiPathBase /beedocs-api -McpPathBase /beedocs-mcp
#
# Signing (-Sign) uses scripts/CodeCertificates/signtool.exe. Put a .pfx in that
# folder (or pass -CertificatePath). Password: -CertificatePassword or
# $env:SIGN_CERT_PASSWORD.
#
# Path bases are the *public* ReverseProxy prefixes (strip_prefix). The backend
# still listens at root; only the web build needs them so the browser hits
# /beedocs/... which the proxy strips to /...

[CmdletBinding()]
param(
    [string]$OutputDir = '',
    [string]$Runtime = 'win-x64',
    [switch]$SelfContained,
    [switch]$SkipZip,
    [switch]$NoBump,
    [switch]$Sign,
    [string]$CertificatePath = '',
    [string]$CertificatePassword = '',
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [string]$UiPathBase = '',
    [string]$ApiPathBase = '',
    [string]$McpPathBase = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$OutRoot = if ($OutputDir) { $OutputDir } else { Join-Path $Root 'dist' 'windows' }
$ApiOut = Join-Path $OutRoot 'api'
$McpOut = Join-Path $OutRoot 'mcp'
$WebDir = Join-Path $Root 'src' 'beedocs-web'
$McpDir = Join-Path $Root 'src' 'beedocs-mcp'
$ApiProj = Join-Path $Root 'src' 'BeeDocs.Api' 'BeeDocs.Api.csproj'
$HostProj = Join-Path $Root 'src' 'BeeDocs.Host' 'BeeDocs.Host.csproj'
$Csproj = $ApiProj

function Write-Step($msg) { Write-Host "[publish] $msg" }

function Get-AppVersion {
    $line = Select-String -Path $Csproj -Pattern '<Version>' | Select-Object -First 1
    if (-not $line) {
        throw "Could not parse <Version> from $Csproj"
    }

    if ($line.Line -notmatch '<Version>([^<]+)</Version>') {
        throw "Could not parse <Version> from $Csproj"
    }

    return $Matches[1].Trim()
}

function Set-AppVersion([string]$version) {
    $current = Get-AppVersion
    $escaped = [regex]::Escape($current)
    $matchPattern = "<Version>$escaped</Version>"
    $replacement = "<Version>$version</Version>"
    $replaced = $false

    $lines = Get-Content -Path $Csproj | ForEach-Object {
        if (-not $replaced -and $_ -match $matchPattern) {
            $replaced = $true
            $_ -replace $matchPattern, $replacement
        } else {
            $_
        }
    }

    if (-not $replaced) {
        throw "Version bump failed (expected to replace $matchPattern in $Csproj)"
    }

    Set-Content -Path $Csproj -Value $lines
    if ((Get-AppVersion) -ne $version) {
        throw "Version bump failed (file now says '$(Get-AppVersion)', expected '$version')"
    }
}

function Bump-BuildNumber {
    param([string]$CurrentVersion)

    if ($NoBump -or $env:NO_BUMP -eq '1') {
        Write-Step "NO_BUMP set, keeping version $CurrentVersion"
        return $CurrentVersion
    }

    if ($CurrentVersion -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
        throw "Version '$CurrentVersion' must be MAJOR.MINOR.BUILD (all numeric). Fix $Csproj or pass -NoBump."
    }

    $next = "$($Matches[1]).$($Matches[2]).$([int]$Matches[3] + 1)"
    Set-AppVersion $next
    Write-Step "Build number bumped: $CurrentVersion -> $next"
    return $next
}

function Normalize-PathBase([string]$value) {
    if ([string]::IsNullOrWhiteSpace($value) -or $value.Trim() -eq '/') {
        return ''
    }
    $path = $value.Trim()
    if (-not $path.StartsWith('/')) {
        $path = "/$path"
    }
    return $path.TrimEnd('/')
}

function Set-HostPathBases([string]$settingsPath, [string]$uiBase, [string]$apiBase, [string]$mcpBase) {
    if (-not (Test-Path -LiteralPath $settingsPath)) {
        throw "Host appsettings not found at $settingsPath"
    }

    $json = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    if (-not $json.BeeDocsHost) {
        throw "BeeDocsHost section missing in $settingsPath"
    }

    $json.BeeDocsHost | Add-Member -NotePropertyName UiPathBase -NotePropertyValue $uiBase -Force
    $json.BeeDocsHost | Add-Member -NotePropertyName ApiPathBase -NotePropertyValue $apiBase -Force
    $json.BeeDocsHost | Add-Member -NotePropertyName McpPathBase -NotePropertyValue $mcpBase -Force
    $json | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $settingsPath
}

function Invoke-Pnpm($dir, [string[]]$extraArgs) {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        $pnpm = 'pnpm'
    } elseif (Get-Command npx -ErrorAction SilentlyContinue) {
        $pnpm = 'npx --yes pnpm@9.15.9'
    } else {
        throw 'pnpm (or npx) is required to build the web app and MCP server.'
    }

    $cmd = "$pnpm $($extraArgs -join ' ')"
    Push-Location $dir
    try {
        & cmd /c $cmd
        if ($LASTEXITCODE -ne 0) { throw "Command failed: $cmd" }
    } finally {
        Pop-Location
    }
}

function Resolve-SignCertificate {
    if ($CertificatePath) {
        if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
            throw "Certificate not found: $CertificatePath"
        }
        return (Resolve-Path -LiteralPath $CertificatePath).Path
    }

    $certDir = Join-Path $PSScriptRoot 'CodeCertificates'
    $pfx = Get-ChildItem -Path $certDir -Filter '*.pfx' -File -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $pfx) {
        throw "No .pfx found in $certDir. Pass -CertificatePath or place a code-signing certificate there."
    }
    return $pfx.FullName
}

function Invoke-SignExe([string]$exePath) {
    $signTool = Join-Path $PSScriptRoot 'CodeCertificates' 'signtool.exe'
    if (-not (Test-Path -LiteralPath $signTool -PathType Leaf)) {
        throw "signtool.exe not found at $signTool"
    }

    $cert = Resolve-SignCertificate
    $password = if ($CertificatePassword) { $CertificatePassword } else { $env:SIGN_CERT_PASSWORD }

    Write-Step "Signing $exePath"
    $args = [System.Collections.Generic.List[string]]::new()
    $args.AddRange([string[]]@('sign', '/f', $cert))
    if ($password) {
        $args.AddRange([string[]]@('/p', $password))
    }
    $args.AddRange([string[]]@('/fd', 'sha256', '/td', 'sha256', '/tr', $TimestampUrl, '/v', $exePath))

    & $signTool @($args.ToArray())
    if ($LASTEXITCODE -ne 0) {
        throw "signtool failed for $exePath (exit $LASTEXITCODE)"
    }
}

function Invoke-SignPublishOutput {
    $targets = @(
        (Join-Path $OutRoot 'BeeDocs.Host.exe'),
        (Join-Path $ApiOut 'BeeDocs.Api.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }

    if (-not $targets) {
        throw "Nothing to sign — expected BeeDocs.Host.exe and/or BeeDocs.Api.exe under $OutRoot"
    }

    foreach ($exe in $targets) {
        Invoke-SignExe $exe
    }
}

$AppVersion = Bump-BuildNumber (Get-AppVersion)
$ResolvedUiPathBase = Normalize-PathBase $UiPathBase
$ResolvedApiPathBase = Normalize-PathBase $ApiPathBase
if (-not $ResolvedApiPathBase) { $ResolvedApiPathBase = $ResolvedUiPathBase }
$ResolvedMcpPathBase = Normalize-PathBase $McpPathBase
Write-Step "Building BeeDocs $AppVersion"
if ($ResolvedUiPathBase) { Write-Step "UI path base: $ResolvedUiPathBase" }
if ($ResolvedApiPathBase) { Write-Step "API path base: $ResolvedApiPathBase" }
if ($ResolvedMcpPathBase) { Write-Step "MCP path base: $ResolvedMcpPathBase" }

Write-Step "Cleaning $OutRoot"
if (Test-Path $OutRoot) {
    Remove-Item -LiteralPath $OutRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $ApiOut, $McpOut | Out-Null

Write-Step 'Building web UI'
if (-not (Test-Path (Join-Path $WebDir 'node_modules'))) {
    Invoke-Pnpm $WebDir @('install')
}
$env:BEEDOCS_UI_PATH_BASE = $ResolvedUiPathBase
$env:VITE_BEEDOCS_API_PATH_BASE = $ResolvedApiPathBase
try {
    Invoke-Pnpm $WebDir @('build')
} finally {
    Remove-Item Env:BEEDOCS_UI_PATH_BASE -ErrorAction SilentlyContinue
    Remove-Item Env:VITE_BEEDOCS_API_PATH_BASE -ErrorAction SilentlyContinue
}

Write-Step 'Publishing API'
$publishArgs = @(
    'publish', $ApiProj,
    '-c', 'Release',
    '-o', $ApiOut,
    '--runtime', $Runtime
)
if ($SelfContained) {
    $publishArgs += @('--self-contained', 'true')
} else {
    $publishArgs += @('--self-contained', 'false')
}
& dotnet @publishArgs

$wwwroot = Join-Path $ApiOut 'wwwroot'
New-Item -ItemType Directory -Force -Path $wwwroot | Out-Null
Copy-Item -Path (Join-Path $WebDir 'dist' '*') -Destination $wwwroot -Recurse -Force

Write-Step 'Building MCP server'
if (-not (Test-Path (Join-Path $McpDir 'node_modules'))) {
    Invoke-Pnpm $McpDir @('install')
}
Invoke-Pnpm $McpDir @('build')

Write-Step 'Packaging MCP runtime'
Copy-Item -Path (Join-Path $McpDir 'package.json') -Destination $McpOut
Copy-Item -Path (Join-Path $McpDir 'pnpm-lock.yaml') -Destination $McpOut -ErrorAction SilentlyContinue
Copy-Item -Path (Join-Path $McpDir 'dist') -Destination (Join-Path $McpOut 'dist') -Recurse -Force
Invoke-Pnpm $McpOut @('install', '--prod', '--frozen-lockfile')

Write-Step 'Publishing host supervisor'
$hostPublishArgs = @(
    'publish', $HostProj,
    '-c', 'Release',
    '-o', $OutRoot,
    '--runtime', $Runtime
)
if ($SelfContained) {
    $hostPublishArgs += @('--self-contained', 'true')
} else {
    $hostPublishArgs += @('--self-contained', 'false')
}
& dotnet @hostPublishArgs

Set-HostPathBases (Join-Path $OutRoot 'appsettings.json') $ResolvedUiPathBase $ResolvedApiPathBase $ResolvedMcpPathBase

if ($Sign) {
    Invoke-SignPublishOutput
}

if (-not $SkipZip) {
    $distDir = Split-Path $OutRoot -Parent
    $zipPath = Join-Path $distDir "beedocs-$AppVersion-$Runtime.zip"
    Write-Step "Creating $zipPath"
    if (Test-Path $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }
    Compress-Archive -Path (Join-Path $OutRoot '*') -DestinationPath $zipPath -CompressionLevel Optimal
}

Write-Step "Done. BeeDocs $AppVersion"
Write-Step "Deploy folder: $OutRoot"
if (-not $SkipZip) {
    Write-Step "Deploy archive: $zipPath"
}
Write-Host ''
Write-Host "Version $AppVersion is written to src/BeeDocs.Api/BeeDocs.Api.csproj — commit it after deploying."
Write-Host 'Next steps on the Windows server:'
Write-Host "  1. Copy the folder to the server (e.g. C:\BeeDocs)"
Write-Host '  2. Edit appsettings.json — set BeeDocsHost:McpAuthToken'
Write-Host '  3. Install with NSSM:'
Write-Host "       nssm install BeeDocs C:\BeeDocs\BeeDocs.Host.exe"
Write-Host "       nssm set BeeDocs AppDirectory C:\BeeDocs"
Write-Host "       nssm set BeeDocs AppStdout C:\BeeDocs\logs\host.log"
Write-Host "       nssm set BeeDocs AppStderr C:\BeeDocs\logs\host.err.log"
Write-Host '       nssm start BeeDocs'
Write-Host ''
Write-Host 'Or register as a native Windows service (Host calls AddWindowsService):'
Write-Host '       sc create BeeDocs binPath= "C:\BeeDocs\BeeDocs.Host.exe" start= auto'
Write-Host '       sc start BeeDocs'
