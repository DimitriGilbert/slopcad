#!/usr/bin/env bash
#
# Phase 35.5 clean-checkout verification (local gate — no CI, owner policy):
# proves the repository's FINAL working state passes the full battery from a
# CLEAN export — no developer-local or generated artifacts required beyond
# the documented contributor setup (install + copy .env.example to .env).
#
# How the clean tree is built honestly WITHOUT committing (courier commits
# only after validation): the script stages the entire working tree
# (`git add -A`), materializes it as a tree object (`git write-tree` — no
# commit object), exports exactly that tree (`git archive`) into a temp
# directory, then UNSTAGES (plain `git reset`, which never touches working
# files). The export therefore equals what the courier will commit —
# gitignored state (node_modules, .data, e2e-artifacts, .output, coverage,
# packages/ui/public, .env, dist, reports) is excluded by construction.
#
# The battery run inside the clean tree (each step must succeed):
#   1. pnpm install --frozen-lockfile     — install from the committed lockfile
#   2. cp apps/web/.env.example apps/web/.env — the documented contributor step
#   3. pnpm --filter @slopcad/db db:migrate — committed migrations on a fresh DB
#   4. pnpm run check-types               — zero type errors
#   5. pnpm run lint                      — lint clean
#   6. pnpm run format:check              — formatting clean
#   7. pnpm test                          — the full unit battery
#   8. pnpm build                         — production build
#   9. pnpm test:e2e                      — the Playwright smoke battery
#  10. pnpm registry:build                — registry artifacts build
#  11. pnpm registry:validate             — registry validation
#  12. bash scripts/cad-registry-regenerate.sh --skip-smoke
#                                        — full consumer reinstall + typecheck
#                                          + build (the consumer-build gate)
#
# Usage: pnpm clean:verify    (from the repo root; ~15 minutes)
# Env:   KEEP_CLEAN_TREE=1 to keep the temp export for inspection (default:
#        removed — the tree is heavy).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START="$(date +%s)"

step() { printf '\n=== [%s] %s ===\n' "$(date +%H:%M:%S)" "$1"; }

CLEAN="$(mktemp -d /tmp/slopcad-clean-checkout.XXXXXX)"

cleanup() {
  if [[ "${KEEP_CLEAN_TREE:-0}" == "1" ]]; then
    printf 'KEEP_CLEAN_TREE=1 — clean tree kept at %s\n' "$CLEAN"
  else
    rm -rf "$CLEAN"
  fi
  # Unstage whatever this script staged; plain reset never touches files.
  git -C "$ROOT" reset -q -- >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "1/12 Export the exact working tree (stage → write-tree → archive)"
git -C "$ROOT" add -A
TREE="$(git -C "$ROOT" write-tree)"
git -C "$ROOT" archive "$TREE" | tar -x -C "$CLEAN"
printf 'exported tree %s to %s (%s files)\n' \
  "$TREE" "$CLEAN" "$(find "$CLEAN" -type f | wc -l)"

cd "$CLEAN"

step "2/12 Install from the committed lockfile"
pnpm install --frozen-lockfile

step "3/12 Contributor env step + fresh database migrations"
cp apps/web/.env.example apps/web/.env
# The gitignored local database directory (libsql needs its parent to exist).
mkdir -p .data
pnpm --filter @slopcad/db db:migrate

step "4/12 check-types"
pnpm run check-types

step "5/12 lint"
pnpm run lint

step "6/12 format:check"
pnpm run format:check

step "7/12 unit tests"
pnpm test

step "8/12 production build"
pnpm build

step "9/12 e2e smoke battery (isolated dev server — never the live one)"
# The smoke harness reuses whatever answers on its URL; a dev server may be
# running for the MAIN tree on 3001. Pin the clean tree's smoke to its own
# port so the battery provably boots THIS tree's server.
export DEV_PORT=3011
export E2E_BASE_URL=http://localhost:3011
pnpm test:e2e

step "10/12 registry artifacts build"
pnpm registry:build

step "11/12 registry validation"
pnpm registry:validate

step "12/12 registry consumer reinstall + consumer build"
bash scripts/cad-registry-regenerate.sh --skip-smoke

ELAPSED=$(( $(date +%s) - START ))
printf '\n=== CLEAN CHECKOUT VERIFIED in %sm %ss — all gates green ===\n' \
  "$((ELAPSED / 60))" "$((ELAPSED % 60))"
