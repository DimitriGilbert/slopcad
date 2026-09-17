/**
 * Ambient declaration of the standard `WebAssembly.Memory.buffer` member
 * this package reads off the binding's live WASM heap.
 *
 * Why it exists: the repo's base tsconfig compiles with `lib: ["ESNext"]`
 * and `types: ["node"]` — neither declares the WebAssembly JS API — and
 * `replicad-opencascadejs` itself declares a global `WebAssembly` namespace
 * holding only the `Exception` tag interface (its own comment: TypeScript's
 * standard libraries do not declare that runtime type in every lib
 * combination, so it stays structural). Inside that merged namespace
 * `Memory` has no resolvable `buffer` member, which starves the type-aware
 * lint rules. This declaration adds the one standard member the kernel
 * uses, structurally, so it merges cleanly here and with any fuller
 * standard-library definition elsewhere.
 */

declare global {
  namespace WebAssembly {
    interface Memory {
      readonly buffer: ArrayBuffer;
    }
  }
}

export {};
