import {
  emptyReasoningPayload,
  type ProfileRule,
  type ProviderProfile,
  type ReasoningAdapter,
  type ReasoningEncodeInput,
  type ReasoningPayload,
} from "./types";

// Registry entries cover kimi-k2/k2.5/k2-thinking (k2.6+ were already
// declarative); this non-thinking fallback remains for registry misses.
export const KIMI_RULES: readonly ProfileRule[] = [];

export const KIMI_FALLBACK_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
};

function encode({ reasoning }: ReasoningEncodeInput): ReasoningPayload {
  // Kimi k2/k2.5: "default" = thinking enabled, "minimal" = thinking disabled
  const thinkingType = reasoning.level === "minimal" ? "disabled" : "enabled";
  return {
    extra: { thinking: { type: thinkingType } },
    omitTemperature: false,
  };
}

export const kimiAdapter: ReasoningAdapter = { encode };
