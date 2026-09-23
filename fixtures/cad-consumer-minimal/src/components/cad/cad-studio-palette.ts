import { useEffect, useState } from "react";
import {
  CAD_SCENE_AXIS_X_COLOR,
  CAD_SCENE_AXIS_Y_COLOR,
  CAD_SCENE_AXIS_Z_COLOR,
  CAD_SCENE_BACKGROUND,
  CAD_SCENE_GRID_CENTER_COLOR,
  CAD_SCENE_GRID_COLOR,
  CAD_SCENE_ORIGIN_MARKER_COLOR,
  type CadScenePalette,
} from "@slopcad/cad-r3f";

type Mode = "dark" | "light";
type SchemeId = "machinist" | "drafting" | "studios" | "ember";

const AXIS_DEFAULTS = {
  axisX: CAD_SCENE_AXIS_X_COLOR,
  axisY: CAD_SCENE_AXIS_Y_COLOR,
  axisZ: CAD_SCENE_AXIS_Z_COLOR,
} as const;

/** Machinist: the Machinist night-bed constants in both registers. */
const CAD_STUDIO_PALETTE_MACHINIST: CadScenePalette = Object.freeze({
  background: CAD_SCENE_BACKGROUND,
  gridMinor: CAD_SCENE_GRID_COLOR,
  gridMajor: CAD_SCENE_GRID_CENTER_COLOR,
  ...AXIS_DEFAULTS,
  originMarker: CAD_SCENE_ORIGIN_MARKER_COLOR,
  model: "#aabdd6",
});

/** Drafting Room dark: blueprint ink; a warm paper-silver model. */
const CAD_STUDIO_PALETTE_DRAFTING_DARK: CadScenePalette = Object.freeze({
  background: "#0e1219",
  gridMinor: "#232a37",
  gridMajor: "#323b4c",
  ...AXIS_DEFAULTS,
  originMarker: "#c9c4b8",
  model: "#e0dacd",
});

/** Drafting Room light: warm vellum; the model is warm graphite ink. */
const CAD_STUDIO_PALETTE_DRAFTING_LIGHT: CadScenePalette = Object.freeze({
  background: "#e9e6df",
  gridMinor: "#cbc6ba",
  gridMajor: "#b8b2a4",
  axisX: "#a8433a",
  axisY: "#41795a",
  axisZ: "#46609c",
  originMarker: "#6b665c",
  model: "#47423b",
});

/** Studios dark: the night studio; a deliberately bright silver model. */
const CAD_STUDIO_PALETTE_STUDIOS_DARK: CadScenePalette = Object.freeze({
  background: "#12151b",
  gridMinor: "#262b36",
  gridMajor: "#343b49",
  axisX: "#d97e6d",
  axisY: "#6fae83",
  axisZ: "#7b93c9",
  originMarker: "#99a2b1",
  model: "#e2e7ef",
});

/** Studios light: the daylight table; the model is graphite ink. */
const CAD_STUDIO_PALETTE_STUDIOS_LIGHT: CadScenePalette = Object.freeze({
  background: "#eceef2",
  gridMinor: "#c7cbd4",
  gridMajor: "#b2b8c4",
  axisX: "#b0493f",
  axisY: "#3e7d59",
  axisZ: "#3f5e9e",
  originMarker: "#5d6673",
  model: "#434a57",
});

/** Ember dark: the navy chamber; the model is machined steel. */
const CAD_STUDIO_PALETTE_EMBER_DARK: CadScenePalette = Object.freeze({
  background: "#111827",
  gridMinor: CAD_SCENE_GRID_COLOR,
  gridMajor: CAD_SCENE_GRID_CENTER_COLOR,
  ...AXIS_DEFAULTS,
  originMarker: CAD_SCENE_ORIGIN_MARKER_COLOR,
  model: "#889098",
});

/**
 * Ember light: the daylight chamber. The grid keeps the scheme's shipped
 * line weights (dark lead on the chamber); the origin marker is re-inked
 * to a value the light chamber can actually show (the shipped light gray
 * would have disappeared on it).
 */
const CAD_STUDIO_PALETTE_EMBER_LIGHT: CadScenePalette = Object.freeze({
  background: "#e3e7ea",
  gridMinor: CAD_SCENE_GRID_COLOR,
  gridMajor: CAD_SCENE_GRID_CENTER_COLOR,
  ...AXIS_DEFAULTS,
  originMarker: "#5d6673",
  model: "#889098",
});

/** The eight palettes: one per scheme per register, identity-stable. */
const SCENE_PALETTES: Readonly<
  Record<SchemeId, Readonly<Record<Mode, CadScenePalette>>>
> = Object.freeze({
  machinist: Object.freeze({
    dark: CAD_STUDIO_PALETTE_MACHINIST,
    light: CAD_STUDIO_PALETTE_MACHINIST,
  }),
  drafting: Object.freeze({
    dark: CAD_STUDIO_PALETTE_DRAFTING_DARK,
    light: CAD_STUDIO_PALETTE_DRAFTING_LIGHT,
  }),
  studios: Object.freeze({
    dark: CAD_STUDIO_PALETTE_STUDIOS_DARK,
    light: CAD_STUDIO_PALETTE_STUDIOS_LIGHT,
  }),
  ember: Object.freeze({
    dark: CAD_STUDIO_PALETTE_EMBER_DARK,
    light: CAD_STUDIO_PALETTE_EMBER_LIGHT,
  }),
});

/**
 * The palette for a resolved scheme + register. The server (and any host
 * that has not applied the bootstrap yet) resolves to Machinist dark —
 * the default world the render harnesses pin, so their bytes are stable.
 */
export function resolveCadStudioPalette(
  scheme: SchemeId,
  isDark: boolean,
): CadScenePalette {
  return SCENE_PALETTES[scheme][isDark ? "dark" : "light"];
}

function initialScheme(): SchemeId {
  if (typeof document === "undefined") return "machinist";
  const value = document.documentElement.getAttribute("data-scheme");
  return value === "drafting" || value === "studios" || value === "ember"
    ? value
    : "machinist";
}

function initialIsDark(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.classList.contains("dark");
}

/** The studio palette for the document's CURRENT scheme + register, live-updating. */
export function useCadStudioPalette(): CadScenePalette {
  const [scheme, setScheme] = useState<SchemeId>(initialScheme);
  const [isDark, setIsDark] = useState(initialIsDark);
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setScheme(initialScheme());
      setIsDark(root.classList.contains("dark"));
    });
    observer.observe(root, { attributeFilter: ["class", "data-scheme"] });
    return () => {
      observer.disconnect();
    };
  }, []);
  return resolveCadStudioPalette(scheme, isDark);
}
