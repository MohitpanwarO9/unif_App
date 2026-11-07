$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$ServerRoot = Join-Path $ProjectRoot 'apps\server'
$WebRoot = Join-Path $ProjectRoot 'apps\web'

function Invoke-Npm {
    param([string]$WorkingDirectory, [string[]]$Arguments)
    Push-Location $WorkingDirectory
    try {
        Write-Host "> npm $($Arguments -join ' ')" -ForegroundColor Cyan
        & npm @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
    throw 'Node.js and npm are required. Install Node.js 22 LTS or newer, then reopen PowerShell.'
}

Write-Host "Node: $(& node --version)" -ForegroundColor Green
Write-Host 'Installing backend dependencies...' -ForegroundColor Cyan
Invoke-Npm $ServerRoot @('ci', '--no-audit', '--no-fund')
Invoke-Npm $ServerRoot @('run', 'db:generate')
Invoke-Npm $ServerRoot @('run', 'build')

Write-Host 'Installing frontend dependencies...' -ForegroundColor Cyan
Invoke-Npm $WebRoot @('ci', '--no-audit', '--no-fund')
Invoke-Npm $WebRoot @('run', 'build')

Write-Host ''
Write-Host 'Starting Unified Cloud Manager (Tauri development app)...' -ForegroundColor Green
Push-Location $WebRoot
try {
    & npx tauri dev
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri exited with code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
