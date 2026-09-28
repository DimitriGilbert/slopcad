/**
 * Shared mono-metadata formatting for the logged-in pages. The Machinist
 * system prints every timestamp and count in Plex Mono, so the pages
 * share one formatter instead of re-declaring Intl options per route.
 * The locale is pinned so server render and client render agree.
 */

const stampFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
});

/** A compact machine stamp: `28 Sep, 21:07`. */
export function formatStamp(iso: string): string {
  return stampFormatter.format(new Date(iso));
}

/** A counted noun in mono metadata: `1 document`, `3 documents`. */
export function plural(count: number, singular: string): string {
  return `${String(count)} ${count === 1 ? singular : `${singular}s`}`;
}
