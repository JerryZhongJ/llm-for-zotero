import {
  cloneLevelMap,
  defaultLevelOfProfile,
  resolveProfileForRules,
} from "./shared";
import {
  emptyReasoningPayload,
  type DeepseekReasoningProfile,
  type ProfileRule,
  type ProviderProfile,
  type ReasoningAdapter,
  type ReasoningEncodeInput,
  type ReasoningPayload,
} from "./types";

const DEEPSEEK_CHAT_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
};

// Named deepseek ladders live in the capability registry (schema 2,
// protocol-keyed controls); deepseek-chat's no-reasoning fallback stays
// as the registry-miss path.
export const DEEPSEEK_RULES: readonly ProfileRule[] = [];

export const DEEPSEEK_FALLBACK_PROFILE = DEEPSEEK_CHAT_PROFILE;

function resolveProfile(modelName?: string): ProviderProfile {
  return resolveProfileForRules(
    DEEPSEEK_RULES,
    DEEPSEEK_FALLBACK_PROFILE,
    modelName,
  );
}

export function getDeepseekReasoningProfileForModel(
  modelName?: string,
): DeepseekReasoningProfile {
  const profile = resolveProfile(modelName);
  const deepseekProfile = profile.deepseek;
  const defaultLevel = defaultLevelOfProfile(profile) || "default";
  return {
    defaultThinkingType: deepseekProfile?.defaultThinkingType ?? null,
    defaultReasoningEffort: deepseekProfile?.defaultReasoningEffort ?? null,
    levelToThinkingType: cloneLevelMap(deepseekProfile?.levelToThinkingType),
    levelToReasoningEffort: cloneLevelMap(
      deepseekProfile?.levelToReasoningEffort,
    ),
    defaultLevel,
    omitTemperatureWhenThinking: Boolean(
      deepseekProfile?.omitTemperatureWhenThinking,
    ),
  };
}

function encode({
  reasoning,
  modelName,
  protocol,
}: ReasoningEncodeInput): ReasoningPayload {
  const profile = getDeepseekReasoningProfileForModel(modelName);
  const thinkingType =
    profile.levelToThinkingType[reasoning.level] ?? profile.defaultThinkingType;
  if (!thinkingType) {
    return emptyReasoningPayload();
  }
  const reasoningEffort =
    profile.levelToReasoningEffort[reasoning.level] ??
    profile.defaultReasoningEffort;
  const extra: Record<string, unknown> = {
    thinking: {
      type: thinkingType,
    },
  };
  if (thinkingType === "enabled" && reasoningEffort) {
    if (protocol === "anthropic_messages") {
      extra.output_config = { effort: reasoningEffort };
    } else {
      extra.reasoning_effort = reasoningEffort;
    }
  }
  return {
    extra,
    omitTemperature:
      thinkingType === "enabled" && profile.omitTemperatureWhenThinking,
  };
}

export const deepseekAdapter: ReasoningAdapter = { encode };
