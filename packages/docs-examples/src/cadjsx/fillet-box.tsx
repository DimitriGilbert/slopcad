// Primitive + fillet fixture model — the cad-jsx half of the fixture.
//
// The box primitive (its width driven by the `filletBoxWidth` parameter)
// compiles through the package CLI to packages/cad-jsx/fillet-box.native.json
// (the document) and packages/cad-jsx/fillet-box.commands.json (its batch):
//
//   pnpm --filter @slopcad/cad-jsx compile \
//     ../docs-examples/src/cadjsx/fillet-box.tsx \
//     --out fillet-box --commands fillet-box
//
// The fillet is NOT part of this tree: `<Fillet edges>` addresses `ref_…`
// persistent references only the picking layer can mint against live
// topology (see skills/slopcad-cad-jsx/SKILL.md, "Records the tree cannot
// mint"). The document-scene test
// (apps/web/src/worker-fixture/document-scene-naming.test.ts) opens the
// compiled document, mints the edge reference from the rendered box, and
// adds the fillet through the workbench's own authoring plan.

import { Box, Parameter } from "@slopcad/cad-jsx";

/** A 20 × 20 × 30 mm box whose width is the `filletBoxWidth` parameter. */
export function FilletBox(): React.JSX.Element {
  return (
    <>
      <Parameter id="param_filletBoxWidth" name="filletBoxWidth" value={20} />
      <Box id="feat_box" width="param_filletBoxWidth" depth={20} height={30} />
    </>
  );
}

export default <FilletBox />;
