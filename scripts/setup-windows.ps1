param(
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Set-Location (Split-Path -Parent $PSScriptRoot)
$PnpmVersion = if ($env:PNPM_VERSION) { $env:PNPM_VERSION } else { "9.15.0" }

function Has($Command) {
  return [bool](Get-Command $Command -ErrorAction SilentlyContinue)
}

function Refresh-Path {
  $extra = @(
    "$env:ProgramFiles\nodejs",
    "$env:ProgramFiles\Docker\Docker\resources\bin",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links",
    "$env:APPDATA\npm"
  )
  $env:Path = ($env:Path + ";" + ($extra -join ";"))
}

function Node-Ok {
  if (-not (Has "node")) { return $false }
  $major = node -p "Number(process.versions.node.split('.')[0])"
  return [int]$major -ge 20
}

function Ensure-Winget {
  if (-not (Has "winget")) {
    throw "winget is required. Install App Installer from Microsoft Store, then rerun this script."
  }
}

function Ensure-Node {
  if (Node-Ok) { return }
  Ensure-Winget
  winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
  Refresh-Path
  if (-not (Node-Ok)) {
    throw "Node.js was installed, but this PowerShell session cannot find it yet. Open a new PowerShell window and rerun this script."
  }
}

function Ensure-Pnpm {
  if (Has "pnpm") { return }
  if (Has "corepack") {
    corepack enable
    corepack prepare "pnpm@$PnpmVersion" --activate
  }
  Refresh-Path
  if (-not (Has "pnpm")) {
    npm install -g "pnpm@$PnpmVersion"
  }
  Refresh-Path
  if (-not (Has "pnpm")) {
    throw "Failed to install pnpm. Open a new PowerShell window and rerun this script."
  }
}

function Docker-Ready {
  try {
    docker compose version *> $null
    docker info *> $null
    return $true
  } catch {
    return $false
  }
}

function Wait-Docker {
  for ($i = 0; $i -lt 80; $i++) {
    if (Docker-Ready) { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}

function Ensure-Docker {
  Refresh-Path
  if (Docker-Ready) { return }
  Ensure-Winget
  if (-not (Has "docker")) {
    winget install --id Docker.DockerDesktop -e --source winget --accept-package-agreements --accept-source-agreements
    Refresh-Path
  }
  $dockerDesktop = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
  if (Test-Path $dockerDesktop) {
    Start-Process $dockerDesktop
  }
  if (-not (Wait-Docker)) {
    throw "Docker Desktop is installed but not running yet. Open Docker Desktop, finish its first-run setup, then rerun this script."
  }
}

Ensure-Node
Ensure-Pnpm
pnpm install

if (-not $env:ZLEAP_DATABASE_URL -and -not $env:DATABASE_URL) {
  Ensure-Docker
  docker compose up -d postgres
}

if (-not $NoStart) {
  pnpm dev:web
  exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Setup complete."
Write-Host "Start WebUI with:"
Write-Host "  pnpm dev:web"
Write-Host ""
Write-Host "Default local database:"
Write-Host "  ZLEAP_DATABASE_URL=postgres://zleap:zleap@127.0.0.1:5433/zleap"
