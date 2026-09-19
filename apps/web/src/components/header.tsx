/**
 * The app chrome: a slim instrument bar that stays out of the way of
 * the surfaces below it. Brand left (the machinist plate: amber mark,
 * engraved lowercase wordmark), primary destinations center, session
 * and the theme switch right. One line at every width that matters,
 * 44px tall — chrome, not a hero.
 */

import { Link } from "@tanstack/react-router";

import UserMenu from "./user-menu";
import { ThemeToggle } from "./theme-toggle";

export default function Header() {
  const links = [
    { to: "/", label: "Home" },
    { to: "/dashboard", label: "Dashboard" },
    { to: "/projects", label: "Projects" },
    { to: "/workbench-complete", label: "Workbench" },
    { to: "/docs", label: "Docs" },
  ] as const;

  return (
    <header className="border-border bg-card/60 h-11 shrink-0 border-b">
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
          <span className="text-foreground font-mono text-sm font-semibold tracking-tight">
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
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
