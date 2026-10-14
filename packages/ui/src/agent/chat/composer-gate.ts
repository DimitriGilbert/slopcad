/**
 * The composer's disabled-with-reason gate (PLAN-AGENT-CHAT Phase 4.4,
 * D5): the pure derivation of WHY the composer blocks sending until the
 * agent is configured. It mirrors, field by field, the refusal reasons
 * the Phase 3.3 runtime hook's transports raise
 * (`AgentChatUnconfiguredError` in `../use-agent-chat`) — the composer
 * never lets the user reach a send the transport would refuse:
 *
 * - no provider chosen → blocked (nothing is ever preselected);
 * - no model chosen → blocked;
 * - client mode without the chosen provider's key → blocked (the key is
 *   stored only in this browser, D1);
 * - client mode on the openai-compatible provider without an endpoint
 *   base URL → blocked (D14);
 * - server mode needs only provider + model locally — access is enforced
 *   by the relay (D13) and any denial surfaces as the run's error, never
 *   silently.
 *
 * Also derives the composer's model-slot label: the current provider +
 * model summary the host renders next to the send button.
 */

import { isAgentConfigured, type AgentConfig } from "../config/store";

/** The gate's verdict: `reason` is the user-facing why whenever blocked. */
export interface AgentComposerGate {
  readonly disabled: boolean;
  readonly reason: string | null;
}

/** The enabled verdict (no reason to show). */
const OPEN_GATE: AgentComposerGate = { disabled: false, reason: null };

/** Derives the composer gate from the live agent config (D5). */
export function agentComposerGate(config: AgentConfig): AgentComposerGate {
  if (isAgentConfigured(config)) {
    if (config.mode === "client") {
      if (config.apiKeyByProvider[config.provider] === undefined) {
        return {
          disabled: true,
          reason: `Add the ${config.provider} API key in agent settings — it is stored only in this browser.`,
        };
      }
      if (
        config.provider === "openai-compatible" &&
        config.openAiCompatibleBaseUrl === null
      ) {
        return {
          disabled: true,
          reason:
            "Set the openai-compatible endpoint URL in agent settings before sending.",
        };
      }
    }
    return OPEN_GATE;
  }
  if (config.provider === null) {
    return {
      disabled: true,
      reason:
        "Pick a provider and a model in agent settings — nothing is preselected.",
    };
  }
  return {
    disabled: true,
    reason: "Pick a model in agent settings — nothing is preselected.",
  };
}

/**
 * The model-slot label: the current provider + model summary (the host's
 * settings opener renders it; the composer itself owns no model state).
 * Unconfigured halves degrade honestly — "no provider" / "no model".
 */
export function agentModelSummary(config: AgentConfig): string {
  if (config.provider === null) {
    return "Agent: not configured";
  }
  if (config.modelId === null) {
    return `Agent: ${config.provider} · no model`;
  }
  return `Agent: ${config.provider} · ${config.modelId}`;
}
