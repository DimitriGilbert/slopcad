#!/usr/bin/env bash
#
# Phase 33 reproducibility script: rebuilds ALL registry artifacts from the
# three source registries, validates them (official validator + the repo's
# own registry-validate), reinstalls the external consumer fixture FROM
# SCRATCH (fresh node_modules; every category — UI components, CAD
# components, examples, tools — installed through the shadcn CLI over a
# loopback HTTP registry), and re-runs the consumer gates (typecheck,
# build, browser smoke).
#
# Nothing is published anywhere: the registry is served from
# packages/ui/public/r on 127.0.0.1 only, for the duration of the install.
#
# Usage: scripts/cad-registry-regenerate.sh [--skip-smoke]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONSUMER="$ROOT/fixtures/cad-consumer"
PORT=46219
SERVER_PID=""
SERVER_LOG="$(mktemp "${TMPDIR:-/tmp}/cad-registry-server.XXXXXX.log")"

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$SERVER_LOG" ]]; then
    rm -f "$SERVER_LOG"
  fi
}
trap cleanup EXIT

step() { printf '\n=== %s ===\n' "$1"; }

step "1/7 Build registry artifacts (all source registries)"
bash "$ROOT/scripts/registry-build.sh"

step "2/7 Validate registry (shadcn registry validate + registry-validate)"
for registry_dir in packages/ui packages/cad-components apps/web; do
  (cd "$ROOT/$registry_dir" && "$ROOT/packages/ui/node_modules/.bin/shadcn" registry validate ./registry.json)
done
node "$ROOT/scripts/registry-validate.mjs" --artifacts

step "3/7 Reset the consumer fixture"
cd "$CONSUMER"
rm -rf node_modules src/components src/cad src/examples dist pnpm-lock.yaml
# Filtered install: resolves the fixture's own dependencies without
# relinking the shared workspace packages' node_modules (they stay owned
# by the monorepo install).
pnpm install --filter .

step "4/7 Install every registry category from the local artifacts"
cd "$ROOT/packages/ui"
# Capture (never discard) the server's output: python http.server logs every
# request it serves to stderr — which is how readiness attributes the
# responder — and a bind failure's traceback is the diagnosis on death.
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory public/r >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
# Attribution: only THIS script's server can write $SERVER_LOG. A foreign
# listener that already holds the port kills our server with a bind error
# while curl stays green — without the log check, that foreign process
# would silently become the registry every later install fetches from.
READY=0
FOREIGN=0
for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/registry.json" >/dev/null 2>&1; then
    # Give our own server a moment to log the request it just served.
    for _probe in $(seq 1 10); do
      grep -q "\"GET /registry.json" "$SERVER_LOG" 2>/dev/null && break
      sleep 0.2
    done
    if grep -q "\"GET /registry.json" "$SERVER_LOG" 2>/dev/null && kill -0 "$SERVER_PID" 2>/dev/null; then
      READY=1
    else
      FOREIGN=1
    fi
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break # our server died and nothing answers; stop polling
  fi
  sleep 0.2
done
if [[ "$FOREIGN" == "1" ]]; then
  printf 'ERROR: port %s is served by another process — the script'\''s own server (pid %s) is not the responder. Refusing to install registry items from a foreign responder.\nServer output:\n' "$PORT" "$SERVER_PID" >&2
  cat "$SERVER_LOG" >&2
  exit 1
fi
if [[ "$READY" != "1" ]]; then
  printf 'ERROR: artifact server did not start (port %s in use?); server output:\n' "$PORT" >&2
  cat "$SERVER_LOG" >&2
  exit 1
fi
cd "$CONSUMER"
# 33.1 UI registry: the CAD UI components (their registryDependencies pull
# the shadcn primitives and the formedible subsystem).
pnpm exec shadcn add "@slopcad/cad-viewport" "@slopcad/cad-toolbar" \
  "@slopcad/cad-model-tree" "@slopcad/cad-parameter-panel" \
  "@slopcad/cad-command-menu" "@slopcad/cad-io-dialog" \
  "@slopcad/cad-property-panel" "@slopcad/cad-sketch-canvas" \
  "@slopcad/cad-sketch-inspector" "@slopcad/cad-sketch-toolbar" \
  "@slopcad/cad-status-bar" -y --overwrite
# 33.2 CAD component registry: the contract, the execution surfaces, and
# the three parametric components.
pnpm exec shadcn add "@slopcad/component-contract" "@slopcad/component-kernel" \
  "@slopcad/cad-component" "@slopcad/context-kernel" \
  "@slopcad/nema17-mount" "@slopcad/arduino-mount" "@slopcad/enclosure" \
  -y --overwrite
# 33.3 Example registry: the workbench composition and the assembly study.
pnpm exec shadcn add "@slopcad/plate-workbench" \
  "@slopcad/nema17-assembly-example" -y --overwrite
# 33.4 Tool registry: the headless inspection and feature tools.
pnpm exec shadcn add "@slopcad/bounds-inspection-tool" \
  "@slopcad/distance-inspection-tool" \
  "@slopcad/mass-properties-inspection-tool" \
  "@slopcad/radius-inspection-tool" "@slopcad/extrude-tool" \
  "@slopcad/revolve-tool" "@slopcad/hole-tool" -y --overwrite

step "5/7 Consumer gates: typecheck + build"
pnpm check-types
pnpm build

if [[ "${1:-}" == "--skip-smoke" ]]; then
  step "6/7 Consumer gate: browser smoke (skipped)"
else
  step "6/7 Consumer gate: browser smoke"
  pnpm exec playwright install chromium
  pnpm smoke
fi

step "7/7 Defensive monorepo restore"
# If anything re-linked the shared workspace packages' node_modules, the
# monorepo install owns them again.
cd "$ROOT"
pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1

printf '\n=== DONE: registry rebuilt, consumer reinstalled, gates green ===\n'
