/**
 * The `React integration` guide's runnable example
 * (docs/guides/react.md): the `@slopcad/cad-react` surface — a host-built
 * `CadStore` over the host's own domain instances, mounted through
 * `CadProvider`, read through `useCadParameters` / `useCadDocument`, and
 * edited through the parameter hook's `setValue` (one `parameter.set`
 * transaction through the store's session commit). jsdom renders it; the
 * suite asserts the edit lands and the component re-renders with the new
 * value.
 */

import { useCallback, useState } from "react";
import {
  CadProvider,
  createCadStore,
  useCadDocument,
  useCadParameters,
  type CadStore,
} from "@slopcad/cad-react";
import {
  addBody,
  addDocumentParameter,
  createBodyId,
  createDocument,
  createDocumentId,
  createParameterId,
  createSession,
  length,
  type CadDocument,
  type CadSession,
  type ParameterId,
} from "@slopcad/cad-core";

/** The example's parameter id. */
const HOLE_PARAMETER: ParameterId = createParameterId("param_guide_hole");

/** Builds the example's store over the host's own session. */
export function createGuideStore(): CadStore {
  let document: CadDocument = createDocument(
    createDocumentId("doc_guide_react"),
  );
  const body = addBody(document, {
    id: createBodyId("body_guide_plate"),
    name: "plate",
  });
  if (!body.ok) {
    throw new Error(`The plate body failed: ${body.error.message}`);
  }
  document = body.value.document;
  const parameter = addDocumentParameter(document, {
    id: HOLE_PARAMETER,
    name: "holeDiameter",
    value: length(10),
  });
  if (!parameter.ok) {
    throw new Error(
      `The holeDiameter parameter failed: ${parameter.error.message}`,
    );
  }
  const session: CadSession = createSession(parameter.value.document);
  return createCadStore({ session });
}

/** The example component: reads the parameter, edits it on click. */
export function GuideParameterPanel(): React.JSX.Element {
  const parameters = useCadParameters();
  const document = useCadDocument();
  const [edits, setEdits] = useState(0);
  const hole = parameters.getByName("holeDiameter");
  const onEdit = useCallback(() => {
    if (hole === undefined) return;
    const next = edits + 1;
    const applied = parameters.setValue(hole.id, length(10 + next * 2));
    if (applied.ok) setEdits(next);
  }, [edits, hole, parameters]);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs text-muted-foreground">
          holeDiameter
        </span>
        <output
          data-testid="guide-hole-value"
          className="font-mono text-sm text-foreground"
        >
          {hole === undefined ? "missing" : String(hole.value.value)}
        </output>
        <output data-testid="guide-edits" className="sr-only">
          {String(edits)}
        </output>
        <output data-testid="guide-document-parameters" className="sr-only">
          {String(document.document.parameters.parameters.length)}
        </output>
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="rounded-md border px-3 py-1 font-mono text-xs hover:bg-accent"
      >
        Widen the hole
      </button>
    </div>
  );
}

/** The example's mounted composition (provider + panel). */
export function GuideReactExample(): React.JSX.Element {
  return (
    <CadProvider store={createGuideStore()}>
      <GuideParameterPanel />
    </CadProvider>
  );
}
