#!/usr/bin/env bash
set -euo pipefail

# Zleap CLI installer — downloads release app, installs wrappers, bootstraps serve + onboarding.
# Stage A: bash + curl (optional distribution.env from Release, no Node required for config)
# Stage B: bundled node runs bootstrap-cli.js

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ZLEAP_EMBEDDED_MANIFEST_PUBLIC_KEY_B64="LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUlJQm9qQU5CZ2txaGtpRzl3MEJBUUVGQUFPQ0FZOEFNSUlCaWdLQ0FZRUE1VWhzc0tjalhZYXM0NUpyRGtGOApQZHF6QnJjTEY3WEthdnNHZHE2Rmp1cWJNV09sQTIzOXk2NTFkb2ovbUgvVW1QejdZNDNSYnZrRFQ1cHJBWlNDCkRUeDBVUnZCRjdPa3BKMURGamJlSktaOWdOTzlVZWg0cFJsQWVPeG00VjBQcXZEMDFsQ3hZMUdVZlp0eGdHNzYKVDFqTGQxZ0pXOEE1UmtNUGpaaVNWdHJHTGI0cUFlTndsRFlRSS9VaG9JNzdEdVB0djdTYmZxUXF5ZmVmczFHYQpKcW91bzZxR1lZNHB3MHNXT2tTb3FLMTFobFNzZ1VPMW5CL29BUThsM3FMcjBxM0hNQURNdlR4OHRMT0pydmtsClN0MVRTenFhbGFBdWlrcDlNTmhidXBkNXZyUnZzSkFSY1B4T3BTakRqa0l1WE54ZEpQU3NNcFVHQURBdGJIa04KQXU5VnlBS1U1eWtRckV4S3JZSjF0NEVDdC9wdy9peVkxTkRvL09xS2hpRkExN1F6TkFWWnVmOFVYU0ZybEhBOQpqelFtMDQ1dVd6TVZlVU8rSzRFL2Fuakd6cEZHQ1pFNDFGcFBPVW9mN2F1VVR5TEthQ25TOUZLMC9NN0NXbGhKCjN6aXJzMDFYdENGVlJGbjZEa1RMZFpBVVdha0hEamIwbnBVUHdGaTZKYVFMQWdNQkFBRT0KLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tCg=="

detect_platform() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo "mac-arm64" ;;
    Darwin-x86_64) echo "mac-x64" ;;
    Linux-aarch64|Linux-arm64|Linux-x86_64)
      echo "Linux public install is not supported in the v1 release. Use macOS or Windows, or build from source." >&2
      exit 1
      ;;
    MINGW*|MSYS*|CYGWIN*) echo "win-x64" ;;
    *)
      echo "Unsupported platform: $(uname -s) $(uname -m)" >&2
      exit 1
      ;;
  esac
}

DETECTED_PLATFORM="$(detect_platform)"

