import {
  cloneLevelMap,
  defaultLevelOfProfile,
  getReasoningLevelAlias,
  resolveProfileForRules,
} from "./shared";
import {
  type GeminiReasoningOption,
  type GeminiReasoningProfile,
  type GeminiThinkingValue,
  type ProfileRule,
  type ProviderProfile,
  type ReasoningAdapter,
  type ReasoningEncodeInput,
  type ReasoningLevel,
  type ReasoningPayload,
} from "./types";

const GEMINI_GENERIC_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "medium",
  options: [
    { level: "medium", label: "medium", enabled: true },
    { level: "low", label: "low", enabled: true },
    { level: "high", label: "high", enabled: true },
  ],
  gemini: {
    param: "thinking_level",
    defaultValue: "medium",
    levelToValue: {
      low: "low",
      medium: "medium",
      high: "high",
    },
  },
};

// Named gemini ladders live in the capability registry (schema 2,
// protocol-keyed controls). The generic profile stays as the
// registry-miss fallback — an unreleased Gemini gets a usable level set
// before the registry learns its name.
export const GEMINI_RULES: readonly ProfileRule[] = [];

export const GEMINI_FALLBACK_PROFILE = GEMINI_GENERIC_PROFILE;

function resolveProfile(modelName?: string): ProviderProfile {
  return resolveProfileForRules(
    GEMINI_RULES,
    GEMINI_FALLBACK_PROFILE,
    modelName,
  );
}

export function getGeminiReasoningProfileForModel(
  modelName?: string,
): GeminiReasoningProfile {
  const profile = resolveProfile(modelName);
  const geminiProfile = profile.gemini || GEMINI_GENERIC_PROFILE.gemini;
  const defaultLevel = defaultLevelOfProfile(profile) || "medium";
  const levelToValue = cloneLevelMap(geminiProfile?.levelToValue);
  const options: GeminiReasoningOption[] = profile.options
    .filter((optionState) => optionState.enabled)
    .map((optionState) => {
      const mappedValue = levelToValue[optionState.level];
      const value = (
        mappedValue !== undefined
          ? mappedValue
          : optionState.level === "low" ||
              optionState.level === "medium" ||
              optionState.level === "high"
            ? optionState.level
            : (geminiProfile?.defaultValue ?? "medium")
      ) as GeminiThinkingValue;
      return {
        level: optionState.level,
        value,
      };
    });
  return {
    param: geminiProfile?.param ?? "thinking_level",
    defaultValue: geminiProfile?.defaultValue ?? "medium",
    options,
    levelToValue,
    defaultLevel,
  };
}

function resolveGeminiReasoningOption(
  level: ReasoningLevel,
  profile: GeminiReasoningProfile,
): GeminiReasoningOption {
  const direct = profile.levelToValue[level];
  if (direct !== undefined) {
    return { level, value: direct };
  }

  const aliasLevel = getReasoningLevelAlias(level);
  if (aliasLevel) {
    const aliasValue = profile.levelToValue[aliasLevel];
    if (aliasValue !== undefined) {
      return { level: aliasLevel, value: aliasValue };
    }
  }

  const defaultMapped = profile.levelToValue[profile.defaultLevel];
  if (defaultMapped !== undefined) {
    return { level: profile.defaultLevel, value: defaultMapped };
  }

  const byDefaultValue = profile.options.find(
    (option) => option.value === profile.defaultValue,
  );
  if (byDefaultValue) return byDefaultValue;

  return profile.options[0] || { level: "medium", value: profile.defaultValue };
}

/**
 * The gemini_native camelCase thinkingConfig for a level, from the profile
 * tables — the shared fallback behind both the llmClient payload builder and
 * the agent's geminiNative adapter, which used to keep identical copies.
 */
export function geminiThinkingConfigFromProfile(
  modelName: string | undefined,
  level: ReasoningLevel,
):
  | { includeThoughts: true; thinkingBudget: number }
  | { includeThoughts: true; thinkingLevel: string } {
  const profile = getGeminiReasoningProfileForModel(modelName);
  const value =
    profile.levelToValue[level] ??
    profile.levelToValue[profile.defaultLevel] ??
    profile.defaultValue;
  return profile.param === "thinking_budget"
    ? {
        includeThoughts: true,
        thinkingBudget: typeof value === "number" ? value : 8192,
      }
    : {
        includeThoughts: true,
        thinkingLevel:
          value === "minimal" ||
          value === "low" ||
          value === "medium" ||
          value === "high"
            ? value
            : "medium",
      };
}

function encode({
  reasoning,
  modelName,
}: ReasoningEncodeInput): ReasoningPayload {
  const profile = getGeminiReasoningProfileForModel(modelName);
  const resolvedOption = resolveGeminiReasoningOption(reasoning.level, profile);

  // Keep request valid if a stale/unsupported level is selected.
  const thinkingConfig: Record<string, unknown> = {
    include_thoughts: true,
  };
  if (profile.param === "thinking_budget") {
    thinkingConfig.thinking_budget =
      typeof resolvedOption.value === "number" ? resolvedOption.value : 8192;
  } else {
    thinkingConfig.thinking_level =
      resolvedOption.value === "minimal" ||
      resolvedOption.value === "low" ||
      resolvedOption.value === "medium" ||
      resolvedOption.value === "high"
        ? resolvedOption.value
        : "medium";
  }

  return {
    extra: {
      extra_body: {
        google: {
          thinking_config: thinkingConfig,
        },
      },
    },
    omitTemperature: false,
  };
}

export const geminiAdapter: ReasoningAdapter = { encode };
