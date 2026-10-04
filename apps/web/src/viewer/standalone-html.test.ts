/**
 * The standalone assembly's invariants: the native document rides under
 * the documented window variable, the site's chrome travels as inlined
 * style + script, a hostile payload (`</script>` inside a document string,
 * an asset carrying the same sequence) cannot break out of its element,
 * and the embedded JSON parses back byte-identically.
 */

import { describe, expect, it } from "vitest";

import {
  assembleStandaloneHtml,
  STANDALONE_NATIVE_KEY,
  STANDALONE_ROOT_ID,
  STANDALONE_TITLE_KEY,
} from "./standalone-html";

const CSS = ":root{--background:oklch(1 0 0)}.card{color:var(--background)}";
const JS = "console.log('standalone viewer boot');";
const NATIVE_TEXT = JSON.stringify({
  document: { bodies: [], features: [], parameters: [] },
  metadata: { title: "flange</script><script>alert(1)</script>" },
});
const TITLE = "flange plate";

function assembled(): string {
  return assembleStandaloneHtml({
    css: CSS,
    js: JS,
    nativeText: NATIVE_TEXT,
    title: TITLE,
  });
}

describe("standalone HTML assembly", () => {
  it("is one doctype document with the mount root", () => {
    const html = assembled();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`id="${STANDALONE_ROOT_ID}"`);
    expect(html.endsWith("</html>\n")).toBe(true);
  });

  it("embeds the native file as the documented JS variable", () => {
    const html = assembled();
    expect(html).toContain(`window["${STANDALONE_NATIVE_KEY}"] = `);
    expect(html).toContain(`window["${STANDALONE_TITLE_KEY}"] = `);
    // The embedded JSON parses back byte-identically (the \u003c escapes
    // are JSON-syntax-legal).
    const marker = `window["${STANDALONE_NATIVE_KEY}"] = `;
    const start = html.indexOf(marker) + marker.length;
    const end = html.indexOf(";\n", start);
    const embedded = JSON.parse(html.slice(start, end)) as string;
    expect(embedded).toBe(NATIVE_TEXT);
  });

  it("inlines the site chrome (appearance bootstrap, style, script)", () => {
    const html = assembled();
    expect(html).toContain("<style>");
    expect(html).toContain(CSS);
    expect(html).toContain(JS);
    expect(html).toContain(`classList.toggle("dark"`);
    expect(html).toContain(`<title>${TITLE} · slopcad viewer</title>`);
  });

  it("a </script> inside the document cannot close the element", () => {
    const html = assembled();
    // The embedded value escapes <, so the hostile sequence never appears
    // in a script block.
    expect(html).not.toContain("</script>alert");
    expect(html).toContain("\\u003c/script\\u003e");
    // The bootstrap, the injected variables, the viewer bundle.
    expect(html.match(/<script>/g)?.length).toBe(3);
  });

  it("a </script> inside the inlined bundle is neutralized, not lost", () => {
    const hostileJs = 'const s = "</script><script>alert(1)</script>";';
    const html = assembleStandaloneHtml({
      css: CSS,
      js: hostileJs,
      nativeText: NATIVE_TEXT,
      title: TITLE,
    });
    expect(html).toContain("<\\/script");
    // The neutralization is meaning-preserving: \/ parses as /.
    const lines = html.split("\n");
    const inlined = lines[lines.findIndex((line) => line.includes("const s"))];
    expect(inlined).toContain('"<\\/script><script>alert(1)<\\/script>"');
  });

  it("a </style> inside the inlined CSS cannot close the style block", () => {
    const html = assembleStandaloneHtml({
      css: '.a::after{content:"</style>"}',
      js: JS,
      nativeText: NATIVE_TEXT,
      title: TITLE,
    });
    expect(html).toContain("<\\/style");
  });
});
