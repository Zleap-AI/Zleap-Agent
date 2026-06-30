#!/usr/bin/env bash
set -euo pipefail

# Smoke test the curl installer against a local manifest + full payload archive.
# It verifies manifest-driven URL resolution, checksum validation, and wrapper env generation.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d /tmp/zleap-install-smoke.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

APP="$TMP/release/app"
mkdir -p \
  "$APP/runtime/node_modules/@zleap/host/dist" \
  "$APP/runtime/node_modules/@zleap-ai/cli/dist" \
  "$APP/runtime/node_modules/@zleap/store/dist" \
  "$APP/runtime/node_modules/@zleap/tasks/dist" \
  "$APP/runtime/node_modules/@zleap/gateway/dist" \
  "$APP/web/packages/web"

printf '%s\n' '#!/usr/bin/env node' 'process.exit(0)' >"$APP/runtime/node_modules/@zleap/host/dist/bootstrap-cli.js"
printf '%s\n' '#!/usr/bin/env node' 'process.exit(0)' >"$APP/runtime/node_modules/@zleap/host/dist/serve-cli.js"
printf '%s\n' '#!/usr/bin/env node' 'process.exit(0)' >"$APP/runtime/node_modules/@zleap/host/dist/desktop-bootstrap-cli.js"
printf '%s\n' '#!/usr/bin/env node' 'process.exit(0)' >"$APP/runtime/node_modules/@zleap/host/dist/control-cli.js"
printf '%s\n' '#!/usr/bin/env node' 'process.exit(0)' >"$APP/runtime/node_modules/@zleap-ai/cli/dist/index.js"
printf '%s\n' 'export {};' >"$APP/runtime/node_modules/@zleap/store/dist/migrate.js"
printf '%s\n' 'export {};' >"$APP/runtime/node_modules/@zleap/tasks/dist/worker.js"
printf '%s\n' 'export {};' >"$APP/runtime/node_modules/@zleap/gateway/dist/worker.js"
printf '%s\n' 'module.exports = {};' >"$APP/web/packages/web/server.js"
printf '%s\n' '{"runtime":{"webPort":4789,"authMode":"localhost","serveMode":"production","gateway":false}}' >"$APP/distribution.json"
printf '%s\n' '{"version":"9.9.9","platform":"mac-arm64","builtAt":"2026-01-01T00:00:00.000Z","nodeVersion":"22.22.3","postgresVersion":"17.5","pgvectorVersion":"0.8.0","features":{"node":true,"postgres":true,"web":true,"tasks":true,"gateway":true,"cli":true}}' >"$APP/manifest.json"

mkdir -p "$TMP/node/node-v22.22.3-darwin-arm64/bin" "$TMP/postgres/postgres/bin" "$TMP/payload/payload"
ln -s "$(command -v node)" "$TMP/node/node-v22.22.3-darwin-arm64/bin/node"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$TMP/postgres/postgres/bin/pg_ctl"
chmod +x "$TMP/postgres/postgres/bin/pg_ctl"

(cd "$TMP/release" && tar -czf "$TMP/payload/payload/app.tar.gz" app)
(cd "$TMP/node" && tar -czf "$TMP/payload/payload/node.tar.gz" node-v22.22.3-darwin-arm64)
(cd "$TMP/postgres" && tar -czf "$TMP/payload/payload/postgres.tar.gz" postgres)
cp "$APP/manifest.json" "$TMP/payload/payload/manifest.json"
(cd "$TMP/payload/payload" && shasum -a 256 app.tar.gz node.tar.gz postgres.tar.gz manifest.json >SHA256SUMS)
(cd "$TMP/payload" && tar -czf "$TMP/zleap-payload-9.9.9-mac-arm64.tar.gz" payload)
sha="$(shasum -a 256 "$TMP/zleap-payload-9.9.9-mac-arm64.tar.gz" | awk '{print $1}')"
printf \
  '{"version":"9.9.9","channel":"stable","runtime":{"version":"9.9.9","nodeVersion":"22.22.3","postgresVersion":"17.5","pgvectorVersion":"0.8.0","platforms":{}},"payload":{"version":"9.9.9","platforms":{"mac-arm64":{"url":"file://%s","sha256":"%s"}}}}\n' \
  "$TMP/zleap-payload-9.9.9-mac-arm64.tar.gz" \
  "$sha" \
  >"$TMP/latest.json"
node - "$TMP" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const tmp = process.argv[2];
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const raw = fs.readFileSync(`${tmp}/latest.json`);
fs.writeFileSync(`${tmp}/latest.json.sig`, `${crypto.sign('RSA-SHA256', raw, privateKey).toString('base64')}\n`);
fs.writeFileSync(`${tmp}/manifest-public.pem`, publicKey.export({ type: 'spki', format: 'pem' }));
NODE

HOME="$TMP/home" \
ZLEAP_HOME="$TMP/home/.zleap" \
ZLEAP_PLATFORM=mac-arm64 \
ZLEAP_MANIFEST_URL="file://$TMP/latest.json" \
ZLEAP_MANIFEST_PUBLIC_KEY_PATH="$TMP/manifest-public.pem" \
ZLEAP_REQUIRE_MANIFEST_SIGNATURE=1 \
  bash "$ROOT/scripts/install.sh" >"$TMP/install.out"

test -x "$TMP/home/.zleap/bin/zleap"
grep -q 'ZLEAP_WEB_PORT="4789"' "$TMP/home/.zleap/bin/zleap"
grep -q 'ZLEAP_GATEWAY="0"' "$TMP/home/.zleap/bin/zleap"
grep -q 'Zleap installed.' "$TMP/install.out"

printf 'Install smoke OK\n'
