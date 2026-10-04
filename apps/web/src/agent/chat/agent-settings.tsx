/**
 * The agent settings sheet (PLAN-AGENT-CHAT Phase 4.5): the Formedible
 * form from `./agent-settings-form` rendered inside a dialog, plus the
 * host-side affordances the field list cannot express — the catalog
 * force-refresh (D7) / endpoint re-fetch button and the models.dev MIT
 * footnote.
 *
 * The form itself is pure config: the schema, field list, and value
 * mappings live in the sibling `-form` module (node-tested there); this
 * component only binds the runtime inputs — `serverProviders()` for the
 * mode option (D13), `modelCatalog.list` for the four named providers'
 * picker (D14), and the BYO-endpoint `/models` fetch for
 * `openai-compatible` (D14) — and hands the submitted values to the
 * host's `onApplySettings`, which owns the config store write.
 *
 * The catalog plumbing keys on the form's LIVE provider selection (D14),
 * not the saved config's: the picker's option source, the refresh row,
 * and the reasoning controls all follow what the open sheet selects, so
 * a first-time configuration works before any Save (D5's fallback —
 * nothing chosen, nothing fetched — is the empty state with a hint).
 *
 * Mounts ONLY while open (the io dialogs' `if (!open) return null`
 * discipline): a closed Base UI dialog never enters the server-rendered
 * tree, and the catalog/provider queries run only while the sheet is
 * open. Both queries tolerate the unauthenticated workbench example —
 * the protected procedures answer errors, the sheet degrades to
 * "no models cached" with the raw id input always present (D5).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ModelReasoningOption } from "@slopcad/db/schema/model-catalog";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@slopcad/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@slopcad/ui/components/dialog";
import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";
import type { AgentConfig } from "../config/store";
import type { AgentConfigSetResult } from "../config/store";
import type { AgentCatalogRefresh } from "./workbench-chat-view";

import { AGENT_PROVIDER_IDS, type AgentProviderId } from "../providers";
import { listOpenAiCompatibleModels } from "../providers/openai-compatible";
import {
  agentSettingsSchema,
  agentSettingsValuesFromConfig,
  createAgentSettingsFields,
  liveProviderOf,
  modelPickerSourceFor,
  namedCatalogProviderOf,
  resolveSettingsModelId,
  type AgentSettingsValues,
} from "./agent-settings-form";

import { useTRPC } from "@/utils/trpc";

/** The models.dev attribution the catalog data carries (D7/MIT). */
const MODELS_DEV_ATTRIBUTION = "Model data from models.dev (MIT License).";

export interface AgentSettingsSheetProps {
  /** True while the sheet should render (the host mounts on it). */
  readonly open: boolean;
  /** Closes the sheet (Escape/backdrop/close button route here too). */
  readonly onOpenChange: (open: boolean) => void;
  /** The live agent config (the remembered defaults, D5). */
  readonly config: AgentConfig;
  /**
   * Receives a submitted settings form: maps values + the resolved
   * reasoning option into a config-store patch, persists, and returns
   * the store's honest write result (a failed write keeps the sheet
   * open with the reason shown).
   */
  readonly onApplySettings: (
    values: AgentSettingsValues,
    reasoningOption: ModelReasoningOption | undefined,
  ) => AgentConfigSetResult;
  /** The shared catalog force-refresh (D7) — the chat view's one handle. */
  readonly catalogRefresh: AgentCatalogRefresh;
  /**
   * Where focus lands when the sheet closes (the io dialogs' discipline:
   * the opener is captured at open time because it varies — the empty
   * state's button, the composer's model slot, the palette command).
   */
  readonly finalFocus: RefObject<HTMLElement | null>;
}

