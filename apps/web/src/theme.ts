/**
 * The app's appearance mechanism: TWO axes, persisted per browser and
 * applied before first paint by an inline script so there is never a
 * flash of the wrong look.
 *
 * - MODE (the `.dark` class on `<html>`, plus the matching
 *   `color-scheme` for native controls): dark = the workshop at night,
 *   light = the drafting room.
 * - SCHEME (the `data-scheme` attribute on `<html>`): which of the four
 *   color schemes paints both registers — Machinist (default), Drafting
 *   Room, Studios, Ember. A scheme is a named token-set variant, not a
 *   layout change; every structural component is identical underneath.
 *
 * React never re-renders for appearance changes: the controls write the
 * class/attribute and localStorage, then broadcast window events that
 * mounted controls listen for — so any number of controls (app chrome,
 * docs rail, the scheme picker) stay in agreement without a provider.
 * The CAD scene listens to the same document signals through its own
 * MutationObserver (see cad-studio-palette) and re-inks on the next
 * demand frame.
 */

/** The localStorage key the MODE choice persists under. */
export const THEME_STORAGE_KEY = "slopcad-theme";

/** The localStorage key the SCHEME choice persists under. */
export const SCHEME_STORAGE_KEY = "slopcad-scheme";

/** The two realized modes. */
export type Theme = "dark" | "light";

/** The four color schemes (Machinist is the default). */
export type Scheme = "machinist" | "drafting" | "studios" | "ember";

/** Metadata for one scheme: its picker identity and both-register swatch. */
export interface SchemeMeta {
  readonly id: Scheme;
  readonly label: string;
  /** One line under the picker label: what the scheme is. */
  readonly description: string;
  /** The accent swatches (light register, dark register) in the picker. */
  readonly swatch: readonly [string, string];
}

/** Every scheme, in picker order. */
export const SCHEMES: readonly SchemeMeta[] = Object.freeze([
  {
    id: "machinist",
    label: "Machinist",
    description: "Graphite and machinist amber",
    swatch: ["oklch(0.51 0.115 65)", "oklch(0.8 0.145 78)"],
  },
  {
    id: "drafting",
    label: "Drafting Room",
    description: "Graphite ink on vellum paper",
    swatch: ["oklch(0.52 0.14 70)", "oklch(0.7686 0.1647 70.08)"],
  },
  {
    id: "studios",
    label: "Studios",
    description: "The night studio and its daylight table",
    swatch: ["oklch(0.52 0.135 52)", "oklch(0.77 0.155 70)"],
  },
  {
    id: "ember",
    label: "Ember",
    description: "Machined graphite, one burnt ember",
    swatch: ["oklch(0.55 0.16 47)", "oklch(0.76 0.15 62)"],
  },
]);

/** The window event a MODE change broadcasts. */
export const THEME_CHANGE_EVENT = "slopcad:theme-change";

/** The window event a SCHEME change broadcasts. */
export const SCHEME_CHANGE_EVENT = "slopcad:scheme-change";

/** The scheme the attribute carries when nothing (or junk) was stored. */
export const DEFAULT_SCHEME: Scheme = "machinist";

function isScheme(value: unknown): value is Scheme {
  return (
    value === "machinist" ||
    value === "drafting" ||
    value === "studios" ||
    value === "ember"
  );
}

/**
 * The no-flash bootstrap: reads the stored mode and scheme (defaulting
 * to dark / Machinist — the app's established identity), applies both
 * synchronously in `<head>`. Rendered as an inline head script by the
 * root route.
 */
export const APPEARANCE_BOOTSTRAP_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t!=="light"&&t!=="dark"){t="dark"}var s=localStorage.getItem(${JSON.stringify(SCHEME_STORAGE_KEY)});if(s!=="drafting"&&s!=="studios"&&s!=="ember"){s="machinist"}var r=document.documentElement;r.classList.toggle("dark",t==="dark");r.style.colorScheme=t;r.setAttribute("data-scheme",s)}catch(e){document.documentElement.classList.add("dark");document.documentElement.setAttribute("data-scheme","machinist")}})();`;

/** Reads the currently applied mode from the document. */
export function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Reads the currently applied scheme from the document. */
export function currentScheme(): Scheme {
  const value = document.documentElement.getAttribute("data-scheme");
  return isScheme(value) ? value : DEFAULT_SCHEME;
}

/** Applies and persists a mode, then notifies every mounted control. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private-mode storage: the choice still applies for this page view.
  }
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
}

/** Applies and persists a scheme, then notifies every mounted control. */
export function applyScheme(scheme: Scheme): void {
  document.documentElement.setAttribute("data-scheme", scheme);
  try {
    localStorage.setItem(SCHEME_STORAGE_KEY, scheme);
  } catch {
    // Private-mode storage: the choice still applies for this page view.
  }
  window.dispatchEvent(new CustomEvent(SCHEME_CHANGE_EVENT));
}
