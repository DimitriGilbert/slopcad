import {
  Panel,
  PanelBody,
  PanelHeader,
  PanelSection,
} from "@slopcad/ui/components/cockpit/panel";
import {
  PropertyRow,
  Readout,
  StatusDot,
  type StatusTone,
} from "@slopcad/ui/components/cockpit/property-row";
import {
  KeyCap,
  ToolButton,
  ToolGroup,
  ToolValueGroup,
} from "@slopcad/ui/components/cockpit/tool-button";
import type { ReactElement, ReactNode } from "react";

/**
 * The design-system spec sheet: `/design`.
 *
 * Every token and primitive the cockpit is built from, rendered once, in
 * every state, on one page — so the system can be JUDGED (and shot across
 * the four schemes × two registers by `scripts/design-shots.ts`) instead
 * of being asserted in prose. It is a working reference surface for this
 * repo, in the same family as the other developer routes (`/render`,
 * `/io`, `/ui-viewport`), not a marketing page.
 *
 * It renders nothing but the shared primitives and the token utilities:
 * if a swatch below looks wrong in a scheme, the scheme's palette is
 * wrong, because there is no local colour anywhere in this file.
 */

/** One token swatch: the realized surface plus the name to use for it. */
function Swatch({
  name,
  role,
  className,
  frame = false,
}: {
  readonly name: string;
  readonly role: string;
  readonly className: string;
  readonly frame?: boolean;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-(--gap-tight)">
      <div
        data-testid={`swatch-${name}`}
        className={`h-10 rounded-sm ${frame ? "border border-rule" : ""} ${className}`}
      />
      <span className="truncate font-mono text-micro text-ink">{name}</span>
      <span className="truncate text-micro text-ink-faint">{role}</span>
    </div>
  );
}

/** A labelled band of the sheet. Sections are rules, never cards. */
function Block({
  title,
  note,
  children,
}: {
  readonly title: string;
  readonly note: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="flex flex-col gap-(--gap-group) border-t border-rule pt-(--gap-group)">
      <header className="flex flex-col gap-(--gap-tight)">
        <h2 className="label-section text-ink">{title}</h2>
        <p className="max-w-[72ch] text-body text-ink-dim">{note}</p>
      </header>
      {children}
    </section>
  );
}

const TYPE_SPECIMENS: readonly {
  readonly token: string;
  readonly job: string;
  readonly className: string;
}[] = [
  {
    token: "text-title",
    job: "panel and dialog names",
    className: "text-title",
  },
  {
    token: "text-body",
    job: "the only size prose may use",
    className: "text-body",
  },
  {
    token: "text-ui",
    job: "controls, tree rows, menu items",
    className: "text-ui",
  },
  {
    token: "text-data",
    job: "measured values, always tabular mono",
    className: "font-mono text-data tabular",
  },
  { token: "text-label", job: "field labels", className: "text-label" },
  {
    token: "text-micro",
    job: "units, key caps, counts",
    className: "text-micro",
  },
];

const METRICS: readonly {
  readonly token: string;
  readonly value: string;
  readonly job: string;
}[] = [
  { token: "--row-h", value: "24px", job: "tree and property rows" },
  { token: "--control-h", value: "24px", job: "inputs inside a panel" },
  { token: "--tool-h", value: "28px", job: "tool and view buttons" },
  { token: "--header-h", value: "26px", job: "panel and section headers" },
  { token: "--rail-w", value: "240px", job: "a docked rail" },
  { token: "--pad-panel", value: "8px", job: "panel inset" },
  { token: "--pad-row", value: "6px", job: "row inset" },
  { token: "--gap", value: "6px", job: "between controls" },
];

const STATUSES: readonly {
  readonly tone: StatusTone;
  readonly label: string;
}[] = [
  { tone: "ok", label: "valid" },
  { tone: "warn", label: "stale" },
  { tone: "error", label: "failed" },
  { tone: "parked", label: "parked" },
  { tone: "idle", label: "idle" },
];

