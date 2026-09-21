/**
 * The unified, model-agnostic surface over everything the plugin knows
 * about an LLM provider family. Upper layers consume
 * `LLM_FAMILIES[provider]` and never branch on a family name again:
 *
 * - limits / menu options / defaults / reserve budgets are served by the
 *   capability layer (registry entries first, then the registry's
 *   familyFallbacks section for models no entry matches);
 * - encoding is one encoder per family, chosen by table: the generic
 *   encoder translates registry controls (shared by every declarative
 *   family), while qwen and anthropic carry custom encoders for the logic
 *   a data file cannot express (host forks, mode negotiation, budget
 *   clamps). How an encoder produces its fields is its own business.
 */

import {
  compileReasoningControls,
  getModelCapabilities,
  getModelReasoningDefaultLevel,
  getReasoningOptionReserveTokens,
  getRuntimeReasoningOptions,
} from "../modelCapabilities";
import type {
  ModelCapabilityIdentity,
  ModelCapabilityLimits,
  ReasoningCapabilityOption,
} from "../modelCapabilities/types";
import type { ModelProfileOverride } from "../modelCapabilities/profileOverride";
import { ALL_REASONING_PROVIDERS, type ReasoningProvider } from "./provider";
import type { ProviderProtocol } from "./providerProtocol";
import { anthropicAdapter } from "./reasoning/anthropic";
import { qwenAdapter } from "./reasoning/qwen";
import {
  emptyReasoningPayload,
  type AnthropicReasoningModeOverride,
  type ReasoningAdapter,
  type ReasoningConfig,
  type ReasoningPayload,
} from "./reasoning/types";

/** The per-request context a family consults to answer a query. */
export type LLMFamilyIdentity = {
  model: string;
  apiBase?: string;
  protocol?: ProviderProtocol;
  authMode?: string;
  profileOverride?: ModelProfileOverride;
};

export type ReasoningEncodingRequest = LLMFamilyIdentity & {
  reasoning?: ReasoningConfig;
  useResponses: boolean;
  maxTokens?: number;
  anthropicModeOverride?: AnthropicReasoningModeOverride;
};

export interface LLMFamily {
  readonly id: ReasoningProvider;
  /** The model's context/input/output limits, if any source knows them. */
  limitsFor(identity: LLMFamilyIdentity): ModelCapabilityLimits | undefined;
  /** The reasoning levels the selector should offer. */
  reasoningOptionsFor(
    identity: LLMFamilyIdentity,
  ): ReturnType<typeof getRuntimeReasoningOptions>;
  /** The level a fresh conversation should start on. */
  defaultReasoningLevelFor(identity: LLMFamilyIdentity): string | null;
  /** Thinking tokens an option reserves, from its declared controls. */
  reserveTokensFor(
    option: ReasoningCapabilityOption | undefined,
  ): number | undefined;
  /** Encode a selected level into request fields. */
  encodeReasoning(request: ReasoningEncodingRequest): ReasoningPayload;
}

type FamilyEncoder = (request: ReasoningEncodingRequest) => ReasoningPayload;

function capabilityIdentityOf(
  provider: string,
  request: LLMFamilyIdentity,
): ModelCapabilityIdentity {
  return {
    provider,
    model: request.model,
    apiBase: request.apiBase,
    protocol: request.protocol,
    authMode: request.authMode,
    profileOverride: request.profileOverride,
  };
}

// Legacy call sites may pass only the useResponses flag. Protocol-keyed
// registry controls need a protocol either way, so derive the OpenAI pair
// from the flag; every other family ignores the derivation because its
// entries carry no protocol overrides (or none at all).
function effectiveProtocolOf(
  request: ReasoningEncodingRequest,
): ProviderProtocol {
  return (
    request.protocol ??
    (request.useResponses ? "responses_api" : "openai_chat_compat")
  );
}

/**
 * A hand-typed effort string on the openai/grok families bypasses
 * everything, so a registry option that happens to share the id cannot
 * shadow it. It reads no family data, which is why it lives here rather
 * than in a family module.
 */
function exactEffortPayload({
  reasoning,
  useResponses,
}: {
  reasoning: { provider: string; effort?: string };
  useResponses: boolean;
}): ReasoningPayload | null {
  const exactEffort = reasoning.effort?.trim();
  if (!exactEffort) return null;
  if (reasoning.provider !== "openai" && reasoning.provider !== "grok") {
    return null;
  }
  return {
    extra: useResponses
      ? { reasoning: { effort: exactEffort, summary: "detailed" } }
      : { reasoning_effort: exactEffort },
    omitTemperature: reasoning.provider === "openai",
  };
}

