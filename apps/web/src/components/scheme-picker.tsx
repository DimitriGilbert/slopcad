/**
 * The scheme picker: the control that selects one of the four color
 * schemes (Machinist, Drafting Room, Studios, Ember) and either register
 * (dark, light) — the two axes of the app's appearance, in one menu.
 * Each scheme row shows its two accent swatches (its light-register
 * accent and dark-register accent) so the choice reads in color, not
 * just in words; the register group mirrors the ThemeToggle's quick
 * flip so one control is fully self-sufficient.
 *
 * Like the ThemeToggle, the shell renders neutral on the server and
 * resolves its state from the document after mount — the no-flash
 * bootstrap owns both the class and the data-scheme attribute before
 * paint, so there is nothing to hydrate against. Selection is broadcast
 * through the same window events every mounted control listens for.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Check, Moon, Paintbrush, Sun } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@slopcad/ui/components/dropdown-menu";

import {
  SCHEME_CHANGE_EVENT,
  SCHEMES,
  THEME_CHANGE_EVENT,
  applyScheme,
  applyTheme,
  currentScheme,
  currentTheme,
  type Scheme,
  type Theme,
} from "../theme";

/** Props of {@link SchemePicker}. */
export interface SchemePickerProps {
  /** Extends the trigger's classes (the default is the header's 28px box). */
  readonly className?: string;
}

/** One scheme row's paired accent swatches: light register, dark register. */
function SchemeSwatches({
  swatch,
}: {
  readonly swatch: readonly [string, string];
}): ReactElement {
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center -space-x-1">
      {swatch.map((color, index) => (
        <span
          key={index}
          className="border-background size-3 rounded-full border"
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  );
}

export function SchemePicker({ className }: SchemePickerProps): ReactElement {
  const [scheme, setScheme] = useState<Scheme | null>(null);
  const [theme, setTheme] = useState<Theme | null>(null);
  // The menu tree mounts client-side only: the server renders the styled
  // shell button (the ThemeToggle's documented pattern), the bootstrap
  // owns the class and the attribute before paint, and the portal-mounted
  // menu — with its real state — appears with hydration.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setScheme(currentScheme());
    setTheme(currentTheme());
    const onSchemeChange = () => {
      setScheme(currentScheme());
    };
    const onThemeChange = () => {
      setTheme(currentTheme());
    };
    window.addEventListener(SCHEME_CHANGE_EVENT, onSchemeChange);
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    return () => {
      window.removeEventListener(SCHEME_CHANGE_EVENT, onSchemeChange);
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
    };
  }, []);

  const triggerClassName =
    className ??
    "border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-7 cursor-pointer items-center justify-center rounded-sm border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=open]:bg-muted data-[state=open]:text-foreground";

  if (!mounted) {
    return (
      <button
        aria-label="Color scheme and register"
        className={triggerClassName}
        data-testid="scheme-picker"
        title="Color scheme"
        type="button"
      >
        <Paintbrush aria-hidden="true" className="size-3.5" />
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Color scheme and register"
        className={triggerClassName}
        data-testid="scheme-picker"
        data-scheme-current={scheme}
        title="Color scheme"
        type="button"
      >
        <Paintbrush aria-hidden="true" className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {/* Base UI's menu label is a GROUP label (it associates with its
            parent group), so each label travels with its group. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Color scheme</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value) => {
              applyScheme(value as Scheme);
            }}
            value={scheme ?? "machinist"}
          >
            {SCHEMES.map((entry) => (
              <DropdownMenuRadioItem
                className="gap-2"
                data-testid={`scheme-option-${entry.id}`}
                key={entry.id}
                value={entry.id}
              >
                <SchemeSwatches swatch={entry.swatch} />
                <span className="flex min-w-0 flex-col">
                  <span className="text-foreground text-xs font-medium">
                    {entry.label}
                    {entry.id === "machinist" ? (
                      <span className="text-muted-foreground ml-1.5 font-normal">
                        default
                      </span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground block text-[11px] leading-tight">
                    {entry.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center justify-between">
            Register
            <span className="text-muted-foreground flex items-center gap-1 font-normal">
              {theme === "light" ? (
                <>
                  <Sun aria-hidden="true" className="size-3" /> light
                </>
              ) : (
                <>
                  <Moon aria-hidden="true" className="size-3" /> dark
                </>
              )}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value) => {
              applyTheme(value as Theme);
            }}
            value={theme ?? "dark"}
          >
            <DropdownMenuRadioItem
              className="gap-2"
              data-testid="register-option-dark"
              value="dark"
            >
              <Moon aria-hidden="true" className="size-3.5" />
              Dark
              <span className="text-muted-foreground ml-auto text-[11px]">
                the workshop at night
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem
              className="gap-2"
              data-testid="register-option-light"
              value="light"
            >
              <Sun aria-hidden="true" className="size-3.5" />
              Light
              <span className="text-muted-foreground ml-auto text-[11px]">
                the drafting room
              </span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div
          aria-hidden="true"
          className="text-muted-foreground flex items-center gap-1.5 px-2 py-1.5 text-[11px]"
        >
          <Check aria-hidden="true" className="size-3" />
          Both registers ship for every scheme.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