export function DesignSystemPage(): ReactElement {
  return (
    <main
      id="design-system-root"
      data-testid="design-system"
      className="mx-auto flex max-w-[1180px] flex-col gap-(--gap-group) px-4 py-6"
    >
      <header className="flex flex-wrap items-end justify-between gap-(--gap-group)">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-xl text-ink">Instrument system</h1>
          <p className="max-w-[72ch] text-body text-ink-dim">
            One elevation ramp, one ink ramp, two rule weights, six type sizes
            and a fixed set of control heights. Four schemes and two registers
            reuse all of it — a scheme supplies hue and chroma, never a metric.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-(--gap-group)">
          <Readout label="schemes">4</Readout>
          <Readout label="registers">2</Readout>
          <Readout label="accents">1</Readout>
        </div>
      </header>

      <Block
        title="Surfaces"
        note="Five rungs off the scheme's own background, taken as oklab lightness deltas. Only the step amounts differ between registers; no scheme declares a surface of its own. Overlay is the only rung that carries a shadow, and the shadow is tinted to the scheme, never black."
      >
        <div className="grid grid-cols-3 gap-(--gap-group) sm:grid-cols-6">
          <Swatch
            name="well-deep"
            role="tracks, key caps"
            className="bg-well-deep"
            frame
          />
          <Swatch name="well" role="inset fields" className="bg-well" frame />
          <Swatch name="chrome" role="the frame" className="bg-chrome" frame />
          <Swatch
            name="panel"
            role="a docked face"
            className="bg-panel"
            frame
          />
          <Swatch
            name="panel-raised"
            role="panel over panel"
            className="bg-panel-raised"
            frame
          />
          <Swatch
            name="overlay"
            role="menus, dialogs"
            className="bg-overlay shadow-overlay"
          />
        </div>
      </Block>

      <Block
        title="Ink and rules"
        note="Three steps of one ink family — never a second grey — and exactly two rule weights: a separator and an enclosure. If a boundary needs more emphasis than rule-strong, it needs a surface change instead."
      >
        <div className="flex flex-col gap-(--gap-group)">
          <div className="grid grid-cols-3 gap-(--gap-group)">
            <div className="flex flex-col gap-(--gap-tight)">
              <span className="text-ui text-ink">ink</span>
              <span className="text-micro text-ink-faint">primary text</span>
            </div>
            <div className="flex flex-col gap-(--gap-tight)">
              <span className="text-ui text-ink-dim">ink-dim</span>
              <span className="text-micro text-ink-faint">
                labels and idle controls
              </span>
            </div>
            <div className="flex flex-col gap-(--gap-tight)">
              <span className="text-ui text-ink-faint">ink-faint</span>
              <span className="text-micro text-ink-faint">
                units and counts
              </span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-(--gap-group)">
            <div className="border-t border-rule pt-1.5 text-micro text-ink-faint">
              rule — separates rows and sections
            </div>
            <div className="border-t border-rule-strong pt-1.5 text-micro text-ink-faint">
              rule-strong — encloses a surface
            </div>
          </div>
        </div>
      </Block>

      <Block
        title="Type"
        note="Six sizes with their leading and tracking fixed at the token. Numbers are mono and tabular everywhere they can change, so a live readout never shifts its neighbours. Section headers are small caps — the domain's own vernacular — set small enough to read as a rule rather than as shouting."
      >
        <div className="flex flex-col">
          {TYPE_SPECIMENS.map((specimen) => (
            <div
              key={specimen.token}
              className="grid grid-cols-[8rem_1fr] items-baseline gap-(--gap-group) border-b border-rule/60 py-1.5 last:border-b-0"
            >
              <span className="font-mono text-micro text-ink-faint">
                {specimen.token}
              </span>
              <span className={`${specimen.className} text-ink`}>
                Extrude 12.500 mm — {specimen.job}
              </span>
            </div>
          ))}
        </div>
      </Block>

      <Block
        title="Density"
        note="The cockpit's metrics are tokens, so one edit re-tunes every panel. A 24px row is the unit of the instrument; nothing inside a panel is taller than a 28px tool button."
      >
        <div className="grid grid-cols-2 gap-x-(--gap-group) sm:grid-cols-4">
          {METRICS.map((metric) => (
            <div
              key={metric.token}
              className="flex items-baseline justify-between gap-2 border-b border-rule/60 py-1"
            >
              <span className="font-mono text-micro text-ink">
                {metric.token}
              </span>
              <span className="font-mono text-micro text-ink-dim tabular">
                {metric.value}
              </span>
            </div>
          ))}
        </div>
      </Block>

      <Block
        title="Accent, focus, selection"
        note="One accent, three jobs: the armed tool, the selected entity, and a single confirming action. It never fills a slab, never decorates a heading and never appears twice in one glance. A segmented VALUE is none of the three — exactly one member is always pressed, so the current one is raised out of a well-deep track instead of accented, which is what keeps the armed tool and the selection the only amber marks on a screen. Focus is a 2px outline at a 1px offset — an outline, not a glow — and it is identical on every control in the product."
      >
        <div className="flex flex-wrap items-center gap-(--gap-group)">
          <ToolGroup label="Tool states" separated={false}>
            <ToolButton>Idle</ToolButton>
            <ToolButton aria-pressed aria-keyshortcuts="s">
              Armed
              <KeyCap>S</KeyCap>
            </ToolButton>
            <ToolButton disabled>Unavailable</ToolButton>
            <ToolButton tone="destructive">Delete face</ToolButton>
          </ToolGroup>
          <ToolValueGroup label="Display mode">
            <ToolButton aria-pressed size="sm" tone="value">
              Shaded
            </ToolButton>
            <ToolButton size="sm" tone="value">
              Wire
            </ToolButton>
            <ToolButton size="sm" tone="value">
              Hidden
            </ToolButton>
          </ToolValueGroup>
          <ToolGroup label="View actions">
            <ToolButton size="sm">Fit</ToolButton>
            <ToolButton size="sm">Front</ToolButton>
            <ToolButton size="sm">Iso</ToolButton>
          </ToolGroup>
          <ToolGroup label="Shortcut hints">
            <span className="flex items-center gap-1 text-micro text-ink-faint">
              commands <KeyCap>Ctrl</KeyCap>
              <KeyCap>K</KeyCap>
            </span>
          </ToolGroup>
        </div>
      </Block>

      <Block
        title="Primitives"
        note="A panel is a frame with a name strip and stacked sections; a property row pairs a dim label with a tabular value on one 24px line. Selection is published as state, not only as colour, and a status is never carried by hue alone."
      >
        <div className="grid gap-(--gap-group) lg:grid-cols-[var(--rail-w)_var(--rail-w)_1fr]">
          <Panel>
            <PanelHeader title="Model tree" trailing="3" />
            <PanelBody>
              <PropertyRow label="plate" selected>
                body
              </PropertyRow>
              <PropertyRow label="translate">feature</PropertyRow>
              <PropertyRow label="rotate">feature</PropertyRow>
            </PanelBody>
            <PanelSection title="Measurement">
              <PropertyRow label="Volume" unit="mm³">
                5501.553
              </PropertyRow>
              <PropertyRow label="Surface" unit="mm²">
                2408.274
              </PropertyRow>
            </PanelSection>
          </Panel>

          <Panel>
            <PanelHeader title="Properties" trailing="1" />
            <PanelBody>
              <PropertyRow label="Name">plate</PropertyRow>
              <PropertyRow label="Extent X" unit="mm">
                30.000
              </PropertyRow>
              <PropertyRow label="Extent Y" unit="mm">
                20.000
              </PropertyRow>
              <PropertyRow label="Extent Z" unit="mm">
                10.000
              </PropertyRow>
              <PropertyRow label="Triangles">128</PropertyRow>
            </PanelBody>
          </Panel>

          <div className="flex min-w-0 flex-col gap-(--gap-group)">
            <Panel elevation="overlay">
              <PanelHeader title="Overlay surface" titleAs="h3" />
              <PanelBody inset>
                <p className="text-body text-ink-dim">
                  The only rung with a shadow: menus, the command palette,
                  dialogs. Everything docked stays flat.
                </p>
              </PanelBody>
            </Panel>

            <Panel flush className="bg-viewport p-(--pad-panel)">
              <div className="flex flex-wrap items-center gap-(--gap-group) border border-viewport-rule p-(--pad-panel)">
                <span className="text-micro text-viewport-ink-dim">
                  the viewport is its own surface — it does not follow the
                  register
                </span>
                <span className="flex items-center gap-1.5 bg-viewport-scrim px-1.5 py-0.5">
                  <span className="label-section text-viewport-ink-dim">
                    vol
                  </span>
                  <span className="font-mono text-data text-viewport-ink tabular">
                    5501.553
                  </span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full bg-viewport-select"
                  />
                  <span className="text-micro text-viewport-ink-dim">
                    selection signal, every scheme
                  </span>
                </span>
              </div>
            </Panel>

            <div className="flex flex-wrap items-center gap-(--gap-group)">
              {STATUSES.map((status) => (
                <span
                  key={status.tone}
                  className="flex items-center gap-1.5 text-ui text-ink-dim"
                >
                  <StatusDot tone={status.tone} label={status.label} />
                  {status.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Block>
    </main>
  );
}
