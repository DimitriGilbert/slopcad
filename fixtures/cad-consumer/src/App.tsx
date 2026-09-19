/**
 * The consumer's composed page (Phases 16 + 33): one external Vite app
 * exercising EVERY registry category the shadcn CLI installed from the
 * locally generated artifacts —
 *
 * - the plate workbench EXAMPLE (33.3), itself composed of the CAD UI
 *   components (33.1) the example's registryDependencies pulled in;
 * - the NEMA 17 parametric component preview (33.2), consumer-authored
 *   usage of the installed component-contract/kernel/component files,
 *   rendered with real Manifold geometry;
 * - the installed headless TOOLS (33.4), imported and invoked by
 *   `src/consumer/tool-usage.ts` and summarized below.
 */

import type { ReactElement } from "react";

import { PlateWorkbench } from "@/examples/plate-workbench/plate-workbench";
import { ComponentPreview } from "@/consumer/component-preview";
import { INSTALLED_TOOLS } from "@/consumer/tool-usage";

export function App(): ReactElement {
  return (
    <main id="consumer-root" className="mx-auto w-full space-y-8 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">
          slopcad registry consumer — CAD session, components, and tools
        </h1>
        <p className="text-muted-foreground text-sm">
          Every item below was installed through the shadcn CLI from the locally
          generated registry artifacts: the workbench example (with its CAD UI
          components), the NEMA 17 parametric component, and the headless tools.
        </p>
      </header>
      <PlateWorkbench />
      <ComponentPreview />
      <section
        id="installed-tools-root"
        aria-labelledby="installed-tools-heading"
        className="w-full max-w-6xl space-y-2"
      >
        <h2 id="installed-tools-heading" className="text-lg font-semibold">
          Installed headless tools
        </h2>
        <ul className="w-full max-w-3xl space-y-1 font-mono text-xs">
          {INSTALLED_TOOLS.map((tool) => (
            <li key={tool.item} className="flex flex-wrap gap-x-3">
              <span className="font-semibold">{tool.item}</span>
              <span className="text-muted-foreground">{tool.purpose}</span>
              <span data-testid="tool-outcome">{tool.outcome}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