json_to_env() {
  local json_file="$1"
  local platform="$2"
  if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
    local py="python3"
    command -v python3 >/dev/null 2>&1 || py="python"
    "$py" - "$json_file" "$platform" <<'PY'
import json
import sys

file, platform = sys.argv[1:3]
with open(file, 'r', encoding='utf-8') as fh:
    manifest = json.load(fh)
artifact = manifest.get('payload', {}).get('platforms', {}).get(platform)
if not artifact or not artifact.get('url'):
    raise SystemExit(f'No payload artifact for {platform}')
entries = {
    'ZLEAP_VERSION': manifest.get('payload', {}).get('version') or manifest.get('runtime', {}).get('version') or manifest.get('version'),
    'ZLEAP_RELEASE_CHANNEL': manifest.get('channel'),
    'ZLEAP_PAYLOAD_URL': artifact.get('url'),
    'ZLEAP_PAYLOAD_SHA256': artifact.get('sha256'),
}
for key, value in entries.items():
    if value is not None and str(value):
        print(f"{key}={json.dumps(str(value))}")
PY
    return $?
  fi
  if command -v jq >/dev/null 2>&1; then
    local artifact
    artifact="$(jq -r --arg platform "$platform" '.payload.platforms[$platform] // empty' "$json_file")"
    [ -n "$artifact" ] || return 1
    jq -r --arg platform "$platform" '
      {
        ZLEAP_VERSION: (.payload.version // .runtime.version // .version),
        ZLEAP_RELEASE_CHANNEL: .channel,
        ZLEAP_PAYLOAD_URL: .payload.platforms[$platform].url,
        ZLEAP_PAYLOAD_SHA256: .payload.platforms[$platform].sha256
      }
      | to_entries[]
      | select(.value != null and (.value | tostring | length > 0))
      | "\(.key)=\(.value | tostring | @json)"
    ' "$json_file"
    return $?
  fi
  return 1
}

json_field() {
  local json_file="$1"
  local field="$2"
  if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
    local py="python3"
    command -v python3 >/dev/null 2>&1 || py="python"
    "$py" - "$json_file" "$field" <<'PY'
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    value = json.load(fh)
for part in sys.argv[2].split('.'):
    value = value.get(part) if isinstance(value, dict) else None
    if value is None:
        break
if value is not None:
    print(value)
PY
    return $?
  fi
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg field "$field" '
      reduce ($field | split("."))[] as $part (.;
        if type == "object" then .[$part] else null end
      ) // empty
    ' "$json_file"
    return $?
  fi
  echo "JSON parsing requires python3 or jq during install." >&2
  return 1
}

source_env_file() {
  local env_file="$1"
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

b64_decode_file() {
  local input="$1"
  local output="$2"
  if base64 --decode "$input" >"$output" 2>/dev/null; then
    return 0
  fi
  base64 -D -i "$input" -o "$output"
}

write_public_key_file() {
  local public_key="$1"
  local output="$2"
  if printf '%s' "$public_key" | grep -q 'BEGIN PUBLIC KEY'; then
    printf '%b\n' "$public_key" >"$output"
    return 0
  fi
  printf '%s' "$public_key" >"$TMP/manifest-public.b64"
  b64_decode_file "$TMP/manifest-public.b64" "$output"
}

verify_manifest_signature() {
  local manifest_url="$1"
  local manifest_path="$2"
  local public_key="${ZLEAP_MANIFEST_PUBLIC_KEY:-}"
  local public_key_path="${ZLEAP_MANIFEST_PUBLIC_KEY_PATH:-}"
  if [ -z "$public_key" ] && [ -z "$public_key_path" ]; then
    public_key="$ZLEAP_EMBEDDED_MANIFEST_PUBLIC_KEY_B64"
  fi
  if [ -z "$public_key" ] && [ -z "$public_key_path" ]; then
    if [ "${ZLEAP_REQUIRE_MANIFEST_SIGNATURE:-1}" = "1" ]; then
      echo "Manifest signature is required but no public key is configured." >&2
      exit 1
    fi
    return 0
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "Manifest signature verification requires openssl in install.sh." >&2
    exit 1
  fi
  local sig_url="${ZLEAP_MANIFEST_SIGNATURE_URL:-${manifest_url}.sig}"
  if ! curl -fsSL "$sig_url" -o "$TMP/latest.json.sig" 2>/dev/null; then
    echo "Manifest signature unavailable: $sig_url" >&2
    exit 1
  fi
  b64_decode_file "$TMP/latest.json.sig" "$TMP/latest.json.sig.bin"
  local key_file="$public_key_path"
  if [ -z "$key_file" ]; then
    key_file="$TMP/manifest-public.pem"
    write_public_key_file "$public_key" "$key_file"
  fi
  if ! openssl dgst -sha256 -verify "$key_file" -signature "$TMP/latest.json.sig.bin" "$manifest_path" >/dev/null 2>&1; then
    echo "Manifest signature verification failed" >&2
    exit 1
  fi
}

load_release_manifest() {
  # The install contract lives in install-manifest.json (runtime + payload).
  # latest.json is the Tauri desktop updater manifest and is not used here.
  local manifest_url="${ZLEAP_INSTALL_MANIFEST_URL:-${ZLEAP_MANIFEST_URL:-}}"
  if [ -z "$manifest_url" ]; then
    local manifest_file="${ZLEAP_MANIFEST_FILE:-install-manifest.json}"
    local repo="${ZLEAP_GITHUB_REPO:-Zleap-AI/Zleap-Agent}"
    manifest_url="https://github.com/${repo}/releases/latest/download/${manifest_file}"
  fi
  if ! curl -fsSL "$manifest_url" -o "$TMP/install-manifest.json" 2>/dev/null; then
    return 1
  fi
  verify_manifest_signature "$manifest_url" "$TMP/install-manifest.json"
  if ! json_to_env "$TMP/install-manifest.json" "${ZLEAP_PLATFORM:-$DETECTED_PLATFORM}" >"$TMP/manifest.env"; then
    return 1
  fi
  source_env_file "$TMP/manifest.env"
  return 0
}

load_distribution_env() {
  if load_release_manifest; then
    return 0
  fi
  if [ -n "${ZLEAP_RELEASE_BASE:-}" ]; then
    if [ -z "${ZLEAP_VERSION:-}" ]; then
      local release_name="${ZLEAP_RELEASE_BASE##*/}"
      if [[ "$release_name" == v* ]]; then
        ZLEAP_VERSION="${release_name#v}"
        export ZLEAP_VERSION
      fi
    fi
    if [ -n "${ZLEAP_VERSION:-}" ]; then
      local env_name="distribution-${ZLEAP_VERSION#v}-${ZLEAP_PLATFORM:-$DETECTED_PLATFORM}.env"
      if curl -fsSL "${ZLEAP_RELEASE_BASE}/${env_name}" -o "$TMP/distribution.env" 2>/dev/null; then
        source_env_file "$TMP/distribution.env"
        return 0
      fi
    fi
    if curl -fsSL "${ZLEAP_RELEASE_BASE}/distribution.env" -o "$TMP/distribution.env" 2>/dev/null; then
      source_env_file "$TMP/distribution.env"
      return 0
    fi
  fi
  if command -v node >/dev/null 2>&1; then
    while IFS= read -r line; do
      eval "export $line"
    done < <(node "$SCRIPT_DIR/distribution.mjs" shell-env)
    return 0
  fi
  echo "需要 Node.js 或 Release 中的 distribution.env（设置 ZLEAP_RELEASE_BASE）" >&2
  exit 1
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$file" | awk '{print $1}'
    return 0
  fi
  return 1
}

verify_archive_checksum() {
  local file="$1"
  local url="$2"
  local expected="${ZLEAP_ARCHIVE_SHA256:-}"
  if [ "${ZLEAP_SKIP_CHECKSUM:-0}" = "1" ]; then
    echo "Skipping checksum verification because ZLEAP_SKIP_CHECKSUM=1"
    return 0
  fi
  if [ -z "$expected" ]; then
    if curl -fsSL "${url}.sha256" -o "$TMP/archive.sha256" 2>/dev/null; then
      expected="$(awk '{print $1}' "$TMP/archive.sha256")"
    fi
  fi
  if [ -z "$expected" ]; then
    echo "Missing sha256 for runtime archive. Set ZLEAP_SKIP_CHECKSUM=1 only for local development." >&2
    exit 1
  fi
  local actual
  if ! actual="$(sha256_file "$file")"; then
    echo "No sha256 tool found (sha256sum, shasum, or openssl)." >&2
    exit 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "Checksum mismatch for runtime archive" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

runtime_env_from_distribution() {
  local dist_file="$CURRENT/distribution.json"
  [ -f "$dist_file" ] || return 1
  "$node_bin" - "$dist_file" <<'NODE'
const fs = require('node:fs');
const dist = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const runtime = dist.runtime ?? {};
const entries = {
  ZLEAP_WEB_PORT: process.env.ZLEAP_WEB_PORT || runtime.webPort,
  ZLEAP_AUTH_MODE: process.env.ZLEAP_AUTH_MODE || runtime.authMode,
  ZLEAP_SERVE_MODE: process.env.ZLEAP_SERVE_MODE || runtime.serveMode,
  ZLEAP_GATEWAY: process.env.ZLEAP_GATEWAY || (runtime.gateway ? '1' : '0'),
};
for (const [key, value] of Object.entries(entries)) {
  if (value !== undefined && value !== null && String(value).length > 0) {
    console.log(`${key}=${JSON.stringify(String(value))}`);
  }
}
NODE
}

load_distribution_env

ZLEAP_HOME="${ZLEAP_HOME:-$HOME/.zleap}"
APP_ROOT="$ZLEAP_HOME/app"
CURRENT="$APP_ROOT/current"
PREVIOUS="$APP_ROOT/previous"
BIN_DIR="$ZLEAP_HOME/bin"
METADATA="$APP_ROOT/metadata.json"
PLATFORM="${ZLEAP_PLATFORM:-$DETECTED_PLATFORM}"
if [ -n "${ZLEAP_PAYLOAD_URL:-}" ]; then
  ARCHIVE_URL="$ZLEAP_PAYLOAD_URL"
elif [ -n "${ZLEAP_RELEASE_BASE:-}" ] && [ -n "${ZLEAP_PAYLOAD_ARCHIVE:-}" ]; then
  ARCHIVE_URL="${ZLEAP_RELEASE_BASE}/${ZLEAP_PAYLOAD_ARCHIVE}"
else
  echo "缺少 payload artifact URL。请设置 ZLEAP_UPDATER_MANIFEST_URL/ZLEAP_MANIFEST_URL，或提供 ZLEAP_RELEASE_BASE + ZLEAP_PAYLOAD_ARCHIVE。" >&2
  exit 1
fi
if [ -n "${ZLEAP_PAYLOAD_ARCHIVE:-}" ]; then
  ARCHIVE="$ZLEAP_PAYLOAD_ARCHIVE"
else
  ARCHIVE="${ARCHIVE_URL##*/}"
  ARCHIVE="${ARCHIVE%%\?*}"
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64|Darwin-x86_64|MINGW*|MSYS*|CYGWIN*) ;;
  Linux-*)
    echo "Linux public install is not supported in the v1 release. Use macOS or Windows, or build from source." >&2
    exit 1
    ;;
  *)
    echo "Unsupported platform: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

