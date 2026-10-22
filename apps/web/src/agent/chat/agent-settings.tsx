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
import {
  StatusDot,
  type StatusTone,
} from "@slopcad/ui/components/cockpit/property-row";
import { ToolButton } from "@slopcad/ui/components/cockpit/tool-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@slopcad/ui/components/dialog";
import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";
import type {
  AgentConfig,
  AgentConfigSetResult,
} from "@slopcad/ui/agent/config/store";
import type { AgentCatalogRefresh } from "./workbench-chat-view";
import {
  AGENT_PROVIDER_IDS,
  type AgentProviderId,
} from "@slopcad/ui/agent/providers";
import { listOpenAiCompatibleModels } from "@slopcad/ui/agent/providers/openai-compatible";

import { AgentModelPickerField } from "./agent-model-picker";
import {
  agentSettingsSchema,
  agentSettingsValuesFromConfig,
  apiKeySeedFor,
  createAgentSettingsFields,
  formatContextLimit,
  liveProviderOf,
  modelFamilyOf,
  modelPickerSourceFor,
  namedCatalogProviderOf,
  pickerMirroredRawId,
  resolveSettingsModelId,
  type AgentModelPickerData,
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

  /**
   * The picker's option source + status for the LIVE provider (D14):
   * catalog entries become labelled options (name + id + context size,
   * grouped by the derived family); the BYO endpoint lists bare ids.
   * Failure states are first-class — a catalog query error still serves
   * whatever the cache returned last, marked as the stale list.
   */
  const modelPickerData = useMemo<AgentModelPickerData>(() => {
    const source = modelPickerSourceFor(liveProvider);
    if (source === "endpoint") {
      return {
        emptyText:
          "The endpoint lists no models — re-fetch it or type a raw id in the Model id field.",
        options: endpointModels.map((modelId) => ({
          family: modelFamilyOf("", modelId),
          label: modelId,
          value: modelId,
        })),
        status: endpointListAvailable
          ? endpointModels.length === 0
            ? {
                kind: "empty",
                message:
                  "The endpoint's /models answered nothing usable — type the model id directly.",
              }
            : { kind: "ready" }
          : {
              kind: "error",
              message:
                "The endpoint exposes no usable /models — type the model id directly.",
            },
      };
    }
    const status: AgentModelPickerData["status"] =
      liveProvider === null
        ? { kind: "empty", message: "Pick a provider to load its catalog." }
        : catalogQuery.isPending
          ? { kind: "loading" }
          : catalogQuery.isError
            ? {
                kind: "error",
                message:
                  catalogEntries.length === 0
                    ? "The catalog could not be loaded and nothing is cached — type a raw id or force-refresh."
                    : "The catalog could not be reloaded — showing the last cached list.",
              }
            : catalogEntries.length === 0
              ? {
                  kind: "empty",
                  message:
                    "No models cached for this provider — force-refresh the catalog or type a raw id.",
                }
              : { kind: "ready" };
    return {
      emptyText:
        "No models cached for this provider — force-refresh the catalog or type a raw id.",
      options: catalogEntries.map((entry) => ({
        detail: formatContextLimit(entry.contextLimit),
        family: modelFamilyOf(entry.name, entry.modelId),
        label: entry.name,
        value: entry.modelId,
      })),
      status,
    };
  }, [
    catalogEntries,
    catalogQuery.isError,
    catalogQuery.isPending,
    endpointListAvailable,
    endpointModels,
    liveProvider,
  ]);

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
        modelPickerComponent: AgentModelPickerField,
        modelPickerData,
        reasoningOptionOf,
        serverModeAllowed,
      }),
    [liveProvider, modelPickerData, reasoningOptionOf, serverModeAllowed],
  );

  const defaultValues = useMemo(
    () => agentSettingsValuesFromConfig(config, serverModeAllowed),
    [config, serverModeAllowed],
  );

  const [applyError, setApplyError] = useState<string | null>(null);

  // The values snapshot the form showed BEFORE the change currently being
  // handled: the two cross-field rules in `onChange` below key on WHICH
  // field moved, not on what any value happens to be.
  const previousValuesRef = useRef<AgentSettingsValues>(defaultValues);

  const settingsForm = useFormedible<AgentSettingsValues>({
    fields,
    formOptions: {
      defaultValues,
      onChange: ({ value }) => {
        const previous = previousValuesRef.current;
        previousValuesRef.current = value;
        const nextProvider = liveProviderOf(value.provider);
        // Every in-form provider change re-keys the sheet's catalog
        // plumbing (D14) — the picker, its refresh row, and the
        // reasoning controls follow the selection without a save.
        setLiveProvider(nextProvider);
        // The key field always shows the CHOSEN provider's own stored
        // key (the cross-provider leak fix): an in-form switch reseeds
        // it, so the previous provider's key can never ride the submit
        // into the new provider's config slot.
        if (nextProvider !== liveProviderOf(previous.provider)) {
          settingsForm.form.setFieldValue(
            "apiKey",
            apiKeySeedFor(config, nextProvider),
          );
        }
        // A picker edit must survive Save (the raw-veto fix): the raw id
        // field mirrors every picker change, so the raw-first resolver
        // persists the picked model rather than the stale saved one.
        const mirrored = pickerMirroredRawId(previous.modelId, value.modelId);
        if (mirrored !== null) {
          settingsForm.form.setFieldValue("rawModelId", mirrored);
        }
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
    /**
     * The two-column field grid: every section band spans the row (the
     * Formedible section marker carries the band styling — hairline,
     * well wash, small-caps voice — so the form reads as the cockpit's
     * stacked sections, not a card of floating inputs). `space-y-0`
     * retires the layout default that would misalign grid rows.
     */
    formClassName:
      "grid grid-cols-1 gap-x-(--gap-group) gap-y-4 space-y-0 sm:grid-cols-2 " +
      "[&>[data-formedible-section]]:col-span-full " +
      "[&>[data-formedible-section]]:-mx-(--pad-panel) " +
      "[&>[data-formedible-section]]:border-t [&>[data-formedible-section]]:border-rule " +
      "[&>[data-formedible-section]]:bg-well/60 " +
      "[&>[data-formedible-section]]:px-(--pad-panel) [&>[data-formedible-section]]:py-1 " +
      "[&_[data-formedible-section]>h2]:label-section [&_[data-formedible-section]>h2]:ink-faint " +
      "[&_[data-formedible-section]>p]:text-ui [&_[data-formedible-section]>p]:ink-dim",
    fieldClassName: "min-w-0",
    resetOnSubmitSuccess: false,
    schema: agentSettingsSchema,
    submitButtonClassName:
      "w-full sm:col-span-full sm:w-auto sm:justify-self-end",
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
  // A failed refresh is a first-class outcome, never a silent idle: the
  // handle carries the failure's readable reason and it takes precedence
  // over the (stale, pre-failure) outcome union.
  const refreshFailed = catalogRefresh.error !== null;
  const refreshNote =
    pickerSource === "catalog"
      ? catalogRefresh.isPending
        ? "Refreshing the catalog…"
        : refreshFailed
          ? catalogRefresh.error
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

  // The status band's headline + lamp: the live source's own truth —
  // what's actually in the list right now — with the refresh note riding
  // after it. Nothing here fabricates readiness: a failed catalog load
  // says so, an empty cache says so.
  const statusHeadline =
    pickerSource === "catalog"
      ? catalogQuery.isPending
        ? "Loading the model catalog…"
        : catalogQuery.isError
          ? catalogEntries.length === 0
            ? "The model catalog could not be loaded — nothing cached"
            : `The catalog could not be reloaded — ${String(catalogEntries.length)} cached models shown`
          : catalogEntries.length === 0
            ? "No models cached for this provider"
            : `${String(catalogEntries.length)} models in the cached catalog`
      : pickerSource === "endpoint"
        ? endpointModels.length === 0
          ? "No models discovered on the endpoint"
          : `${String(endpointModels.length)} models discovered on the endpoint`
        : null;
  const statusTone: StatusTone =
    refreshFailed || catalogQuery.isError
      ? "error"
      : catalogQuery.isPending || catalogRefresh.isPending
        ? "parked"
        : pickerSource === "catalog"
          ? catalogEntries.length === 0
            ? "warn"
            : "ok"
          : pickerSource === "endpoint"
            ? !endpointListAvailable
              ? "warn"
              : endpointModels.length === 0
                ? "idle"
                : "ok"
            : "idle";

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
        className="max-h-[calc(100dvh-4rem)] sm:max-w-2xl"
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

        {serverProvidersQuery.isPending && serverProvidersQuery.isFetching ? (
          <p className="text-ui ink-dim" role="status">
            Checking server availability…
          </p>
        ) : null}

        {/* The connection strip: the live source's own status — what the
            picker will actually offer — plus the source's one refresh
            action. The lamp carries tone AND the words say the state, so
            a failure is never colour-only and never silent. */}
        {(pickerSource === "catalog" || pickerSource === "endpoint") && (
          <div
            className="flex min-h-(--row-h) items-center gap-(--gap) rounded-sm border border-rule bg-well px-(--pad-row) py-1"
            data-testid="agent-settings-refresh-row"
          >
            <StatusDot
              label={
                pickerSource === "catalog"
                  ? "catalog status"
                  : "endpoint status"
              }
              tone={statusTone}
            />
            <span className="min-w-0 flex-1 truncate text-ui ink-dim">
              {statusHeadline}
              {refreshNote === null ? null : (
                <span
                  className={` ${
                    refreshFailed ? "text-destructive" : "ink-faint"
                  }`}
                  data-testid={
                    refreshFailed ? "agent-settings-refresh-error" : undefined
                  }
                  role={refreshFailed ? "alert" : undefined}
                >
                  {" — "}
                  {refreshNote}
                </span>
              )}
            </span>
            {pickerSource === "catalog" ? (
              <ToolButton
                aria-label="Force-refresh the model catalog"
                data-testid="agent-settings-refresh-catalog"
                disabled={catalogRefresh.isPending}
                onClick={handleRefreshCatalog}
                size="sm"
              >
                <RefreshCwIcon aria-hidden="true" />
                Refresh
              </ToolButton>
            ) : (
              <ToolButton
                aria-label="Re-fetch the endpoint's model list"
                data-testid="agent-settings-refetch-endpoint"
                onClick={handleRefetchEndpoint}
                size="sm"
              >
                <RefreshCwIcon aria-hidden="true" />
                Re-fetch
              </ToolButton>
            )}
          </div>
        )}

        <settingsForm.Form
          aria-label="Agent settings"
          data-testid="agent-settings-form"
        />

        {applyError === null ? null : (
          <p
            className="text-ui text-destructive"
            data-testid="agent-settings-apply-error"
            role="alert"
          >
            {applyError}
          </p>
        )}

        <p className="text-micro ink-faint leading-snug">
          {MODELS_DEV_ATTRIBUTION}
        </p>
      </DialogContent>
    </Dialog>
  );
}
