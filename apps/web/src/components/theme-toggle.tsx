/**
 * The theme toggle: a compact two-state control that flips the app
 * between its two realized themes (dark = workshop, light = drafting
 * room). It renders a neutral shell on the server and resolves its icon
 * from the document after mount — the no-flash bootstrap script owns
 * the class before paint, so there is nothing to hydrate against.
 */

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

import {
  THEME_CHANGE_EVENT,
  applyTheme,
  currentTheme,
  type Theme,
} from "../theme";

/** Props of {@link ThemeToggle}. */
export interface ThemeToggleProps {
  /** Accessible name override (the default names the target theme). */
  readonly label?: string;
  /** Extends the button classes. */
  readonly className?: string;
}

export function ThemeToggle({ label, className }: ThemeToggleProps) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
    const onChange = () => {
      setTheme(currentTheme());
    };
    window.addEventListener(THEME_CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    };
  }, []);

  const next: Theme = theme === "dark" ? "light" : "dark";

  return (
    <button
      aria-label={label ?? `Switch to the ${next} theme`}
      className={
        className ??
        "border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-7 cursor-pointer items-center justify-center rounded-sm border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      }
      data-testid="theme-toggle"
      data-theme-next={theme === null ? undefined : next}
      onClick={() => {
        applyTheme(next);
      }}
      title={label ?? `Switch to the ${next} theme`}
      type="button"
    >
      {theme === "light" ? (
        <Moon aria-hidden="true" className="size-3.5" />
      ) : (
        <Sun aria-hidden="true" className="size-3.5" />
      )}
    </button>
  );
}
