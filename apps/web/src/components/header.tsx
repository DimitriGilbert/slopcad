/**
 * The app bar: the instrument's title bar, 40px (`--appbar-h`) of chrome
 * that stays out of the way of the surface below it. Brand left (the
 * machinist plate mark and the engraved wordmark), primary destinations
 * next to it, appearance and session right.
 *
 * It is chrome, so it is built from chrome tokens: the frame surface, one
 * hairline rule under it, ink-dim links that brighten on hover, and the
 * current destination marked the way SELECTION is marked everywhere else
 * in the product — the signal edge, no wash and no fill. That keeps the
 * accent's three jobs intact (armed tool, selection, one confirm) instead
 * of spending one on navigation.
 *
 * Routes that carry their own full-width chrome (the docs manual's sticky
 * bar) take over the top of the page; this bar yields to them so the page
 * never stacks two headers or two theme toggles.
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

/**
 * The plate mark: an offset square pair in pure CSS — the wordmark's
 * machined counterpart, drawn at the brand's own scale.
 */
export function PlateMark({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`relative border border-signal/70 bg-signal/15 ${className ?? "size-3.5 rounded-[3px]"}`}
    >
      <span className="absolute -top-[3px] -left-[3px] size-1.5 rounded-[2px] border border-signal" />
    </span>
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
    <header className="h-(--appbar-h) shrink-0 border-b border-rule bg-chrome print:hidden">
      <div className="flex h-full items-center gap-(--gap-group) px-(--pad-panel)">
        <Link
          className="flex items-center gap-2 focus-instrument"
          title="slopcad home"
          to="/"
        >
          <PlateMark />
          <span className="font-display text-title font-semibold text-ink">
            slopcad
          </span>
        </Link>
        <nav
          aria-label="Primary"
          className="hidden items-center gap-(--gap-tight) sm:flex"
        >
          {links.map(({ to, label }) => (
            <Link
              key={to}
              activeOptions={{ exact: to === "/" }}
              className="flex h-(--tool-h) items-center rounded-sm border-b-2 border-b-transparent px-2 text-ui font-medium text-ink-dim transition-colors duration-(--dur-state) ease-(--ease-instrument) hover:bg-well hover:text-ink focus-instrument"
              activeProps={{
                className:
                  "flex h-(--tool-h) items-center rounded-sm border-b-2 border-b-select-edge px-2 text-ui font-medium text-ink focus-instrument",
              }}
              to={to}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-(--gap)">
          <SchemePicker />
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
