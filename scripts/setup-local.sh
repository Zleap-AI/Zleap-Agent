#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PNPM_VERSION="${PNPM_VERSION:-9.15.0}"
START_WEB=1
if [[ "${1:-}" == "--no-start" ]]; then
  START_WEB=0
fi

has() {
  command -v "$1" >/dev/null 2>&1
}

is_macos() {
  [[ "$(uname -s)" == "Darwin" ]]
}

node_ok() {
  has node && [[ "$(node -p "Number(process.versions.node.split('.')[0])")" -ge 20 ]]
}

load_brew() {
  if has brew; then
    return
  fi
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

ensure_brew() {
  load_brew
  if has brew; then
    return
  fi
  if ! is_macos; then
    echo "Install Node.js 20+, pnpm, and Docker Desktop, then rerun this script." >&2
    exit 1
  fi
  echo "Installing Homebrew..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  load_brew
}

ensure_node() {
  if node_ok; then
    return
  fi
  if is_macos; then
    ensure_brew
    brew install node
    return
  fi
  echo "Node.js 20+ is required. Install it from https://nodejs.org/ and rerun this script." >&2
  exit 1
}

ensure_pnpm() {
  if has pnpm; then
    return
  fi
  if has corepack; then
    corepack enable || true
    corepack prepare "pnpm@${PNPM_VERSION}" --activate || true
  fi
  if ! has pnpm && has npm; then
    npm install -g "pnpm@${PNPM_VERSION}"
  fi
  hash -r 2>/dev/null || true
  if ! has pnpm; then
    echo "Failed to install pnpm. Install pnpm@${PNPM_VERSION}, then rerun this script." >&2
    exit 1
  fi
}

has_database_url() {
  [[ -n "${ZLEAP_DATABASE_URL:-}" || -n "${DATABASE_URL:-}" ]]
}

ensure_postgres() {
  if has_database_url; then
    return
  fi
  if is_macos; then
    ensure_brew
    brew list postgresql@16 >/dev/null 2>&1 || brew install postgresql@16
    brew list pgvector >/dev/null 2>&1 || brew install pgvector
    return
  fi
  if docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker compose up -d postgres
    return
  fi
  cat >&2 <<'EOF'
PostgreSQL + pgvector is required.
Install PostgreSQL + pgvector, set ZLEAP_DATABASE_URL, or run Docker Desktop, then rerun this script.
EOF
  exit 1
}

ensure_node
ensure_pnpm
pnpm install

ensure_postgres

if [[ "${START_WEB}" == "1" ]]; then
  exec pnpm dev:web
fi

cat <<'EOF'
Setup complete.

Start WebUI with:
  pnpm dev:web

Default local database:
  ZLEAP_DATABASE_URL=postgres://zleap:zleap@127.0.0.1:5433/zleap
EOF
