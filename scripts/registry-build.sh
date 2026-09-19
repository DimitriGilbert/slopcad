#!/usr/bin/env bash
#
# Phase 33 registry build: builds every source registry's artifacts into the
# single served directory (packages/ui/public/r) and regenerates the merged
# registry.json index. Nothing is published anywhere — the artifacts are
# byte-reproducible local files served on loopback during consumer installs.
#
# Source registries (Formedible-style per-package authoring):
#   packages/ui/registry.json            UI components + example blocks
#   packages/cad-components/registry.json parametric CAD components + example
#   apps/web/registry.json               headless workbench tools
#
# Usage: scripts/registry-build.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/packages/ui/public/r"
SHADCN="$ROOT/packages/ui/node_modules/.bin/shadcn"

if [[ ! -x "$SHADCN" ]]; then
  printf 'ERROR: shadcn CLI not found at %s (run pnpm install first).\n' "$SHADCN" >&2
  exit 1
fi

# Prune before building: `shadcn build` never deletes per-item JSONs and
# registry-index.mjs unions every schema-carrying *.json on disk, so a
# removed or renamed source item would keep being advertised with stale
# bytes forever without this.
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

for registry_dir in packages/ui packages/cad-components apps/web; do
  printf '==> building %s/registry.json\n' "$registry_dir"
  (cd "$ROOT/$registry_dir" && "$SHADCN" build registry.json -o "$OUT_DIR")
done

printf '==> merging the registry index\n'
node "$ROOT/scripts/registry-index.mjs" "$OUT_DIR"

printf '==> registry build complete: %s\n' "$OUT_DIR"
