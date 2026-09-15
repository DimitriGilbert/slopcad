/**
 * Phase 1.6 architecture spike — NON-PRODUCTION reference code.
 * The /spike route body: parameter inputs → worker evaluation → CadScene.
 * See docs/architecture/spike-findings.md.
 */

import { useEffect, useRef, useState } from "react";
import type { CadEvalResult } from "./protocol";

import { plateDocument } from "./plate-document";
import { CadWorkerClient } from "./cad-client";
import { CadScene } from "./CadScene";

interface SpikeState {
  readonly result: CadEvalResult | undefined;
  readonly error: string | undefined;
}

export function SpikePage() {
  const [mounted, setMounted] = useState(false);
  const [values, setValues] = useState<Record<string, number>>({
    ...plateDocument.defaultValues,
  });
  const [state, setState] = useState<SpikeState>({
    result: undefined,
    error: undefined,
  });
  const clientRef = useRef<CadWorkerClient | null>(null);

  useEffect(() => {
    setMounted(true);
    const client = new CadWorkerClient();
    clientRef.current = client;
    return () => {
      client.dispose();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!clientRef.current) {
      return;
    }
    let cancelled = false;
    clientRef.current.evaluate(values).then(
      (result) => {
        if (!cancelled) {
          setState({ result, error: undefined });
        }
      },
      (error: Error) => {
        if (!cancelled) {
          setState({ result: undefined, error: error.message });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [values, mounted]);

  const result = state.result;

  return (
    <div
      id="spike-root"
      className="mx-auto flex w-full max-w-6xl gap-6 p-6"
      data-cad-rendered-volume=""
    >
      <div className="w-72 shrink-0 space-y-4">
        <h1 className="text-lg font-semibold">Phase 1.6 Architecture Spike</h1>
        <p className="text-muted-foreground text-sm">
          Non-production reference pipeline: parameters → box → subtract →
          Manifold WASM worker → R3F.
        </p>
        {Object.entries(plateDocument.parameters).map(([name, spec]) => (
          <label key={name} className="block text-sm" htmlFor={`param-${name}`}>
            <span className="mb-1 block font-medium">
              {name} ({spec.unit})
            </span>
            <input
              id={`param-${name}`}
              className="border-input bg-background w-full rounded border px-2 py-1 font-mono"
              type="number"
              min={spec.min}
              max={spec.max}
              step={spec.step}
              value={values[name] ?? spec.default}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                if (Number.isFinite(parsed)) {
                  setValues((prev) => ({ ...prev, [name]: parsed }));
                }
              }}
            />
          </label>
        ))}
        <ul className="space-y-1 font-mono text-xs" id="spike-stats">
          <li>
            volume ={" "}
            <span id="spike-volume">
              {result ? result.volume.toFixed(3) : "…"}
            </span>
            {"\u00A0"}mm³
          </li>
          <li>
            bounds ={" "}
            <span id="spike-bounds">
              {result
                ? dimensionsOf(result)
                    .map((d) => d.toFixed(3))
                    .join(" × ")
                : "…"}
            </span>
            {"\u00A0"}mm
          </li>
          <li>
            triangles ={" "}
            <span id="spike-triangles">
              {result ? result.triangleCount : "…"}
            </span>
          </li>
          <li data-testid="spike-error" className="text-red-500">
            {state.error ?? ""}
          </li>
        </ul>
      </div>
      <div className="h-[560px] flex-1 border">
        {mounted && result ? (
          <CadScene mesh={result.mesh} volume={result.volume} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm">
            evaluating…
          </div>
        )}
      </div>
    </div>
  );
}

function dimensionsOf(result: CadEvalResult): [number, number, number] {
  return [
    result.boundsMax[0] - result.boundsMin[0],
    result.boundsMax[1] - result.boundsMin[1],
    result.boundsMax[2] - result.boundsMin[2],
  ];
}
