/**
 * The components' semantic-geometry fixtures (Phase 32): the analytic
 * truth every component's build is judged by — volumes and bounds closed
 * over the parameters, kernel-free.
 *
 * Judgement follows the repo's semantic rule (the contract suite's
 * discipline): bounds are exact within the kernel test-utils' default
 * millimetre tolerance (every shipped kernel declares
 * `tightBooleanBounds`, and these components' faces all lie on parameter
 * planes or the cylinder envelopes they document); volumes compare against
 * the analytic formulas within the contract suite's curved band — every
 * component here carries cylinders (bores, holes, bosses), and the mesh
 * kernels discretize circles as inscribed chord polygons, so the curved
 * band is the honest class for all of them (measured on the defaults:
 * NEMA 17 +0.20%, Arduino +0.02%, enclosure shell −0.006% / lid +0.15%).
 *
 * The fixtures are functions of the PUBLIC typed parameter sets, so they
 * judge any conforming kernel through the same execution surface the
 * components build through. The kernel case list the suites run them
 * against lives in `./kernel-cases` (test support; it imports the backend
 * packages, which are devDependencies here).
 */

import type { ComponentParameterValues } from "./component-contract";
import type { ArduinoMountParameters } from "./arduino-mount";
import type { EnclosureParameters } from "./enclosure";
import type { Nema17MountParameters } from "./nema17-mount";

import {
  ARDUINO_MOUNT_DEFINITION,
  ARDUINO_UNO_R3_FOOTPRINT,
} from "./arduino-mount";
import { ENCLOSURE_DEFINITION, deriveEnclosure } from "./enclosure";
import { NEMA17_MOUNT_DEFINITION } from "./nema17-mount";
import { parameterValueOrDefault } from "./component-contract";

/** The analytic area of a rounded rectangle, in mm². */
export function roundedRectAreaMm2(w: number, d: number, r: number): number {
  return w * d - (4 - Math.PI) * r * r;
}

/** The analytic cylinder volume, in mm³. */
export function cylinderVolumeMm3(
  diameterMm: number,
  heightMm: number,
): number {
  return Math.PI * (diameterMm / 2) ** 2 * heightMm;
}

interface AnalyticBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** Analytic truth of the NEMA 17 mount at `p`. */
export function nema17Analytic(p: Nema17MountParameters): {
  readonly volumeMm3: number;
  readonly bounds: AnalyticBounds;
} {
  const totalHeightMm = p.plateThicknessMm + p.bossHeightMm;
  const collarMm3 =
    p.bossHeightMm > 0
      ? cylinderVolumeMm3(p.bossDiameterMm, p.bossHeightMm)
      : 0;
  const volumeMm3 =
    p.plateSizeMm * p.plateSizeMm * p.plateThicknessMm +
    collarMm3 -
    cylinderVolumeMm3(p.boreDiameterMm, totalHeightMm) -
    4 * cylinderVolumeMm3(p.screwHoleDiameterMm, p.plateThicknessMm);
  return {
    bounds: {
      max: [p.plateSizeMm, p.plateSizeMm, totalHeightMm],
      min: [0, 0, 0],
    },
    volumeMm3,
  };
}

/** Analytic truth of the Arduino mount at `p`. */
export function arduinoAnalytic(p: ArduinoMountParameters): {
  readonly volumeMm3: number;
  readonly bounds: AnalyticBounds;
} {
  const widthMm = ARDUINO_UNO_R3_FOOTPRINT.boardWidthMm + 2 * p.marginMm;
  const depthMm = ARDUINO_UNO_R3_FOOTPRINT.boardDepthMm + 2 * p.marginMm;
  const volumeMm3 =
    widthMm * depthMm * p.plateThicknessMm +
    4 * cylinderVolumeMm3(p.standoffDiameterMm, p.standoffHeightMm) -
    4 *
      cylinderVolumeMm3(
        p.boardHoleDiameterMm,
        p.plateThicknessMm + p.standoffHeightMm,
      );
  return {
    bounds: {
      max: [widthMm, depthMm, p.plateThicknessMm + p.standoffHeightMm],
      min: [0, 0, 0],
    },
    volumeMm3,
  };
}

