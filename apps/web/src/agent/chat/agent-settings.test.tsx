/**
 * The agent settings sheet at the component level: the three host-side
 * behaviors the pure `-form` module cannot pin, each closing one verified
 * review finding —
 *
 * - a picker-only model change survives Save (the sheet mirrors the pick
 *   into the raw id field, R1F1);
 * - an in-form provider switch reseeds the key field to the NEW
 *   provider's own stored key, so the previous provider's key can never
 *   ride the submit into the new provider's config slot (R1F2);
 * - a failed catalog refresh renders an error note instead of idling
 *   the refresh row silently (R1F4).
 *
 * The tRPC client is mocked at the `useTRPC` seam: the sheet consumes
 * only `queryOptions` results, so the fake serves the two queries the
 * sheet mounts (server-mode availability, the catalog list) without any
 * network — the runtime fetch guard stays intact.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelReasoningOption } from "@slopcad/db/schema/model-catalog";
import type {
  AgentConfig,
  AgentConfigSetResult,
} from "@slopcad/ui/agent/config/store";
import type { AgentSettingsValues } from "./agent-settings-form";
import type { AgentCatalogRefresh } from "./workbench-chat-view";

import { AgentSettingsSheet } from "./agent-settings";

const testCatalog = vi.hoisted(() => [
  {
    contextLimit: 128000,
    deprecated: false,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    modelId: "test-model-a",
    name: "Test Model A",
    provider: "openai",
    reasoningOptions: null,
    releaseDate: "2026-01-01",
    vision: false,
  },
  {
    contextLimit: 256000,
    deprecated: false,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    modelId: "test-model-b",
    name: "Test Model B",
    provider: "openai",
    reasoningOptions: null,
    releaseDate: "2026-02-01",
    vision: false,
  },
]);

vi.mock("@/utils/trpc", () => ({
  useTRPC: () => ({
    modelCatalog: {
      list: {
        queryOptions: () => ({
          queryFn: () => Promise.resolve(testCatalog),
          queryKey: ["modelCatalog", "list", "test"],
        }),
      },
    },
    serverProviders: {
      queryOptions: () => ({
        queryFn: () => Promise.resolve({ allowed: false }),
        queryKey: ["serverProviders", "test"],
      }),
    },
  }),
}));

afterEach(cleanup);

/** A configured openai agent with keys stored for two providers. */
function configuredConfig(): AgentConfig {
  return {
    apiKeyByProvider: {
      anthropic: "sk-anthropic-stored",
      openai: "sk-openai-stored",
    },
    maxIterations: 5,
    mode: "client",
    modelId: "test-model-a",
    openAiCompatibleBaseUrl: null,
    provider: "openai",
    reasoning: null,
    syncEnabled: false,
    systemPrompt: null,
  };
}

function refreshHandle(
  overrides: Partial<AgentCatalogRefresh> = {},
): AgentCatalogRefresh {
  return {
    error: null,
    isPending: false,
    outcome: null,
    refresh: () => {},
    ...overrides,
  };
}

type ApplySettings = (
  values: AgentSettingsValues,
  reasoningOption: ModelReasoningOption | undefined,
) => AgentConfigSetResult;

/** Renders the open sheet with the mocked queries and returns the spy. */
function renderSheet(
  input: {
    catalogRefresh?: AgentCatalogRefresh;
    config?: AgentConfig;
  } = {},
): ReturnType<typeof vi.fn<ApplySettings>> {
  const onApplySettings = vi.fn<ApplySettings>(() => ({ ok: true }));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AgentSettingsSheet
        catalogRefresh={input.catalogRefresh ?? refreshHandle()}
        config={input.config ?? configuredConfig()}
        finalFocus={{ current: null }}
        onApplySettings={onApplySettings}
        onOpenChange={() => {}}
        open
      />
    </QueryClientProvider>,
  );
  return onApplySettings;
}

/** Reads an input's current value (tests narrow instead of casting). */
function valueOf(field: Element): string {
  if (!(field instanceof HTMLInputElement)) {
    throw new Error("the queried field is not an input");
  }
  return field.value;
}

/**
 * Commits the model option whose label matches through the autocomplete:
 * focus opens the dropdown (minChars is 0), typing re-queries, and the
 * option button's click commits the field value.
 */
