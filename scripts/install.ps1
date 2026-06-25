# Zleap CLI installer for Windows (PowerShell)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Tmp = Join-Path $env:TEMP ("zleap-install-" + [guid]::NewGuid().ToString())
$EmbeddedManifestPublicKey = "LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUlJQm9qQU5CZ2txaGtpRzl3MEJBUUVGQUFPQ0FZOEFNSUlCaWdLQ0FZRUE1VWhzc0tjalhZYXM0NUpyRGtGOApQZHF6QnJjTEY3WEthdnNHZHE2Rmp1cWJNV09sQTIzOXk2NTFkb2ovbUgvVW1QejdZNDNSYnZrRFQ1cHJBWlNDCkRUeDBVUnZCRjdPa3BKMURGamJlSktaOWdOTzlVZWg0cFJsQWVPeG00VjBQcXZEMDFsQ3hZMUdVZlp0eGdHNzYKVDFqTGQxZ0pXOEE1UmtNUGpaaVNWdHJHTGI0cUFlTndsRFlRSS9VaG9JNzdEdVB0djdTYmZxUXF5ZmVmczFHYQpKcW91bzZxR1lZNHB3MHNXT2tTb3FLMTFobFNzZ1VPMW5CL29BUThsM3FMcjBxM0hNQURNdlR4OHRMT0pydmtsClN0MVRTenFhbGFBdWlrcDlNTmhidXBkNXZyUnZzSkFSY1B4T3BTakRqa0l1WE54ZEpQU3NNcFVHQURBdGJIa04KQXU5VnlBS1U1eWtRckV4S3JZSjF0NEVDdC9wdy9peVkxTkRvL09xS2hpRkExN1F6TkFWWnVmOFVYU0ZybEhBOQpqelFtMDQ1dVd6TVZlVU8rSzRFL2Fuakd6cEZHQ1pFNDFGcFBPVW9mN2F1VVR5TEthQ25TOUZLMC9NN0NXbGhKCjN6aXJzMDFYdENGVlJGbjZEa1RMZFpBVVdha0hEamIwbnBVUHdGaTZKYVFMQWdNQkFBRT0KLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tCg=="

function Import-EnvLines($Path) {
  Get-Content $Path | ForEach-Object {
    if ($_ -match '^([^=]+)=(.+)$') {
      $name = $matches[1]
      $value = $matches[2] | ConvertFrom-Json
      Set-Item -Path "env:$name" -Value $value
    }
  }
}

function Import-ReleaseManifest {
  # The install contract lives in install-manifest.json (runtime + payload).
  # latest.json is the Tauri desktop updater manifest and is not used here.
  $manifestUrl = if ($env:ZLEAP_INSTALL_MANIFEST_URL) {
    $env:ZLEAP_INSTALL_MANIFEST_URL
  } elseif ($env:ZLEAP_MANIFEST_URL) {
    $env:ZLEAP_MANIFEST_URL
  } else {
    $manifestFile = if ($env:ZLEAP_MANIFEST_FILE) { $env:ZLEAP_MANIFEST_FILE } else { "install-manifest.json" }
    $repo = if ($env:ZLEAP_GITHUB_REPO) { $env:ZLEAP_GITHUB_REPO } else { "Zleap-AI/Zleap-Agent" }
    "https://github.com/$repo/releases/latest/download/$manifestFile"
  }
  $manifestPath = Join-Path $Tmp "install-manifest.json"
  try {
    Invoke-WebRequest -Uri $manifestUrl -OutFile $manifestPath
  } catch {
    return $false
  }
  Verify-ManifestSignature $manifestUrl $manifestPath
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  $platform = if ($env:ZLEAP_PLATFORM) { $env:ZLEAP_PLATFORM } else { "win-x64" }
  $artifact = $null
  if ($manifest.payload -and $manifest.payload.platforms -and $manifest.payload.platforms.PSObject.Properties[$platform]) {
    $artifact = $manifest.payload.platforms.PSObject.Properties[$platform].Value
  }
  if (-not $artifact -or -not $artifact.url) {
    return $false
  }
  $env:ZLEAP_VERSION = if ($manifest.payload.version) { $manifest.payload.version } elseif ($manifest.runtime.version) { $manifest.runtime.version } else { $manifest.version }
  $env:ZLEAP_RELEASE_CHANNEL = $manifest.channel
  $env:ZLEAP_PAYLOAD_URL = $artifact.url
  if ($artifact.sha256) {
    $env:ZLEAP_PAYLOAD_SHA256 = $artifact.sha256
  }
  return $true
}

