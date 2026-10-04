/**
 * The app chrome: a slim instrument bar that stays out of the way of
 * the surfaces below it. Brand left (the machinist plate: amber mark,
 * engraved lowercase wordmark), primary destinations center, session
 * and the theme switch right. One line at every width that matters,
 * 44px tall — chrome, not a hero.
 *
 * Routes that carry their own full-width chrome (the docs manual's
 * sticky bar: brand, section jumps, theme toggle) take over the top of
 * the page; this bar yields to them so the page never stacks two
 * headers or two theme toggles.
 */

import { Link, useLocation } from "@tanstack/react-router";

import UserMenu from "./user-menu";
import { SchemePicker } from "./scheme-picker";
import { ThemeToggle } from "./theme-toggle";

/** Route prefixes that own their top chrome (no app bar above them). */
const SELF_CHROMED_ROUTES = ["/docs"] as const;

/**
 * The viewer route's embed flag: `/viewer?embed=1` is the iframe target —
 * the embeddable share surface ships without the site bar so the host page
 * frames the instrument, not the site. Flag-scoped, not path-scoped: the
 * ordinary /viewer share page keeps the full chrome. The router hands the
 * search in parsed object form and its default parser may realize the
 * flag as either the string or the number `1`; the /viewer route's own
 * search validator realizes it as a boolean. All are the one flag.
 */
function embeddedViewer(pathname: string, search: unknown): boolean {
  if (pathname !== "/viewer") return false;
  if (typeof search === "string") {
    return new URLSearchParams(search).get("embed") === "1";
  }
  return (
    typeof search === "object" &&
    search !== null &&
    "embed" in search &&
    (search.embed === "1" || search.embed === 1 || search.embed === true)
  );
}

export default function Header() {
  const location = useLocation();
  const selfChromed = SELF_CHROMED_ROUTES.some((prefix) =>
    location.pathname.startsWith(prefix),
  );
  if (selfChromed) return null;
  if (embeddedViewer(location.pathname, location.search)) return null;

  const links = [
    { to: "/", label: "Home" },
    { to: "/dashboard", label: "Dashboard" },
    { to: "/projects", label: "Projects" },
    { to: "/workbench-complete", label: "Workbench" },
    { to: "/docs", label: "Docs" },
  ] as const;

  return (
    <header className="border-border bg-card/60 h-11 shrink-0 border-b print:hidden">
      <div className="flex h-full items-center gap-6 px-4">
        <Link
          className="group flex items-center gap-2.5"
          title="slopcad home"
          to="/"
        >
          {/* The machinist plate mark: an offset square pair, pure CSS. */}
          <span
            aria-hidden="true"
            className="border-primary/70 bg-primary/15 relative size-3.5 rounded-[3px] border"
          >
            <span className="border-primary absolute -top-[3px] -left-[3px] size-1.5 rounded-[2px] border" />
          </span>
          <span className="font-display text-foreground text-sm font-semibold tracking-tight">
            slopcad
          </span>
        </Link>
        <nav aria-label="Primary" className="hidden items-center gap-1 sm:flex">
          {links.map(({ to, label }) => (
            <Link
              key={to}
              activeOptions={{ exact: to === "/" }}
              className="text-muted-foreground hover:text-foreground hover:bg-muted rounded-sm px-2.5 py-1 text-[13px] font-medium transition-colors"
              activeProps={{
                className:
                  "text-foreground bg-muted rounded-sm px-2.5 py-1 text-[13px] font-medium",
              }}
              to={to}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <SchemePicker />
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
