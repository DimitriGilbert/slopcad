#!/usr/bin/env bash
#
# Phase 35.4 registry-consumer MATRIX: proves the registry artifacts install
# and gate in MORE than the single every-category path —
#
#   Scenario A — the full consumer, fresh state, REVERSED category order:
#     the same complete install as `pnpm registry:regenerate`, but the four
#     categories are requested in the opposite order (tools → examples →
#     CAD components → UI components). The CLI's registry-dependency
#     resolution must be order-independent; typecheck + build + browser
#     smoke prove the installed tree is identical in function.
#
#   Scenario B — the MINIMAL consumer, fresh state: a second, narrower
#     external project (`fixtures/cad-consumer-minimal`) that installs only
#     one UI component and one CAD component (plus whatever their registry
#     dependencies pull), then typechecks, builds, and browser-smokes the
#     mounted component.
#
# Nothing is published anywhere: the registry is served from
# packages/ui/public/r on 127.0.0.1 only, for the duration of the installs.
#
# Usage: scripts/cad-registry-matrix.sh [--skip-smoke]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FULL="$ROOT/fixtures/cad-consumer"
MINIMAL="$ROOT/fixtures/cad-consumer-minimal"
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

step "1/6 Build + validate registry artifacts"
bash "$ROOT/scripts/registry-build.sh"
for registry_dir in packages/ui packages/cad-components apps/web; do
  (cd "$ROOT/$registry_dir" && "$ROOT/packages/ui/node_modules/.bin/shadcn" registry validate ./registry.json)
done
node "$ROOT/scripts/registry-validate.mjs" --artifacts

step "2/6 Serve the artifacts on loopback"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT/packages/ui/public/r" >/dev/null 2>&1 &
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

step "3/6 Scenario A: full consumer, fresh state, REVERSED category order"
cd "$FULL"
rm -rf node_modules src/components src/cad src/examples dist pnpm-lock.yaml
pnpm install --filter .
# 33.4 tools first (previously last)…
pnpm exec shadcn add "@slopcad/bounds-inspection-tool" \
  "@slopcad/distance-inspection-tool" \
  "@slopcad/mass-properties-inspection-tool" \
  "@slopcad/radius-inspection-tool" "@slopcad/extrude-tool" \
  "@slopcad/revolve-tool" "@slopcad/hole-tool" -y --overwrite
# …then the examples…
pnpm exec shadcn add "@slopcad/plate-workbench" \
  "@slopcad/nema17-assembly-example" -y --overwrite
# …then the CAD components…
pnpm exec shadcn add "@slopcad/component-contract" "@slopcad/component-kernel" \
  "@slopcad/cad-component" "@slopcad/context-kernel" \
  "@slopcad/nema17-mount" "@slopcad/arduino-mount" "@slopcad/enclosure" \
  -y --overwrite
# …and the UI components LAST (previously first): their registryDependencies
# must resolve regardless of arrival order.
pnpm exec shadcn add "@slopcad/cad-viewport" "@slopcad/cad-toolbar" \
  "@slopcad/cad-model-tree" "@slopcad/cad-parameter-panel" \
  "@slopcad/cad-command-menu" "@slopcad/cad-io-dialog" \
  "@slopcad/cad-property-panel" "@slopcad/cad-sketch-canvas" \
  "@slopcad/cad-sketch-inspector" "@slopcad/cad-sketch-toolbar" \
  "@slopcad/cad-status-bar" -y --overwrite

step "4/6 Scenario A gates: typecheck + build + browser smoke"
pnpm check-types
pnpm build
if [[ "${1:-}" == "--skip-smoke" ]]; then
  printf 'browser smoke skipped (--skip-smoke)\n'
else
  pnpm exec playwright install chromium
  pnpm smoke
fi

step "5/6 Scenario B: the minimal consumer, fresh state"
cd "$MINIMAL"
rm -rf node_modules src/components src/cad dist pnpm-lock.yaml
pnpm install --filter .
# The minimal install set: one UI component + one CAD component. Their
# registry dependencies (the shadcn primitives the viewport needs, the
# component contract/kernel/adapter items the mount needs) resolve through
# the same loopback registry.
pnpm exec shadcn add "@slopcad/cad-viewport" -y --overwrite
pnpm exec shadcn add "@slopcad/nema17-mount" -y --overwrite

step "6/6 Scenario B gates: typecheck + build + browser smoke"
pnpm check-types
pnpm build
if [[ "${1:-}" == "--skip-smoke" ]]; then
  printf 'browser smoke skipped (--skip-smoke)\n'
else
  pnpm smoke
fi

# Defensive monorepo restore (the regenerate script's discipline): if
# anything re-linked the shared workspace packages' node_modules, the
# monorepo install owns them again.
cd "$ROOT"
pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1

printf '\n=== DONE: registry consumer matrix green (reversed order + minimal) ===\n'