export function AgentSettingsSheet({
  catalogRefresh,
  config,
  finalFocus,
  onApplySettings,
  onOpenChange,
  open,
}: AgentSettingsSheetProps): ReactElement | null {
  const trpc = useTRPC();

  // Server mode's availability (D13): allowed only when the query says so.
  // The workbench example runs unauthenticated — the query then errors and
  // the client-only mode is the honest answer.
  const serverProvidersQuery = useQuery(
    trpc.serverProviders.queryOptions(undefined, { retry: false }),
  );
  const serverModeAllowed = serverProvidersQuery.data?.allowed === true;

  // The LIVE provider selection (D14): what the open form's provider
  // select holds right now, not the saved config's provider — a
  // first-time configuration gets a working picker, refresh row, and
  // reasoning controls before any Save. The form's `onChange` keeps the
  // state in step; the initial value is the form's own default (the
  // remembered provider, if any).
  const [liveProvider, setLiveProvider] = useState<AgentProviderId | null>(
    config.provider,
  );

  // The catalog cache for the LIVE named provider (D14) — the same query
  // the chat view's reasoning lookup rides, deduped by key. The
  // disabled-state input is the canonical list's first id (never a
  // hand-picked provider): the query never runs without a named provider.
  const namedProvider = namedCatalogProviderOf(liveProvider);
  const catalogQuery = useQuery(
    trpc.modelCatalog.list.queryOptions(
      { provider: namedProvider ?? AGENT_PROVIDER_IDS[0] },
      { enabled: namedProvider !== null, retry: false },
    ),
  );
  const catalogEntries = useMemo(
    () => (namedProvider === null ? [] : (catalogQuery.data ?? [])),
    [catalogQuery.data, namedProvider],
  );

  // The BYO-endpoint provider's own /models list (D14), fetched on demand.
  const [endpointModels, setEndpointModels] = useState<readonly string[]>([]);
  const [endpointListAvailable, setEndpointListAvailable] = useState(true);

  /** The reasoning option of the model the CURRENT values name. */
  const reasoningOptionOf = useCallback(
    (values: AgentSettingsValues): ModelReasoningOption | undefined => {
      // The lookup rides the form's LIVE provider (D14): while the
      // catalog entries belong to a different provider's query — a
      // switch still fetching, or the BYO endpoint — nothing is offered.
      if (liveProviderOf(values.provider) !== namedProvider) {
        return undefined;
      }
      const modelId = resolveSettingsModelId(values);
      if (modelId === null) {
        return undefined;
      }
      const options = catalogEntries.find(
        (entry) => entry.modelId === modelId,
      )?.reasoningOptions;
      return options === null || options === undefined ? undefined : options[0];
    },
    [catalogEntries, namedProvider],
  );

  const fields = useMemo(
    () =>
      createAgentSettingsFields({
        liveProvider,
        modelAsyncOptions: (query, pickerProvider) => {
          const source = modelPickerSourceFor(pickerProvider);
          const lowered = query.toLowerCase();
          if (source === "endpoint") {
            return Promise.resolve(
              endpointModels
                .filter((modelId) => modelId.toLowerCase().includes(lowered))
                .map((modelId) => ({ label: modelId, value: modelId })),
            );
          }
          if (source === "catalog") {
            return Promise.resolve(
              catalogEntries
                .filter(
                  (entry) =>
                    entry.modelId.toLowerCase().includes(lowered) ||
                    entry.name.toLowerCase().includes(lowered),
                )
                // The renderer shows the label with the committed id
                // beneath it, so the human name labels and the id stays
                // in reach.
                .map((entry) => ({
                  label: entry.name,
                  value: entry.modelId,
                })),
            );
          }
          return Promise.resolve([]);
        },
        reasoningOptionOf,
        serverModeAllowed,
      }),
    [
      catalogEntries,
      endpointModels,
      liveProvider,
      reasoningOptionOf,
      serverModeAllowed,
    ],
  );

  const defaultValues = useMemo(
    () => agentSettingsValuesFromConfig(config, serverModeAllowed),
    [config, serverModeAllowed],
  );

  const [applyError, setApplyError] = useState<string | null>(null);

  const settingsForm = useFormedible<AgentSettingsValues>({
    fields,
    formOptions: {
      defaultValues,
      onChange: ({ value }) => {
        // Every in-form provider change re-keys the sheet's catalog
        // plumbing (D14) — the picker, its refresh row, and the
        // reasoning controls follow the selection without a save.
        setLiveProvider(liveProviderOf(value.provider));
      },
      onSubmit: ({ value }) => {
        const result = onApplySettings(value, reasoningOptionOf(value));
        if (result.ok) {
          setApplyError(null);
          onOpenChange(false);
          return;
        }
        // A failed store write is never fake success: the sheet stays
        // open and the reason reads inline (quota, private mode).
        setApplyError(
          "The settings could not be saved in this browser — the changes apply only until reload.",
        );
      },
    },
    resetOnSubmitSuccess: false,
    schema: agentSettingsSchema,
    submitLabel: "Save settings",
  });

  /** Force-refreshes the catalog cache for the chosen named provider (D7). */
  const handleRefreshCatalog = useCallback(() => {
    if (namedProvider === null) {
      return;
    }
    catalogRefresh.refresh(namedProvider);
  }, [catalogRefresh, namedProvider]);

  /** Re-fetches the BYO endpoint's own /models list (D14). */
  const handleRefetchEndpoint = useCallback(() => {
    // The live form values win: an endpoint typed this session should be
    // listable before it is saved.
    const values = settingsForm.form.state.values;
    const baseUrl =
      values.provider === "openai-compatible"
        ? values.openAiCompatibleBaseUrl.trim()
        : (config.openAiCompatibleBaseUrl ?? "");
    if (baseUrl === "") {
      return;
    }
    const apiKey =
      values.provider === "openai-compatible"
        ? values.apiKey.trim()
        : (config.apiKeyByProvider["openai-compatible"] ?? "");
    void listOpenAiCompatibleModels({ apiKey, baseURL: baseUrl }).then(
      (listing) => {
        setEndpointModels(listing.models);
        setEndpointListAvailable(listing.listAvailable);
      },
    );
  }, [config.apiKeyByProvider, config.openAiCompatibleBaseUrl, settingsForm]);

  // The endpoint list is session state (never persisted), so an
  // openai-compatible configuration re-fetches once when the sheet opens —
  // the remembered provider then has a populated picker without a click.
  // The ref makes it mount-scoped; the re-fetch button serves later edits.
  const endpointFetchOnceRef = useRef(false);
  useEffect(() => {
    if (
      endpointFetchOnceRef.current ||
      config.provider !== "openai-compatible"
    ) {
      return;
    }
    endpointFetchOnceRef.current = true;
    handleRefetchEndpoint();
  }, [config.provider, handleRefetchEndpoint]);

  if (!open) {
    return null;
  }

  const pickerSource = modelPickerSourceFor(liveProvider);
  const refreshNote =
    pickerSource === "catalog"
      ? catalogRefresh.isPending
        ? "Refreshing the catalog…"
        : catalogRefresh.outcome === null
          ? null
          : catalogRefresh.outcome === "refetched"
            ? "Catalog refetched."
            : catalogRefresh.outcome === "not-modified"
              ? "Catalog unchanged upstream."
              : catalogRefresh.outcome === "stale-served"
                ? "Upstream unavailable — kept the cached entries."
                : "Catalog already fresh."
      : pickerSource === "endpoint"
        ? endpointListAvailable
          ? null
          : "The endpoint exposes no usable /models — type the model id below."
        : null;

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onOpenChange(false);
        }
      }}
      open
    >
      <DialogContent
        className="max-h-[calc(100dvh-4rem)] sm:max-w-md"
        data-testid="agent-settings-dialog"
        finalFocus={finalFocus}
      >
        <DialogHeader>
          <DialogTitle>Agent settings</DialogTitle>
          <DialogDescription>
            Pick a provider and a model — nothing is preselected, and your key
            stays in this browser.
          </DialogDescription>
        </DialogHeader>

        {(pickerSource === "catalog" || pickerSource === "endpoint") && (
          <div
            className="flex items-center gap-2"
            data-testid="agent-settings-refresh-row"
          >
            {pickerSource === "catalog" ? (
              <Button
                aria-label="Force-refresh the model catalog"
                data-testid="agent-settings-refresh-catalog"
                disabled={catalogRefresh.isPending}
                onClick={handleRefreshCatalog}
                size="xs"
                type="button"
                variant="outline"
              >
                <RefreshCwIcon />
                Force-refresh catalog
              </Button>
            ) : (
              <Button
                aria-label="Re-fetch the endpoint's model list"
                data-testid="agent-settings-refetch-endpoint"
                onClick={handleRefetchEndpoint}
                size="xs"
                type="button"
                variant="outline"
              >
                <RefreshCwIcon />
                Re-fetch models
              </Button>
            )}
            {refreshNote === null ? null : (
              <span className="text-muted-foreground min-w-0 text-xs">
                {refreshNote}
              </span>
            )}
          </div>
        )}

        {serverProvidersQuery.isPending && serverProvidersQuery.isFetching ? (
          <p className="text-muted-foreground text-xs" role="status">
            Checking server availability…
          </p>
        ) : null}

        <settingsForm.Form
          aria-label="Agent settings"
          className="space-y-3"
          data-testid="agent-settings-form"
        />

        {applyError === null ? null : (
          <p
            className="text-destructive text-xs"
            data-testid="agent-settings-apply-error"
            role="alert"
          >
            {applyError}
          </p>
        )}

        <p className="text-muted-foreground text-[11px] leading-snug">
          {MODELS_DEV_ATTRIBUTION}
        </p>
      </DialogContent>
    </Dialog>
  );
}