/** Analytic truth of the enclosure at `p` (shell and lid separately). */
export function enclosureAnalytic(p: EnclosureParameters): {
  readonly shellVolumeMm3: number;
  readonly lidVolumeMm3: number;
  readonly shellBounds: AnalyticBounds;
  readonly lidBounds: AnalyticBounds;
} {
  const derived = deriveEnclosure(p);
  const outerAreaMm2 = roundedRectAreaMm2(
    derived.outerWidthMm,
    derived.outerDepthMm,
    derived.outerRadiusMm,
  );
  const innerAreaMm2 = roundedRectAreaMm2(
    p.innerWidthMm,
    p.innerDepthMm,
    derived.innerRadiusMm,
  );
  const lidAreaMm2 = roundedRectAreaMm2(
    derived.lidWidthMm,
    derived.lidDepthMm,
    derived.lidRadiusMm,
  );
  // The cavity cut overshoots past the rim; only the in-shell part removes
  // material — the analytic form subtracts exactly the cavity's clear height.
  const shellVolumeMm3 =
    outerAreaMm2 * derived.outerHeightMm - innerAreaMm2 * p.innerHeightMm;
  const lidVolumeMm3 =
    lidAreaMm2 * p.lidThicknessMm +
    4 * cylinderVolumeMm3(p.bossDiameterMm, p.bossHeightMm) -
    4 *
      cylinderVolumeMm3(
        p.bossPilotDiameterMm,
        p.lidThicknessMm + p.bossHeightMm,
      );
  return {
    lidBounds: {
      max: [derived.lidWidthMm, derived.lidDepthMm, p.lidThicknessMm],
      min: [0, 0, -p.bossHeightMm],
    },
    lidVolumeMm3,
    shellBounds: {
      max: [derived.outerWidthMm, derived.outerDepthMm, derived.outerHeightMm],
      min: [0, 0, 0],
    },
    shellVolumeMm3,
  };
}

/**
 * The analytic per-body volumes of `componentId` at `values` (in the
 * definition's body order), or `undefined` for an unknown id — the
 * registry/preview read-back that judges a build by the closed forms
 * WITHOUT a kernel. The typed parameter sets are constructed through the
 * contract's total metadata view (malformed values read the defaults).
 */
export function componentAnalyticVolumesMm3(
  componentId: string,
  values: ComponentParameterValues,
): readonly number[] | undefined {
  switch (componentId) {
    case "nema17-mount": {
      const value = (name: string): number =>
        parameterValueOrDefault(NEMA17_MOUNT_DEFINITION, values, name);
      return [
        nema17Analytic({
          boreDiameterMm: value("boreDiameterMm"),
          bossDiameterMm: value("bossDiameterMm"),
          bossHeightMm: value("bossHeightMm"),
          holeSpacingMm: value("holeSpacingMm"),
          plateSizeMm: value("plateSizeMm"),
          plateThicknessMm: value("plateThicknessMm"),
          screwHoleDiameterMm: value("screwHoleDiameterMm"),
        }).volumeMm3,
      ];
    }
    case "arduino-uno-mount": {
      const value = (name: string): number =>
        parameterValueOrDefault(ARDUINO_MOUNT_DEFINITION, values, name);
      return [
        arduinoAnalytic({
          boardHoleDiameterMm: value("boardHoleDiameterMm"),
          marginMm: value("marginMm"),
          plateThicknessMm: value("plateThicknessMm"),
          standoffDiameterMm: value("standoffDiameterMm"),
          standoffHeightMm: value("standoffHeightMm"),
        }).volumeMm3,
      ];
    }
    case "electronics-enclosure": {
      const value = (name: string): number =>
        parameterValueOrDefault(ENCLOSURE_DEFINITION, values, name);
      const analytic = enclosureAnalytic({
        bossDiameterMm: value("bossDiameterMm"),
        bossHeightMm: value("bossHeightMm"),
        bossInsetMm: value("bossInsetMm"),
        bossPilotDiameterMm: value("bossPilotDiameterMm"),
        cornerRadiusMm: value("cornerRadiusMm"),
        floorThicknessMm: value("floorThicknessMm"),
        innerDepthMm: value("innerDepthMm"),
        innerHeightMm: value("innerHeightMm"),
        innerWidthMm: value("innerWidthMm"),
        lidFitClearanceMm: value("lidFitClearanceMm"),
        lidThicknessMm: value("lidThicknessMm"),
        wallThicknessMm: value("wallThicknessMm"),
      });
      return [analytic.shellVolumeMm3, analytic.lidVolumeMm3];
    }
    default:
      return undefined;
  }
}
