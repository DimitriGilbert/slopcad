/**
 * The app's theme mechanism: one boolean identity (dark = the workshop
 * at night, light = the drafting room), persisted per browser, applied
 * before first paint by an inline script so there is never a flash of
 * the wrong theme.
 *
 * The source of truth is the `dark` class on `<html>` (plus the matching
 * `color-scheme` for native controls). React never re-renders for theme
 * changes: the toggle writes the class and localStorage, then broadcasts
 * a window event that mounted toggles listen for — so any number of
 * toggles (app chrome, docs rail) stay in agreement without a provider.
 */

/** The localStorage key the choice persists under. */
export const THEME_STORAGE_KEY = "slopcad-theme";

/** The two realized themes. */
export type Theme = "dark" | "light";

/** The window event a theme change broadcasts. */
export const THEME_CHANGE_EVENT = "slopcad:theme-change";

/**
 * The no-flash bootstrap: reads the stored choice (defaulting to dark,
 * the app's established identity), applies it synchronously in `<head>`.
 * Rendered as an inline head script by the root route.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t!=="light"&&t!=="dark"){t="dark"}var d=t==="dark";var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=t}catch(e){document.documentElement.classList.add("dark")}})();`;

/** Reads the currently applied theme from the document. */
export function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Applies and persists a theme, then notifies every mounted toggle. */
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
