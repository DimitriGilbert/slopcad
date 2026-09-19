#!/usr/bin/env bash
#
# Phase 35.3 WebKit user-space dependency setup: makes Playwright's WebKit
# (webkit-2359) runnable on this Fedora host WITHOUT sudo, by satisfying the
# two missing sonames/symbol-versions with real Ubuntu packages extracted
# into the browser bundle's own library directories (the wrapper script
# `minibrowser-wpe/MiniBrowser` puts exactly those directories on its
# LD_LIBRARY_PATH):
#
#   1. libjpeg.so.8 with LIBJPEG_8.0 symbol versions — Fedora ships
#      libjpeg.so.62 only (libjpeg-turbo dropped the 8 ABI); Ubuntu's
#      libjpeg8 (turbo 3.x, 8-ABI build) provides it.
#   2. libicudata/i18n/uc.so.74 with ICU 74 symbols — the host has ICU 77;
#      soname symlinks to a newer ICU (the earlier Phase 30 shim) satisfy
#      the loader but fail symbol lookups (`ureldatefmt_format_74`).
#
# The remaining host check (gstreamer1.0-libav, media codecs) is not needed
# for DOM/WebGL automation; the matrix suite skips Playwright's host
# validation via PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS (set inside
# playwright.matrix.config.ts).
#
# This overturned Phase 30's decline: the browser then died on
# `libjpeg.so.8: LIBJPEG_8.0 not found`; with real libs it launches and
# drives WebGL 2.0 headlessly.
#
# Idempotent; re-run after any `playwright install` (which restores the
# bundle). Usage: pnpm webkit:deps   (from the repo root)

set -euo pipefail

# Pinned sha256 checksums (Phase 35 integrity fix): computed from the
# working bundles this script installs, then cross-verified against the
# Ubuntu archive's own package indexes — libjpeg8 against the SHA512 in
# dists/devel/main's Packages (the suite that carries libjpeg-turbo's real
# 8-ABI libjpeg8), libicu74 against the SHA256 in dists/noble-updates.
# URLs are https (the archive serves both files over TLS). Every run
# re-verifies the file — downloaded OR cache-hit — BEFORE extraction and
# fails loudly on mismatch, so a corrupted or tampered cache can never
# reach a bundle's LD_LIBRARY_PATH. Do not bump a checksum without
# re-deriving it and re-proving the browser launches.
LIBJPEG_DEB_URL="https://archive.ubuntu.com/ubuntu/pool/main/libj/libjpeg-turbo/libjpeg8_3.1.3-4ubuntu2_amd64.deb"
LIBJPEG_DEB_SHA256="633a49d593c6aa1fa78c8db806512a90122803de040420960add6cfa535363cf"
ICU_DEB_URL="https://archive.ubuntu.com/ubuntu/pool/main/i/icu/libicu74_74.2-1ubuntu3.1_amd64.deb"
ICU_DEB_SHA256="c9a70989678660eed9a1e904c74fa043da8bec8e2036856fc16e31ced79b04f8"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/slopcad/webkit-deps"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Find every Playwright WebKit bundle that ships the WPE MiniBrowser.
shopt -s nullglob
BUNDLES=("${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright"/webkit-*/minibrowser-wpe)
if [[ ${#BUNDLES[@]} -eq 0 ]]; then
  printf 'ERROR: no Playwright WebKit bundle found — run the browser install first.\n' >&2
  exit 1
fi

extract_deb() {
  local url="$1" expected="$2" name dest actual
  name="$(basename "$url")"
  dest="$CACHE_DIR/$name"
  if [[ ! -f "$dest" ]]; then
    mkdir -p "$CACHE_DIR"
    printf 'downloading %s\n' "$name" >&2
    curl -fsSL "$url" -o "$dest"
  fi
  actual="$(sha256sum "$dest" | cut -d' ' -f1)"
  if [[ "$actual" != "$expected" ]]; then
    printf 'ERROR: sha256 mismatch for %s\n  expected %s\n  actual   %s\n  Refusing to extract. If the cache copy is corrupt, delete %s and re-run;\n  if the pin is stale, re-derive it deliberately (see the comment above).\n' \
      "$dest" "$expected" "$actual" "$dest" >&2
    exit 1
  fi
  mkdir -p "$WORK/${name%.deb}"
  (cd "$WORK/${name%.deb}" && ar x "$dest" &&
    zstd -d data.tar.zst -o data.tar && tar -xf data.tar) >&2
  printf '%s\n' "$WORK/${name%.deb}"
}

printf 'Preparing user-space deps (cache: %s)\n' "$CACHE_DIR"
LIBJPEG_DIR="$(extract_deb "$LIBJPEG_DEB_URL" "$LIBJPEG_DEB_SHA256")"
ICU_DIR="$(extract_deb "$ICU_DEB_URL" "$ICU_DEB_SHA256")"

runnable=0
for bundle in "${BUNDLES[@]}"; do
  libdir="$bundle/lib"
  [[ -d "$libdir" ]] || continue
  printf 'installing real libs into %s\n' "$libdir"

  # libjpeg.so.8 (real 8-ABI turbo): replace whatever the bundle carried.
  rm -f "$libdir/libjpeg.so.8"
  cp "$LIBJPEG_DIR/usr/lib/x86_64-linux-gnu/libjpeg.so.8.3.2" "$libdir/libjpeg.so.8"

  # ICU 74 (real symbols): replace soname-only shims/symlinks if present.
  for lib in libicudata.so.74 libicui18n.so.74 libicuuc.so.74; do
    rm -f "$libdir/$lib" "$bundle/sys/lib/$lib"
    cp "$ICU_DIR/usr/lib/x86_64-linux-gnu/$lib" "$libdir/$lib"
  done

  # Proof: the wrapper must launch and report its version. A stale bundle
  # from an older Playwright may need further sonames this script does not
  # carry — that is a warning, not a failure, as long as the bundle the
  # installed Playwright actually uses ends up runnable.
  if "$bundle/MiniBrowser" --version >/dev/null 2>&1; then
    printf 'OK: %s launches (%s)\n' "$bundle" "$("$bundle/MiniBrowser" --version)"
    runnable=$((runnable + 1))
  else
    printf 'WARNING: %s still fails to launch (stale bundle with extra deps?):\n' "$bundle" >&2
    "$bundle/MiniBrowser" --version >&2 || true
  fi
done

if [[ "$runnable" -eq 0 ]]; then
  printf 'ERROR: no WebKit bundle became runnable.\n' >&2
  exit 1
fi

printf '\nWebKit is runnable (%s bundle(s)). The browser matrix: pnpm test:matrix\n' "$runnable"