async function pickModelOption(search: string, optionLabel: string) {
  const input = screen.getByLabelText("Model");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("the Model field is not an input");
  }
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: search } });
  const option = await screen.findByText(optionLabel);
  fireEvent.click(option);
}

/**
 * Opens the indexed select (in DOM order) and commits the option
 * starting with `optionText` (Base UI commits on REAL mouse clicks only
 * — the pointerdown + click pair, the surface forms' precedent).
 */
async function pickSelectOption(
  triggerIndex: number,
  optionText: string,
): Promise<void> {
  const triggers = [
    ...document.querySelectorAll<HTMLElement>("[data-slot=select-trigger]"),
  ];
  const trigger = triggers[triggerIndex];
  if (trigger === undefined) {
    throw new Error(`the select trigger ${String(triggerIndex)} is absent`);
  }
  fireEvent.click(trigger);
  await waitFor(() => {
    expect(document.querySelector("[data-slot=select-item]")).not.toBeNull();
  });
  const item = [...document.querySelectorAll("[data-slot=select-item]")].find(
    (element) => element.textContent?.startsWith(optionText) === true,
  );
  if (item === undefined) {
    throw new Error(`the select option ${optionText} is absent`);
  }
  fireEvent.pointerDown(item, { pointerType: "mouse" });
  fireEvent.click(item, { detail: 1, pointerType: "mouse" });
}

describe("AgentSettingsSheet (R1F1: a picker-only change survives Save)", () => {
  it("mirrors the pick into the raw id field and persists it on Save", async () => {
    const onApplySettings = renderSheet();

    await pickModelOption("test", "Test Model B");

    // The mirror is visible in the always-typable raw field: the raw id
    // now carries the pick, so the raw-first resolver cannot outvote it.
    expect(valueOf(screen.getByLabelText("Model id"))).toBe("test-model-b");

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(onApplySettings).toHaveBeenCalledTimes(1));
    const [submitted] = onApplySettings.mock.calls[0] ?? [];
    expect(submitted?.modelId).toBe("test-model-b");
    expect(submitted?.rawModelId).toBe("test-model-b");
  });

  it("keeps a hand-typed raw override until the next picker edit", async () => {
    const onApplySettings = renderSheet();

    const rawInput = screen.getByLabelText("Model id");
    fireEvent.change(rawInput, { target: { value: "custom-fine-tune" } });
    // The picker field itself is untouched, so the mirror must not fire
    // and clobber the hand-typed override.

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(onApplySettings).toHaveBeenCalledTimes(1));
    const [submitted] = onApplySettings.mock.calls[0] ?? [];
    expect(submitted?.rawModelId).toBe("custom-fine-tune");
    expect(submitted?.modelId).toBe("test-model-a");
  });
});

describe("AgentSettingsSheet (R1F2: a provider switch reseeds the key field)", () => {
  it("shows the new provider's own stored key and submits it under that provider", async () => {
    const onApplySettings = renderSheet();

    // The prefill: openai's own key, never a mix.
    expect(valueOf(screen.getByLabelText(/api key/i))).toBe("sk-openai-stored");

    // The sheet has two selects (Mode, Provider); the provider is the
    // second.
    await pickSelectOption(1, "Anthropic");

    await waitFor(() => {
      expect(valueOf(screen.getByLabelText(/api key/i))).toBe(
        "sk-anthropic-stored",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(onApplySettings).toHaveBeenCalledTimes(1));
    const [submitted] = onApplySettings.mock.calls[0] ?? [];
    expect(submitted?.provider).toBe("anthropic");
    expect(submitted?.apiKey).toBe("sk-anthropic-stored");
  });
});

describe("AgentSettingsSheet (R1F4: a failed refresh renders its error note)", () => {
  it("renders the handle's failure reason as an alerting note", async () => {
    renderSheet({
      catalogRefresh: refreshHandle({
        error: "The catalog refresh failed: upstream unreachable",
      }),
    });

    const note = await screen.findByTestId("agent-settings-refresh-error");
    expect(note.textContent).toContain("upstream unreachable");
    expect(note.getAttribute("role")).toBe("alert");
  });

  it("renders no note while nothing failed and no outcome is known", () => {
    renderSheet();

    expect(screen.queryByTestId("agent-settings-refresh-error")).toBeNull();
    expect(
      screen.getByTestId("agent-settings-refresh-row").textContent,
    ).not.toContain("failed");
  });
});
