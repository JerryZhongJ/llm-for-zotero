import {
  cloneLevelMap,
  defaultLevelOfProfile,
  getReasoningLevelAlias,
  resolveProfileForRules,
} from "./shared";
import {
  emptyReasoningPayload,
  type ProviderProfile,
  type QwenReasoningProfile,
  type ReasoningAdapter,
  type ReasoningEncodeInput,
  type ReasoningLevel,
  type ReasoningPayload,
} from "./types";

const QWEN_TOGGLE_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [
    { level: "default", label: "default", enabled: true },
    { level: "high", label: "enabled", enabled: true },
    { level: "low", label: "disabled", enabled: true },
  ],
  qwen: {
    defaultEnableThinking: null,
    levelToEnableThinking: {
      default: null,
      high: true,
      low: false,
    },
  },
};

const QWEN_THINKING_ONLY_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [{ level: "default", label: "enabled", enabled: true }],
  qwen: {
    defaultEnableThinking: true,
    levelToEnableThinking: {
      default: true,
    },
  },
};

const QWEN_NON_THINKING_ONLY_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
  qwen: {
    defaultEnableThinking: false,
    levelToEnableThinking: {},
  },
};

export const QWEN_RULES = [
  {
    match: /(^|[/:])qwen3-[\w.-]*instruct-2507(?:\b|[.-])/,
    profile: QWEN_NON_THINKING_ONLY_PROFILE,
  },
  {
    match: /(^|[/:])(?:qwen3-[\w.-]*thinking-2507|qwq)(?:\b|[.-])/,
    profile: QWEN_THINKING_ONLY_PROFILE,
  },
  {
    match: /(^|[/:])qwen(?:\d+)?(?:\b|[.-])/,
    profile: QWEN_TOGGLE_PROFILE,
  },
];

export const QWEN_FALLBACK_PROFILE = QWEN_TOGGLE_PROFILE;

function resolveProfile(modelName?: string): ProviderProfile {
  return resolveProfileForRules(QWEN_RULES, QWEN_FALLBACK_PROFILE, modelName);
}

export function getQwenReasoningProfileForModel(
  modelName?: string,
): QwenReasoningProfile {
  const profile = resolveProfile(modelName);
  const qwenProfile = profile.qwen || QWEN_TOGGLE_PROFILE.qwen;
  const defaultLevel = defaultLevelOfProfile(profile) || "default";
  return {
    defaultEnableThinking: qwenProfile?.defaultEnableThinking ?? null,
    levelToEnableThinking: cloneLevelMap(qwenProfile?.levelToEnableThinking),
    defaultLevel,
  };
}

function resolveQwenEnableThinking(
  level: ReasoningLevel,
  profile: QwenReasoningProfile,
): boolean | null {
  const direct = profile.levelToEnableThinking[level];
  if (typeof direct === "boolean" || direct === null) {
    return direct;
  }

  const aliasLevel = getReasoningLevelAlias(level);
  if (aliasLevel) {
    const aliasValue = profile.levelToEnableThinking[aliasLevel];
    if (typeof aliasValue === "boolean" || aliasValue === null) {
      return aliasValue;
    }
  }

  const defaultValue = profile.levelToEnableThinking[profile.defaultLevel];
  if (typeof defaultValue === "boolean" || defaultValue === null) {
    return defaultValue;
  }

  return profile.defaultEnableThinking;
}

function isDashScopeApiBase(apiBase?: string): boolean {
  const normalized = (apiBase || "").trim().toLowerCase();
  if (!normalized) return false;
  return /dashscope(?:-intl)?\.aliyuncs\.com/.test(normalized);
}

function encode({
  reasoning,
  modelName,
  apiBase,
}: ReasoningEncodeInput): ReasoningPayload {
  const profile = getQwenReasoningProfileForModel(modelName);
  const enableThinking = resolveQwenEnableThinking(reasoning.level, profile);
  if (enableThinking === null) {
    return emptyReasoningPayload();
  }
  if (isDashScopeApiBase(apiBase)) {
    return {
      extra: {
        enable_thinking: enableThinking,
      },
      omitTemperature: false,
    };
  }
  return {
    extra: {
      chat_template_kwargs: {
        enable_thinking: enableThinking,
      },
    },
    omitTemperature: false,
  };
}

export const qwenAdapter: ReasoningAdapter = { encode };