STAGING="$APP_ROOT/staging-${ZLEAP_VERSION:-unknown}"

mkdir -p "$APP_ROOT" "$BIN_DIR" "$ZLEAP_HOME/state" "$ZLEAP_HOME/logs"

echo "Downloading Zleap ${ZLEAP_VERSION:-unknown} (${PLATFORM})…"
curl -fsSL "$ARCHIVE_URL" -o "$TMP/payload.tar.gz"
ZLEAP_ARCHIVE_SHA256="${ZLEAP_PAYLOAD_SHA256:-}" verify_archive_checksum "$TMP/payload.tar.gz" "$ARCHIVE_URL"
tar -xzf "$TMP/payload.tar.gz" -C "$TMP"
PAYLOAD_DIR="$TMP/payload"

if [ ! -d "$PAYLOAD_DIR" ] || [ ! -f "$PAYLOAD_DIR/manifest.json" ] || [ ! -f "$PAYLOAD_DIR/SHA256SUMS" ]; then
  echo "Invalid payload archive: missing payload/manifest.json or payload/SHA256SUMS" >&2
  exit 1
fi

verify_payload_file() {
  local name="$1"
  local expected
  expected="$(awk -v file="$name" '$2 == file { print $1 }' "$PAYLOAD_DIR/SHA256SUMS" | head -1)"
  if [ -z "$expected" ]; then
    echo "Payload SHA256SUMS missing $name" >&2
    exit 1
  fi
  local actual
  actual="$(sha256_file "$PAYLOAD_DIR/$name")"
  if [ "$actual" != "$expected" ]; then
    echo "Payload checksum mismatch for $name" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

for payload_file in app.tar.gz node.tar.gz postgres.tar.gz manifest.json; do
  [ -f "$PAYLOAD_DIR/$payload_file" ] || { echo "Payload missing $payload_file" >&2; exit 1; }
  verify_payload_file "$payload_file"
done

node_version="$(json_field "$PAYLOAD_DIR/manifest.json" nodeVersion)"
if [ -z "$node_version" ]; then
  echo "Payload manifest missing nodeVersion" >&2
  exit 1
fi
NODE_ROOT="$ZLEAP_HOME/tools/node/$PLATFORM/$node_version"
PG_ROOT="$ZLEAP_HOME/tools/postgres/$PLATFORM"
mkdir -p "$(dirname "$NODE_ROOT")" "$(dirname "$PG_ROOT")"
rm -rf "$NODE_ROOT" "$PG_ROOT" "$TMP/node" "$TMP/postgres" "$TMP/app-extract"
mkdir -p "$TMP/node" "$TMP/postgres" "$TMP/app-extract"
tar -xzf "$PAYLOAD_DIR/node.tar.gz" -C "$TMP/node"
node_source="$(find "$TMP/node" -maxdepth 3 \( -path '*/bin/node' -o -path '*/node.exe' \) -print -quit)"
if [ -z "$node_source" ]; then
  echo "node.tar.gz did not contain a Node executable" >&2
  exit 1
fi
node_source_root="$(dirname "$(dirname "$node_source")")"
if [ "$(basename "$node_source")" = "node.exe" ]; then
  node_source_root="$(dirname "$node_source")"
fi
mv "$node_source_root" "$NODE_ROOT"

tar -xzf "$PAYLOAD_DIR/postgres.tar.gz" -C "$TMP/postgres"
pg_source="$(find "$TMP/postgres" -maxdepth 3 \( -name pg_ctl -o -name pg_ctl.exe \) -print -quit)"
if [ -z "$pg_source" ]; then
  echo "postgres.tar.gz did not contain pg_ctl" >&2
  exit 1
fi
pg_source_root="$(dirname "$(dirname "$pg_source")")"
mv "$pg_source_root" "$PG_ROOT"

tar -xzf "$PAYLOAD_DIR/app.tar.gz" -C "$TMP/app-extract"
if [ ! -d "$TMP/app-extract/app" ]; then
  echo "app.tar.gz did not contain app/" >&2
  exit 1
fi
rm -rf "$STAGING"
mkdir -p "$STAGING"
rsync -a "$TMP/app-extract/app/" "$STAGING/"
cp "$PAYLOAD_DIR/manifest.json" "$METADATA"

if [ -d "$CURRENT" ]; then
  rm -rf "$PREVIOUS"
  mv "$CURRENT" "$PREVIOUS"
fi
mv "$STAGING" "$CURRENT"

node_bin="$NODE_ROOT/bin/node"
[ -x "$node_bin" ] || node_bin="$NODE_ROOT/node.exe"
if [ ! -x "$node_bin" ]; then
  node_bin="$(command -v node || true)"
fi
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  echo "Node.js is required to bootstrap Zleap. Install Node.js or use Zleap Desktop." >&2
  exit 1
fi
pg_bin="$PG_ROOT/bin"
serve_cli="$CURRENT/runtime/node_modules/@zleap/host/dist/serve-cli.js"
cli_entry="$CURRENT/runtime/node_modules/@zleap-ai/cli/dist/index.js"
bootstrap_cli="$CURRENT/runtime/node_modules/@zleap/host/dist/bootstrap-cli.js"

if runtime_env_from_distribution >"$TMP/runtime.env"; then
  source_env_file "$TMP/runtime.env"
fi
if [ -z "${ZLEAP_WEB_PORT:-}" ]; then
  echo "Runtime distribution.json missing runtime.webPort" >&2
  exit 1
fi

write_wrapper() {
  local name="$1"
  local target="$2"
  shift 2
  local extra=""
  if [ "$#" -gt 0 ]; then
    extra="$* "
  fi
  cat >"$BIN_DIR/$name" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export ZLEAP_HOME="$ZLEAP_HOME"
export ZLEAP_APP_ROOT="$CURRENT"
export ZLEAP_RUNTIME_ROOT="$APP_ROOT"
export ZLEAP_REPO_ROOT="$CURRENT"
export ZLEAP_NODE_BIN="$node_bin"
if [ -d "$pg_bin" ]; then
  export ZLEAP_BUNDLED_PG_BIN="$pg_bin"
fi
export ZLEAP_SERVE_MODE="${ZLEAP_SERVE_MODE}"
export ZLEAP_SKIP_BUILD=1
export ZLEAP_AUTH_MODE="${ZLEAP_AUTH_MODE}"
export ZLEAP_GATEWAY="${ZLEAP_GATEWAY}"
export ZLEAP_WEB_PORT="${ZLEAP_WEB_PORT}"
export PATH="$(dirname "$node_bin"):\$PATH"
exec "$node_bin" "$target" ${extra}"\$@"
EOF
  chmod +x "$BIN_DIR/$name"
}

write_wrapper zleap "$cli_entry"
write_wrapper zleap-serve "$serve_cli"
write_wrapper zleap-update "$cli_entry" update
write_wrapper zleap-upgrade "$cli_entry" update

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    SHELL_RC="$HOME/.zshrc"
    [ -f "$HOME/.bashrc" ] && SHELL_RC="$HOME/.bashrc"
    echo "" >>"$SHELL_RC"
    echo "# Zleap CLI" >>"$SHELL_RC"
    echo "export PATH=\"$BIN_DIR:\$PATH\"" >>"$SHELL_RC"
    echo "Added $BIN_DIR to PATH in $SHELL_RC"
    ;;
esac

echo ""
echo "Running post-install bootstrap…"
export ZLEAP_HOME ZLEAP_VERSION="$ZLEAP_VERSION" ZLEAP_PLATFORM="$PLATFORM"
"$node_bin" "$bootstrap_cli" || {
  echo "Bootstrap 未完成，请手动运行: zleap setup" >&2
}

echo ""
echo "Zleap installed."
echo "  zleap doctor"
echo "  zleap setup"
echo "  open ${ZLEAP_ONBOARDING_URL:-http://127.0.0.1:${ZLEAP_WEB_PORT}/onboarding}"
