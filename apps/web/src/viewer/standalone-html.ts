/**
 * The standalone HTML assembly (Phase — shareable parametric pages): the
 * pure string builder behind the viewer's "Download standalone HTML" —
 * one self-contained file that opens offline by double-click and runs the
 * SAME viewer component the /viewer route mounts.
 *
 * The file carries three things, inlined verbatim:
 *
 * - the site's compiled viewer CSS (the Machinist token system, the fonts
 *   already data-URL'd by the standalone build's inline limit) — the site's
 *   chrome in the honest sense: its real stylesheet;
 * - the site's appearance bootstrap (the same inline script the site's
 *   root document runs before first paint: the dark Machinist default,
 *   the user's persisted mode/scheme when the file's origin carries them);
 * - the site's compiled viewer bundle (the standalone entry: React, the
 *   Three.js scene, the parameter panel, and the inlined kernel worker);
 * - the native document embedded as a JS variable — the owner's words —
 *   under {@link STANDALONE_NATIVE_KEY}, plus the document title under
 *   {@link STANDALONE_TITLE_KEY}.
 *
 * Size honesty: the bundle includes the Three.js renderer and the inlined
 * Manifold WASM kernel, so the file is multi-megabyte by construction —
 * the documented cost of a single offline file. The viewer's export copy
 * says so.
 */

import { APPEARANCE_BOOTSTRAP_SCRIPT } from "../theme";

/** The window variable the embedded native document rides under. */
export const STANDALONE_NATIVE_KEY = "__SLOPCAD_NATIVE__";

/** The window variable the embedded document title rides under. */
export const STANDALONE_TITLE_KEY = "__SLOPCAD_TITLE__";

/** The DOM id the standalone entry mounts the viewer surface on. */
export const STANDALONE_ROOT_ID = "slopcad-standalone-root";

/** Inputs of {@link assembleStandaloneHtml}. */
export interface StandaloneAssemblyInput {
  /** The document title (the HTML title and the embedded variable). */
  readonly title: string;
  /** The native document text (the format's canonical JSON). */
  readonly nativeText: string;
  /** The standalone build's compiled CSS, inlined whole. */
  readonly css: string;
  /** The standalone build's compiled JS, inlined whole. */
  readonly js: string;
}

/**
 * Escapes text for safe embedding inside a `<script>` block: a literal
 * closing tag (or a `<!--` script-data escape) in the payload would end
 * the element early. Escaping the slash keeps every JS meaning intact
 * (`\/` is the same slash in strings, regexes, and comments) while the
 * parser never sees the tag.
 */
function escapeScriptBlock(text: string): string {
  return text.replaceAll("</script", "<\\/script").replaceAll("<!--", "<\\!--");
}

/** The `<style>` counterpart of {@link escapeScriptBlock} (`\/` is an
 * escaped slash in CSS strings too). */
function escapeStyleBlock(text: string): string {
  return text.replaceAll("</style", "<\\/style");
}

/**
 * Escapes JSON text for safe embedding inside a `<script>` block: `<` and
 * `>` become `\u003c`/`\u003e` so a document carrying `</script>` inside a
 * string value cannot close the element. The escape is JSON-syntax-legal,
 * so `JSON.parse` of the embedded value is byte-identical to the input.
 */
function escapeScriptJson(text: string): string {
  return text.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

/**
 * Escapes text for safe embedding inside a `<title>` (and general HTML
 * text): `&`, `<`, `>` become entities.
 */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Builds the standalone document. Pure: same inputs, same bytes — no
 * dates, no randomness — so a test can pin the exact invariants (the
 * native variable, the inline asset markers, the escaped closing tag).
 */
export function assembleStandaloneHtml(input: StandaloneAssemblyInput): string {
  const nativeJson = escapeScriptJson(JSON.stringify(input.nativeText));
  const titleJson = escapeScriptJson(JSON.stringify(input.title));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)} · slopcad viewer</title>
<script>
${escapeScriptBlock(APPEARANCE_BOOTSTRAP_SCRIPT)}
</script>
<style>
${escapeStyleBlock(input.css)}
</style>
</head>
<body>
<div id="${STANDALONE_ROOT_ID}"></div>
<script>
window["${STANDALONE_NATIVE_KEY}"] = ${nativeJson};
window["${STANDALONE_TITLE_KEY}"] = ${titleJson};
</script>
<script>
${escapeScriptBlock(input.js)}
</script>
</body>
</html>
`;
}
