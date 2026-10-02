/**
 * The standalone viewer build's committed asset paths (Phase — shareable
 * parametric pages): `vite.standalone.config.ts` compiles the standalone
 * entry into `apps/web/public/viewer-standalone/` at build time, so the
 * site's export button can fetch the site's own compiled viewer and inline
 * it into the downloaded file. The names are stable (no hashes) because
 * the export fetches them by path; the files ship with the site like any
 * public asset.
 */

/** The standalone export's asset descriptor. */
export interface StandaloneAssets {
  /** The compiled CSS (fonts already data-URL'd by the inline limit). */
  readonly cssUrl: string;
  /** The compiled JS (the standalone entry's IIFE bundle). */
  readonly jsUrl: string;
}

/** The compiled standalone viewer's fetched assets. */
export const STANDALONE_ASSETS: StandaloneAssets = {
  cssUrl: "/viewer-standalone/viewer-standalone.css",
  jsUrl: "/viewer-standalone/viewer-standalone.js",
};
