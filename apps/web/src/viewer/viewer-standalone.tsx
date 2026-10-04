/**
 * The standalone viewer entry (Phase — shareable parametric pages): the
 * single-file export's boot. Compiled by `vite.standalone.config.ts` into
 * ONE self-contained bundle that `assembleStandaloneHtml` inlines into the
 * downloaded HTML; the native document arrives as a JS variable (the
 * owner's words) instead of a URL fragment.
 *
 * This entry is the SECOND mount of the same {@link ViewerSurface} the
 * /viewer route mounts — the viewer is written once. It mounts on the
 * exported file's own root and reads the injected document defensively:
 * a missing or malformed variable is the empty state's error line, never a
 * blank file.
 */

import { createRoot } from "react-dom/client";

// The site's real stylesheet: the same Tailwind entry the app's root route
// loads, so the standalone wears the site's chrome (the build inlines the
// compiled CSS — fonts included — into the exported HTML).
import "../index.css";
import ManifoldWorker from "../worker-fixture/manifold-worker-entry?worker&inline";
import {
  STANDALONE_NATIVE_KEY,
  STANDALONE_ROOT_ID,
  STANDALONE_TITLE_KEY,
} from "./standalone-html";
import { ViewerSurface } from "./ViewerSurface";

/** The injected payload's shape this entry tolerates. */
interface StandaloneWindow {
  readonly [STANDALONE_NATIVE_KEY]?: unknown;
  readonly [STANDALONE_TITLE_KEY]?: unknown;
}

/** The injected native text, when the export embedded a plain string. */
function injectedNativeText(): string | null {
  const scope = window as unknown as StandaloneWindow;
  const value = scope[STANDALONE_NATIVE_KEY];
  return typeof value === "string" ? value : null;
}

/** The injected document title, when the export embedded a plain string. */
function injectedTitle(): string | null {
  const scope = window as unknown as StandaloneWindow;
  const value = scope[STANDALONE_TITLE_KEY];
  return typeof value === "string" ? value : null;
}

const container = document.getElementById(STANDALONE_ROOT_ID);
if (container === null) {
  throw new Error(
    `the standalone viewer's root #${STANDALONE_ROOT_ID} is missing from the export`,
  );
}
const nativeText = injectedNativeText();

/**
 * The standalone mount's worker: the kernel bundled IIFE and inlined as a
 * blob (see vite.standalone.config.ts) — the only worker form a
 * `file://`-opened single HTML can boot. Module-level, so the factory's
 * identity is stable across renders (the engine boots exactly once).
 */
const bootInlineWorker = (): Worker => new ManifoldWorker();

// No StrictMode (the app's convention): the double-invoked boot effect
// would boot two kernel workers in development runs of this entry.
createRoot(container).render(
  <ViewerSurface
    injectedNativeText={nativeText}
    injectedTitle={injectedTitle()}
    variant="standalone"
    workerFactory={bootInlineWorker}
  />,
);
