# CAD minimal consumer fixture (Phase 35.4)

The MINIMAL external consumer: a fresh Vite + React 19 + Tailwind v4 app,
not a workspace member, that installs the SMALLEST useful registry set —
one UI component (`@slopcad/cad-viewport`) and one parametric CAD component
(`@slopcad/nema17-mount`, whose registry dependencies pull the component
contract/kernel/adapter items) — through the shadcn CLI from the locally
generated artifacts, exactly as an external consumer with a narrow need
would. Its page builds the mount through the Manifold kernel on the main
thread and renders it in the installed viewport; the smoke test proves the
build and the settled frame.

Run through the registry-consumer matrix (`pnpm registry:matrix` from the
repo root), which serves the artifacts on loopback 127.0.0.1:46219, installs
this fixture from scratch, and gates it: install → typecheck → build →
browser smoke. Nothing is published anywhere.