function Verify-ManifestSignature($ManifestUrl, $ManifestPath) {
  if (-not $env:ZLEAP_MANIFEST_PUBLIC_KEY -and -not $env:ZLEAP_MANIFEST_PUBLIC_KEY_PATH) {
    $env:ZLEAP_MANIFEST_PUBLIC_KEY = $EmbeddedManifestPublicKey
  }
  if (-not $env:ZLEAP_MANIFEST_PUBLIC_KEY -and -not $env:ZLEAP_MANIFEST_PUBLIC_KEY_PATH) {
    if ($env:ZLEAP_REQUIRE_MANIFEST_SIGNATURE -ne "0") {
      throw "Manifest signature is required but no public key is configured."
    }
    return
  }
  $sigUrl = if ($env:ZLEAP_MANIFEST_SIGNATURE_URL) { $env:ZLEAP_MANIFEST_SIGNATURE_URL } else { "$ManifestUrl.sig" }
  $sigPath = Join-Path $Tmp "latest.json.sig"
  Invoke-WebRequest -Uri $sigUrl -OutFile $sigPath
  $keyText = if ($env:ZLEAP_MANIFEST_PUBLIC_KEY_PATH) {
    Get-Content $env:ZLEAP_MANIFEST_PUBLIC_KEY_PATH -Raw
  } else {
    Decode-PublicKeyText $env:ZLEAP_MANIFEST_PUBLIC_KEY
  }
  $rsa = [System.Security.Cryptography.RSA]::Create()
  try {
    $rsa.ImportFromPem($keyText.ToCharArray())
    $raw = [System.IO.File]::ReadAllBytes($ManifestPath)
    $sigText = (Get-Content $sigPath -Raw).Trim()
    $sig = [Convert]::FromBase64String($sigText)
    $ok = $rsa.VerifyData(
      $raw,
      $sig,
      [System.Security.Cryptography.HashAlgorithmName]::SHA256,
      [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    if (-not $ok) {
      throw "Manifest signature verification failed"
    }
  } finally {
    $rsa.Dispose()
  }
}

function Decode-PublicKeyText($Value) {
  if ($Value -match "BEGIN PUBLIC KEY") {
    return $Value.Replace("\n", "`n")
  }
  $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
  if ($decoded -notmatch "BEGIN PUBLIC KEY") {
    throw "Manifest public key must be PEM or base64 PEM"
  }
  return $decoded
}

function Import-DistributionEnv {
  if (Import-ReleaseManifest) {
    return
  }
  if ($env:ZLEAP_RELEASE_BASE) {
    $envFile = Join-Path $Tmp "distribution.env"
    try {
      Invoke-WebRequest -Uri "$($env:ZLEAP_RELEASE_BASE)/distribution.env" -OutFile $envFile
      Import-EnvLines $envFile
      return
    } catch {
      # fall through
    }
  }
  $lines = & node "$ScriptDir\distribution.mjs" shell-env
  foreach ($line in $lines) {
    if ($line -match '^([^=]+)=(.+)$') {
      $name = $matches[1]
      $value = $matches[2] | ConvertFrom-Json
      Set-Item -Path "env:$name" -Value $value
    }
  }
}

function Verify-ArchiveChecksum($Path, $Url) {
  if ($env:ZLEAP_SKIP_CHECKSUM -eq "1") {
    Write-Host "Skipping checksum verification because ZLEAP_SKIP_CHECKSUM=1"
    return
  }
  $expected = $env:ZLEAP_ARCHIVE_SHA256
  if (-not $expected) {
    $shaPath = Join-Path $Tmp "archive.sha256"
    try {
      Invoke-WebRequest -Uri "$Url.sha256" -OutFile $shaPath
      $expected = ((Get-Content $shaPath -Raw).Trim() -split '\s+')[0]
    } catch {
      # handled below
    }
  }
  if (-not $expected) {
    throw "Missing sha256 for runtime archive. Set ZLEAP_SKIP_CHECKSUM=1 only for local development."
  }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
  if ($actual -ne $expected.ToLowerInvariant()) {
    throw "Checksum mismatch for runtime archive. Expected $expected, got $actual."
  }
}

New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
Import-DistributionEnv

$ZleapVersion = if ($env:ZLEAP_VERSION) { $env:ZLEAP_VERSION } else { & node "$ScriptDir\distribution.mjs" version }
$ZleapHome = if ($env:ZLEAP_HOME) { $env:ZLEAP_HOME } else { Join-Path $env:USERPROFILE ".zleap" }
$AppRoot = Join-Path $ZleapHome "app"
$Current = Join-Path $AppRoot "current"
$Previous = Join-Path $AppRoot "previous"
$BinDir = Join-Path $ZleapHome "bin"
$Metadata = Join-Path $AppRoot "metadata.json"
$Platform = if ($env:ZLEAP_PLATFORM) { $env:ZLEAP_PLATFORM } else { "win-x64" }
if ($env:ZLEAP_PAYLOAD_URL) {
  $ArchiveUrl = $env:ZLEAP_PAYLOAD_URL
} elseif ($env:ZLEAP_RELEASE_BASE -and $env:ZLEAP_PAYLOAD_ARCHIVE) {
  $ArchiveUrl = "$($env:ZLEAP_RELEASE_BASE)/$($env:ZLEAP_PAYLOAD_ARCHIVE)"
} else {
  throw "Missing payload artifact URL. Set ZLEAP_UPDATER_MANIFEST_URL/ZLEAP_MANIFEST_URL or ZLEAP_RELEASE_BASE + ZLEAP_PAYLOAD_ARCHIVE."
}
$ArchiveUri = [uri]$ArchiveUrl
$Archive = if ($env:ZLEAP_PAYLOAD_ARCHIVE) { $env:ZLEAP_PAYLOAD_ARCHIVE } else { Split-Path -Leaf $ArchiveUri.AbsolutePath }
$Staging = Join-Path $AppRoot "staging-$ZleapVersion"

New-Item -ItemType Directory -Force -Path $AppRoot, $BinDir, (Join-Path $ZleapHome "state"), (Join-Path $ZleapHome "logs") | Out-Null

Write-Host "Downloading Zleap $ZleapVersion ($Platform)…"
$PayloadArchive = Join-Path $Tmp $Archive
Invoke-WebRequest -Uri $ArchiveUrl -OutFile $PayloadArchive
$previousSha = $env:ZLEAP_ARCHIVE_SHA256
$env:ZLEAP_ARCHIVE_SHA256 = $env:ZLEAP_PAYLOAD_SHA256
Verify-ArchiveChecksum $PayloadArchive $ArchiveUrl
if ($previousSha) { $env:ZLEAP_ARCHIVE_SHA256 = $previousSha } else { Remove-Item Env:\ZLEAP_ARCHIVE_SHA256 -ErrorAction SilentlyContinue }
tar -xzf $PayloadArchive -C $Tmp
$PayloadDir = Join-Path $Tmp "payload"
if (-not (Test-Path (Join-Path $PayloadDir "manifest.json")) -or -not (Test-Path (Join-Path $PayloadDir "SHA256SUMS"))) {
  throw "Invalid payload archive: missing payload/manifest.json or payload/SHA256SUMS"
}

function Verify-PayloadFile($Name) {
  $file = Join-Path $PayloadDir $Name
  if (-not (Test-Path $file)) { throw "Payload missing $Name" }
  $line = Get-Content (Join-Path $PayloadDir "SHA256SUMS") | Where-Object { ($_ -split '\s+')[1] -eq $Name } | Select-Object -First 1
  if (-not $line) { throw "Payload SHA256SUMS missing $Name" }
  $expected = ($line.Trim() -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Payload checksum mismatch for $Name. Expected $expected, got $actual." }
}

@("app.tar.gz", "node.tar.gz", "postgres.tar.gz", "manifest.json") | ForEach-Object { Verify-PayloadFile $_ }
$PayloadManifest = Get-Content (Join-Path $PayloadDir "manifest.json") -Raw | ConvertFrom-Json
if (-not $PayloadManifest.nodeVersion) { throw "Payload manifest missing nodeVersion" }
$NodeRoot = Join-Path $ZleapHome "tools\node\$Platform\$($PayloadManifest.nodeVersion)"
$PgRoot = Join-Path $ZleapHome "tools\postgres\$Platform"
Remove-Item -Recurse -Force $NodeRoot, $PgRoot -ErrorAction SilentlyContinue
$NodeTmp = Join-Path $Tmp "node"
$PgTmp = Join-Path $Tmp "postgres"
$AppTmp = Join-Path $Tmp "app-extract"
New-Item -ItemType Directory -Force -Path $NodeTmp, $PgTmp, $AppTmp, (Split-Path -Parent $NodeRoot), (Split-Path -Parent $PgRoot) | Out-Null
tar -xzf (Join-Path $PayloadDir "node.tar.gz") -C $NodeTmp
$nodeExe = Get-ChildItem -Path $NodeTmp -Recurse -File -Filter node.exe | Select-Object -First 1
if (-not $nodeExe) { throw "node.tar.gz did not contain node.exe" }
Move-Item -Path $nodeExe.DirectoryName -Destination $NodeRoot
tar -xzf (Join-Path $PayloadDir "postgres.tar.gz") -C $PgTmp
$pgCtl = Get-ChildItem -Path $PgTmp -Recurse -File -Filter pg_ctl.exe | Select-Object -First 1
if (-not $pgCtl) { throw "postgres.tar.gz did not contain pg_ctl.exe" }
Move-Item -Path (Split-Path -Parent $pgCtl.DirectoryName) -Destination $PgRoot
tar -xzf (Join-Path $PayloadDir "app.tar.gz") -C $AppTmp
if (-not (Test-Path (Join-Path $AppTmp "app"))) { throw "app.tar.gz did not contain app/" }

if (Test-Path $Staging) { Remove-Item -Recurse -Force $Staging }
New-Item -ItemType Directory -Force -Path $Staging | Out-Null
Copy-Item -Path (Join-Path $AppTmp "app\*") -Destination $Staging -Recurse -Force
Copy-Item -Path (Join-Path $PayloadDir "manifest.json") -Destination $Metadata -Force

if (Test-Path $Current) {
  if (Test-Path $Previous) { Remove-Item -Recurse -Force $Previous }
  Move-Item -Path $Current -Destination $Previous
}
Move-Item -Path $Staging -Destination $Current

$NodeBin = Join-Path $NodeRoot "node.exe"
$PgBin = Join-Path $PgRoot "bin"
$ServeCli = Join-Path $Current "runtime\node_modules\@zleap\host\dist\serve-cli.js"
$CliEntry = Join-Path $Current "runtime\node_modules\@zleap-ai\cli\dist\index.js"
$BootstrapCli = Join-Path $Current "runtime\node_modules\@zleap\host\dist\bootstrap-cli.js"
if (-not (Test-Path $NodeBin)) {
  $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($NodeCommand) { $NodeBin = $NodeCommand.Source }
}
if (-not (Test-Path $NodeBin)) { throw "Node.js is required to bootstrap Zleap. Install Node.js or use Zleap Desktop." }
$RuntimeDist = Join-Path $Current "distribution.json"
if (Test-Path $RuntimeDist) {
  $runtimeConfig = (Get-Content $RuntimeDist -Raw | ConvertFrom-Json).runtime
  if (-not $env:ZLEAP_WEB_PORT -and $runtimeConfig.webPort) { $env:ZLEAP_WEB_PORT = [string]$runtimeConfig.webPort }
  if (-not $env:ZLEAP_SERVE_MODE -and $runtimeConfig.serveMode) { $env:ZLEAP_SERVE_MODE = [string]$runtimeConfig.serveMode }
  if (-not $env:ZLEAP_AUTH_MODE -and $runtimeConfig.authMode) { $env:ZLEAP_AUTH_MODE = [string]$runtimeConfig.authMode }
  if (-not $env:ZLEAP_GATEWAY) { $env:ZLEAP_GATEWAY = if ($runtimeConfig.gateway) { "1" } else { "0" } }
}
if (-not $env:ZLEAP_WEB_PORT) { throw "Runtime distribution.json missing runtime.webPort" }
if (-not $env:ZLEAP_SERVE_MODE) { throw "Runtime distribution.json missing runtime.serveMode" }
if (-not $env:ZLEAP_AUTH_MODE) { throw "Runtime distribution.json missing runtime.authMode" }
if ($null -eq $env:ZLEAP_GATEWAY -or $env:ZLEAP_GATEWAY -eq "") { throw "Runtime distribution.json missing runtime.gateway" }
$WebPort = $env:ZLEAP_WEB_PORT
$ServeMode = $env:ZLEAP_SERVE_MODE
$AuthMode = $env:ZLEAP_AUTH_MODE
$Gateway = $env:ZLEAP_GATEWAY
$OnboardingUrl = if ($env:ZLEAP_ONBOARDING_URL) { $env:ZLEAP_ONBOARDING_URL } else { "http://127.0.0.1:$WebPort/onboarding" }

function Write-Wrapper($Name, $Target, [string[]]$ExtraArgs = @()) {
  $Path = Join-Path $BinDir "$Name.cmd"
  $Extra = if ($ExtraArgs.Count -gt 0) { ($ExtraArgs -join ' ') + ' ' } else { '' }
  @"
@echo off
set ZLEAP_HOME=$ZleapHome
set ZLEAP_APP_ROOT=$Current
set ZLEAP_RUNTIME_ROOT=$AppRoot
set ZLEAP_REPO_ROOT=$Current
set ZLEAP_NODE_BIN=$NodeBin
if exist "$PgBin" set ZLEAP_BUNDLED_PG_BIN=$PgBin
set ZLEAP_SERVE_MODE=$ServeMode
set ZLEAP_SKIP_BUILD=1
set ZLEAP_AUTH_MODE=$AuthMode
set ZLEAP_GATEWAY=$Gateway
set ZLEAP_WEB_PORT=$WebPort
set PATH=$([System.IO.Path]::GetDirectoryName($NodeBin));%PATH%
"$NodeBin" "$Target" $Extra%*
"@ | Set-Content -Encoding ASCII $Path
}

Write-Wrapper "zleap" $CliEntry
Write-Wrapper "zleap-serve" $ServeCli
Write-Wrapper "zleap-update" $CliEntry @("update")
Write-Wrapper "zleap-upgrade" $CliEntry @("update")

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$BinDir;$UserPath", "User")
  Write-Host "Added $BinDir to user PATH (restart terminal)."
}

Write-Host ""
Write-Host "Running post-install bootstrap…"
$env:ZLEAP_HOME = $ZleapHome
$env:ZLEAP_VERSION = $ZleapVersion
$env:ZLEAP_PLATFORM = $Platform
& $NodeBin $BootstrapCli

Write-Host ""
Write-Host "Zleap $ZleapVersion installed."
Write-Host "  zleap doctor"
Write-Host "  zleap setup"
Write-Host "  start $OnboardingUrl"

Remove-Item -Recurse -Force $Tmp
