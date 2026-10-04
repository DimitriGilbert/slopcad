/**
 * The /viewer frame policy (Phase — shareable parametric pages): the
 * response headers that make the viewer route EMBEDDABLE.
 *
 * The owner's requirement is an iframe-first share surface: the viewer
 * must be framable on any other site. The app ships no frame-blocking
 * header today (the nitro node-server preset sends neither
 * `X-Frame-Options` nor a CSP `frame-ancestors`), so nothing needs
 * RELAXING — what this module owns is the explicit GUARANTEE, applied
 * route-scoped so a future global hardening (e.g. site-wide
 * `frame-ancestors 'self'`) can never silently break the embed: the
 * `/viewer` route rule re-asserts the allow right on this one path.
 *
 * Why a scheme list and not `*`: the CSP spec's `*` matches only network
 * schemes (http/https/ws/wss) — a host page on a `data:` or `file:` URL
 * (an opaque origin) is NOT covered, and Chromium blocks exactly that
 * embed with "violates frame-ancestors *". The embed story is "any other
 * site", so the allow names the schemes explicitly.
 *
 * The value is centralized here so the vite config (which wires it into
 * the nitro route rules) and the tests assert the same source of truth;
 * the session harness probes the LIVE response header for it.
 */

/** The exact headers the /viewer route carries. */
export const VIEWER_FRAME_HEADERS: Readonly<Record<string, string>> = {
  // The page carries no auth and no credentials — the document rides the
  // URL fragment, never a cookie — so the framing origin is not a trust
  // boundary for this route.
  "content-security-policy": "frame-ancestors http: https: data: blob: file:",
};
