// Parametric multi-handle cup — authored as raw CadCommands, not cad-jsx.
//
// The live model binds sketch dimensions to parameters via
// `parameterId`-carrying constraints (distanceX/distanceY), which cad-jsx
// cannot express — see parametric-cup.native.json for the document and
// parametric-cup.commands.json for the rebuild batch (cad_apply_commands).
//
// Geometry: one revolve of an L-profile with a raised handle band
// (z = bandZ1..bandZ2, radius rBoss), plus six 270° revolve arcs whose
// workplane normals are tilted 45° between radial and +Z so the gap faces
// the cup axis — C-shaped handles whose tube ends bury ~3 mm into the band,
// never reaching the cavity. A union feature fuses them in the kernel; the
// producers stay visible because the render layer cannot draw unions of
// revolves.

export {};
