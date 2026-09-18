import {
  cloneLevelMap,
  defaultLevelOfProfile,
  resolveProfileForRules,
} from "./shared";
import {
  emptyReasoningPayload,
  type MimoReasoningProfile,
  type ProfileRule,
  type ProviderProfile,
  type ReasoningAdapter,
  type ReasoningEncodeInput,
  type ReasoningPayload,
} from "./types";

// mimo-v2's ladder lives in the capability registry; the unsupported
// fallback remains for registry misses.
export const MIMO_RULES: readonly ProfileRule[] = [];

export const MIMO_FALLBACK_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
};

function resolveProfile(modelName?: string): ProviderProfile {
  return resolveProfileForRules(MIMO_RULES, MIMO_FALLBACK_PROFILE, modelName);
}

export function getMimoReasoningProfileForModel(
  modelName?: string,
): MimoReasoningProfile {
  const profile = resolveProfile(modelName);
  const mimoProfile = profile.mimo;
  const defaultLevel = defaultLevelOfProfile(profile) || "default";
  return {
    levelToThinkingType: cloneLevelMap(mimoProfile?.levelToThinkingType),
    defaultLevel,
  };
}

function encode({
  reasoning,
  modelName,
}: ReasoningEncodeInput): ReasoningPayload {
  const profile = getMimoReasoningProfileForModel(modelName);
  const thinkingType =
    profile.levelToThinkingType[reasoning.level] ??
    profile.levelToThinkingType[profile.defaultLevel] ??
    null;
  if (!thinkingType) {
    return emptyReasoningPayload();
  }
  return {
    extra: { thinking: { type: thinkingType } },
    omitTemperature: false,
  };
}

export const mimoAdapter: ReasoningAdapter = { encode };
