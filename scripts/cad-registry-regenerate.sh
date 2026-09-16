#!/usr/bin/env bash
#
# Phase 16 reproducibility script: regenerates the CAD registry artifacts
# from the source-oriented registry definition, validates them with the
# official validator, reinstalls the external consumer fixture FROM
# SCRATCH (fresh node_modules, fresh component install through the shadcn
# CLI pointing at the locally generated artifacts over a loopback HTTP
# registry), and re-runs the consumer gates (typecheck, build, smoke).
#
# Nothing is published anywhere: the registry is served from
# packages/ui/public/r on 127.0.0.1 only, for the duration of the install.
#
# Usage: scripts/cad-registry-regenerate.sh [--skip-smoke]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONSUMER="$ROOT/fixtures/cad-consumer"
REGISTRY_DIR="$ROOT/packages/ui"
PORT=46219
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

step() { printf '\n=== %s ===\n' "$1"; }

step "1/6 Build registry artifacts (shadcn build)"
cd "$REGISTRY_DIR"
pnpm exec shadcn build -o public/r

step "2/6 Validate registry (shadcn registry validate)"
pnpm exec shadcn registry validate ./registry.json

step "3/6 Reset and reinstall the consumer fixture"
cd "$CONSUMER"
rm -rf node_modules src/components dist pnpm-lock.yaml
# Filtered install: resolves the fixture's own dependencies without
# relinking the shared workspace packages' node_modules (they stay owned
# by the monorepo install).
pnpm install --filter .

step "4/6 Install the CAD items from the local artifacts"
cd "$REGISTRY_DIR"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory public/r >/dev/null 2>&1 &
SERVER_PID=$!
READY=0
for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/registry.json" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.2
done
if [[ "$READY" != "1" ]]; then
  printf 'ERROR: artifact server did not start (port %s in use?)\n' "$PORT" >&2
  exit 1
fi
cd "$CONSUMER"
pnpm exec shadcn add "@slopcad/cad-viewport" "@slopcad/cad-toolbar" \
  "@slopcad/cad-model-tree" "@slopcad/cad-parameter-panel" -y --overwrite

step "5/6 Consumer gates: typecheck + build"
pnpm check-types
pnpm build

if [[ "${1:-}" == "--skip-smoke" ]]; then
  step "6/6 Consumer gate: browser smoke (skipped)"
else
  step "6/6 Consumer gate: browser smoke"
  pnpm exec playwright install chromium
  pnpm smoke
fi

# Defensive restore: if anything re-linked the shared workspace packages'
# node_modules, the monorepo install owns them again.
cd "$ROOT"
pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1

printf '\n=== DONE: registry regenerated, consumer reinstalled, gates green ===\n'