/**
 * The generic encoder, shared by every declarative family: it translates
 * whatever registry controls the capability layer resolved — a per-model
 * entry or the family's registry-miss fallback — into request fields. When
 * nothing is declared, nothing is encoded.
 */
function declarativeEncode(
  request: ReasoningEncodingRequest,
): ReasoningPayload {
  const { reasoning } = request;
  if (!reasoning) return emptyReasoningPayload();
  const exact = exactEffortPayload({
    reasoning,
    useResponses: request.useResponses,
  });
  if (exact) return exact;
  const capabilities = getModelCapabilities({
    ...capabilityIdentityOf(reasoning.provider, request),
    protocol: effectiveProtocolOf(request),
  });
  const controls = compileReasoningControls(capabilities, reasoning);
  return controls ?? emptyReasoningPayload();
}

/**
 * A custom (imperative) encoder. It reads the registry like everyone
 * else — and registry controls outrank it (an Ollama-native qwen serves
 * declarative `think` controls) — falling back to its own logic only for
 * what the data file cannot express: protocol and apiBase forks, mode
 * negotiation, budget clamps. `needsImperative` marks requests whose
 * answer depends on that runtime logic (anthropic's mode override and
 * budget clamp) so they skip the declarative translation; the capability
 * layer's "no reasoning" verdict stands either way.
 */
function customEncode(
  adapter: ReasoningAdapter,
  needsImperative?: (request: ReasoningEncodingRequest) => boolean,
): FamilyEncoder {
  return (request) => {
    const { reasoning } = request;
    if (!reasoning) return emptyReasoningPayload();
    const capabilities = getModelCapabilities({
      ...capabilityIdentityOf(reasoning.provider, request),
      protocol: effectiveProtocolOf(request),
    });
    if (!needsImperative?.(request)) {
      const controls = compileReasoningControls(capabilities, reasoning);
      if (controls) return controls;
    }
    if (capabilities.reasoning.kind === "none") {
      return emptyReasoningPayload();
    }
    return adapter.encode({
      reasoning,
      modelName: request.model,
      apiBase: request.apiBase,
      protocol: request.protocol,
      useResponses: request.useResponses,
      maxTokens: request.maxTokens,
      anthropicModeOverride: request.anthropicModeOverride,
    });
  };
}

/**
 * Which encoder a family uses. Every family not listed here — and every
 * family added later without an entry — gets the generic one: new families
 * are declarative by default, and imperative status is an opt-in registered
 * here, not a branch somewhere in the dispatch path.
 */
const FAMILY_ENCODERS: Partial<Record<ReasoningProvider, FamilyEncoder>> = {
  qwen: customEncode(qwenAdapter),
  anthropic: customEncode(anthropicAdapter, (request) => {
    // The mode override and the manual budget clamp depend on runtime
    // values the registry cannot see.
    return (
      request.anthropicModeOverride !== undefined ||
      request.maxTokens !== undefined
    );
  }),
};

/**
 * The one dispatch point for reasoning encoding: pick the family's encoder
 * from the table and let it decide. Upper layers never see which encoder
 * runs or how it reads its data.
 */
export function dispatchReasoningEncoding(
  request: ReasoningEncodingRequest,
): ReasoningPayload {
  const { reasoning } = request;
  if (!reasoning) return emptyReasoningPayload();
  const encoder = FAMILY_ENCODERS[reasoning.provider] ?? declarativeEncode;
  return encoder(request);
}

function declarativeFamily(id: ReasoningProvider): LLMFamily {
  const capabilityIdentity = (
    identity: LLMFamilyIdentity,
  ): ModelCapabilityIdentity => ({
    provider: id,
    model: identity.model,
    apiBase: identity.apiBase,
    protocol: identity.protocol,
    authMode: identity.authMode,
    profileOverride: identity.profileOverride,
  });
  return {
    id,
    limitsFor: (identity) =>
      getModelCapabilities(capabilityIdentity(identity)).limits,
    reasoningOptionsFor: (identity) =>
      getRuntimeReasoningOptions(capabilityIdentity(identity)),
    defaultReasoningLevelFor: (identity) =>
      getModelReasoningDefaultLevel(capabilityIdentity(identity)),
    reserveTokensFor: (option) => getReasoningOptionReserveTokens(option),
    encodeReasoning: (request) => dispatchReasoningEncoding(request),
  };
}

/** Every reasoning family, keyed by its id from the provider SSOT. */
export const LLM_FAMILIES: Record<ReasoningProvider, LLMFamily> =
  Object.fromEntries(
    ALL_REASONING_PROVIDERS.map((id) => [id, declarativeFamily(id)]),
  ) as Record<ReasoningProvider, LLMFamily>;
