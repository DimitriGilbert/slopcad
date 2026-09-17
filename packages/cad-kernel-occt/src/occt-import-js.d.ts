/**
 * Ambient module type for `occt-import-js` (Phase 21.5's IGES fallback):
 * the package ships no TypeScript declarations (its npm payload is the
 * emscripten JS glue + wasm only), so this file declares the surface this
 * repo consumes — the MODULARIZED factory, the engine's three readers, the
 * IGES reader's params, and the JSON result shape. Every field here was
 * probed against the real 0.0.23 payload (see
 * docs/architecture/occt-prespike-findings.md's 21.5 addendum): the factory
 * resolves to a promise of the engine, `ReadIgesFile` never throws on bad
 * input (it answers `success: false`), and successful meshes carry
 * three.js-compatible flat position/normal/index arrays plus per-face
 * `brep_faces` triangle ranges.
 */

declare module "occt-import-js" {
  /** One BREP face's triangle range inside a mesh's index array. */
  export interface OcctImportJsBrepFace {
    /** The first triangle index of the face (inclusive). */
    readonly first: number;
    /** The last triangle index of the face (inclusive). */
    readonly last: number;
    /** The face's rgb color (0..1 triple), or null for none. */
    readonly color: readonly [number, number, number] | null;
  }

  /** One mesh of a read result, geometry compatible with three.js. */
  export interface OcctImportJsMesh {
    readonly name: string;
    /** The mesh's rgb color (0..1 triple), when the source carries one. */
    readonly color?: readonly number[];
    /** The source BREP faces as triangle ranges into `index`. */
    readonly brep_faces: readonly OcctImportJsBrepFace[];
    readonly attributes: {
      /** Flat vertex positions: number triplets. */
      readonly position: { readonly array: readonly number[] };
      /** Flat vertex normals: number triplets, when computed. */
      readonly normal?: { readonly array: readonly number[] };
    };
    /** Flat triangle indices: number triplets, zero-based. */
    readonly index: { readonly array: readonly number[] };
  }

  /** One node of the read result's assembly hierarchy. */
  export interface OcctImportJsNode {
    readonly name: string;
    /** Indices into the result's meshes array. */
    readonly meshes: readonly number[];
    readonly children: readonly OcctImportJsNode[];
  }

  /** The readers' JSON answer: `success` decides everything else's presence. */
  export interface OcctImportJsResult {
    readonly success: boolean;
    /** The root assembly node, present on success. */
    readonly root?: OcctImportJsNode;
    /** The meshes the file's solids triangulated into, present on success. */
    readonly meshes?: readonly OcctImportJsMesh[];
  }

  /** The triangulation parameters the readers accept (`null` = defaults). */
  export interface OcctImportJsParams {
    /**
     * The output's linear unit: `millimeter` (the default, and this repo's
     * canonical unit), `centimeter`, `meter`, `inch`, or `foot`.
     */
    readonly linearUnit?:
      "millimeter" | "centimeter" | "meter" | "inch" | "foot";
    /** What `linearDeflection` means: `bounding_box_ratio` (default) or `absolute_value`. */
    readonly linearDeflectionType?: "bounding_box_ratio" | "absolute_value";
    readonly linearDeflection?: number;
    readonly angularDeflection?: number;
  }

  /** The initialized engine: three file readers, nothing else this repo uses. */
  export interface OcctImportJsInstance {
    readonly ReadIgesFile: (
      content: Uint8Array,
      params: OcctImportJsParams | null,
    ) => OcctImportJsResult;
  }

  /** The MODULARIZED factory: standard emscripten `locateFile` hook supported. */
  export default function occtimportjs(config?: {
    readonly locateFile?: (path: string, scriptDirectory: string) => string;
  }): Promise<OcctImportJsInstance>;
}

/**
 * Ambient module type for the bundler-pinned wasm asset of the fallback
 * engine (the `occt-wasm-url` twin): Vite's `?url` suffix import resolves
 * the hashed asset at build time and yields its URL. Consumed by
 * `./occt-iges-engine.web`, whose package carries the dependency — apps
 * with vite/client types also get the generic `*?url` declaration.
 */
declare module "occt-import-js/dist/occt-import-js.wasm?url" {
  /** The bundler-emitted URL of `occt-import-js.wasm`. */
  const url: string;
  export default url;
}
