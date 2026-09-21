/**
 * The anthropic family's custom encoder. Its menu ladders and the default
 * wire shapes (adaptive efforts, manual budgets) live in the registry's
 * claude entries; what stays here is the runtime negotiation the data
 * cannot express — the adaptive/manual mode override, the degraded
 * adaptive-to-manual recovery, and clamping manual budgets to the
 * request's max_tokens. The variant rules below mirror the registry
 * entries for those imperative paths.
 */

import {
  cloneLevelMap,
  defaultLevelOfProfile,
  getReasoningLevelAlias,
  resolveProfileForRules,
} from "./shared";
import {
  type AnthropicAdaptiveEffort,
  type AnthropicReasoningModeOverride,
  type AnthropicReasoningProfile,
  type ProfileRule,
  type ProviderProfile,
  type ReasoningAdapter,
  type ReasoningEncodeInput,
  type ReasoningLevel,
  type ReasoningPayload,
  type RuntimeReasoningOption,
} from "./types";

const UNSUPPORTED_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
};

const ANTHROPIC_ADAPTIVE_MAX_OPTIONS: RuntimeReasoningOption[] = [
  { level: "low", label: "low", enabled: true },
  { level: "medium", label: "medium", enabled: true },
  { level: "high", label: "high", enabled: true },
  { level: "xhigh", label: "max", enabled: true },
];

const ANTHROPIC_ADAPTIVE_XHIGH_OPTIONS: RuntimeReasoningOption[] = [
  { level: "low", label: "low", enabled: true },
  { level: "medium", label: "medium", enabled: true },
  { level: "high", label: "high", enabled: true },
  { level: "xhigh", label: "xhigh", enabled: true },
];

const ANTHROPIC_MANUAL_OPTIONS: RuntimeReasoningOption[] = [
  { level: "low", label: "1024", enabled: true },
  { level: "medium", label: "2000", enabled: true },
  { level: "high", label: "10000", enabled: true },
  { level: "xhigh", label: "32000", enabled: true },
];

const ANTHROPIC_MAX_EFFORT_MAP: Partial<
  Record<ReasoningLevel, AnthropicAdaptiveEffort>
> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

const ANTHROPIC_XHIGH_EFFORT_MAP: Partial<
  Record<ReasoningLevel, AnthropicAdaptiveEffort>
> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

const ANTHROPIC_BUDGET_MAP: Partial<Record<ReasoningLevel, number>> = {
  low: 1024,
  medium: 2000,
  high: 10000,
  xhigh: 32000,
};

const ANTHROPIC_ADAPTIVE_ONLY_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: ANTHROPIC_ADAPTIVE_MAX_OPTIONS,
  anthropic: {
    defaultBudgetTokens: 2000,
    levelToBudgetTokens: ANTHROPIC_BUDGET_MAP,
    levelToEffort: ANTHROPIC_MAX_EFFORT_MAP,
    preferredMode: "adaptive",
    supportsAdaptiveThinking: true,
    supportsManualThinking: false,
  },
};

const ANTHROPIC_OPUS_47_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: ANTHROPIC_ADAPTIVE_XHIGH_OPTIONS,
  anthropic: {
    defaultBudgetTokens: 2000,
    levelToBudgetTokens: ANTHROPIC_BUDGET_MAP,
    levelToEffort: ANTHROPIC_XHIGH_EFFORT_MAP,
    preferredMode: "adaptive",
    supportsAdaptiveThinking: true,
    supportsManualThinking: false,
  },
};

const ANTHROPIC_ADAPTIVE_WITH_MANUAL_FALLBACK_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: ANTHROPIC_ADAPTIVE_MAX_OPTIONS,
  anthropic: {
    defaultBudgetTokens: 2000,
    levelToBudgetTokens: ANTHROPIC_BUDGET_MAP,
    levelToEffort: ANTHROPIC_MAX_EFFORT_MAP,
    preferredMode: "adaptive",
    supportsAdaptiveThinking: true,
    supportsManualThinking: true,
  },
};

const ANTHROPIC_MANUAL_THINKING_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "medium",
  options: ANTHROPIC_MANUAL_OPTIONS,
  anthropic: {
    defaultBudgetTokens: 2000,
    levelToBudgetTokens: ANTHROPIC_BUDGET_MAP,
    levelToEffort: {},
    preferredMode: "manual",
    supportsAdaptiveThinking: false,
    supportsManualThinking: true,
  },
};

const ANTHROPIC_RULES: readonly ProfileRule[] = [
  {
    match: /(^|[/:.])claude-mythos-preview(?:\b|[.-])/,
    profile: ANTHROPIC_ADAPTIVE_ONLY_PROFILE,
  },
  {
    match: /(^|[/:.])claude-opus-4-7(?:\b|[.-])/,
    profile: ANTHROPIC_OPUS_47_PROFILE,
  },
  {
    match: /(^|[/:.])claude-(?:opus|sonnet)-4-6(?:\b|[.-])/,
    profile: ANTHROPIC_ADAPTIVE_WITH_MANUAL_FALLBACK_PROFILE,
  },
  {
    match: /(^|[/:.])claude-haiku-4-5(?:\b|[.-])/,
    profile: ANTHROPIC_MANUAL_THINKING_PROFILE,
  },
  {
    match:
      /(^|[/:.])claude-(?:opus-(?:4-5|4-1|4)|sonnet-(?:4-5|4)|3-7-sonnet)(?:\b|[.-])/,
    profile: ANTHROPIC_MANUAL_THINKING_PROFILE,
  },
];

function resolveAnthropicProfile(
  modelName?: string,
): AnthropicReasoningProfile {
  const profile = resolveProfileForRules(
    ANTHROPIC_RULES,
    UNSUPPORTED_PROFILE,
    modelName,
  );
  const anthropicProfile = profile.anthropic;
  const defaultLevel = defaultLevelOfProfile(profile) || "high";
  return {
    defaultBudgetTokens: anthropicProfile?.defaultBudgetTokens || 2000,
    levelToBudgetTokens: cloneLevelMap(anthropicProfile?.levelToBudgetTokens),
    levelToEffort: cloneLevelMap(anthropicProfile?.levelToEffort),
    defaultLevel,
    preferredMode: anthropicProfile?.preferredMode || "none",
    supportsAdaptiveThinking: Boolean(
      anthropicProfile?.supportsAdaptiveThinking,
    ),
    supportsManualThinking: Boolean(anthropicProfile?.supportsManualThinking),
  };
}

function resolveAnthropicThinkingBudget(
  level: ReasoningLevel,
  profile: AnthropicReasoningProfile,
): number {
  const direct = profile.levelToBudgetTokens[level];
  if (Number.isFinite(direct)) {
    return Number(direct);
  }

  const aliasLevel = getReasoningLevelAlias(level);
  if (aliasLevel) {
    const aliasBudget = profile.levelToBudgetTokens[aliasLevel];
    if (Number.isFinite(aliasBudget)) {
      return Number(aliasBudget);
    }
  }

  const defaultBudget = profile.levelToBudgetTokens[profile.defaultLevel];
  if (Number.isFinite(defaultBudget)) {
    return Number(defaultBudget);
  }

  return profile.defaultBudgetTokens;
}

function resolveAnthropicAdaptiveEffort(
  level: ReasoningLevel,
  profile: AnthropicReasoningProfile,
): AnthropicAdaptiveEffort | null {
  const direct = profile.levelToEffort[level];
  if (direct) return direct;

  const aliasLevel = getReasoningLevelAlias(level);
  if (aliasLevel) {
    const aliasEffort = profile.levelToEffort[aliasLevel];
    if (aliasEffort) return aliasEffort;
  }

  const defaultEffort = profile.levelToEffort[profile.defaultLevel];
  return defaultEffort || null;
}

export function resolveAnthropicThinkingMode(params: {
  profile: AnthropicReasoningProfile;
  override?: AnthropicReasoningModeOverride;
}): AnthropicReasoningModeOverride | null {
  if (
    params.override === "adaptive" &&
    params.profile.supportsAdaptiveThinking
  ) {
    return "adaptive";
  }
  if (params.override === "manual" && params.profile.supportsManualThinking) {
    return "manual";
  }
  if (
    params.profile.preferredMode === "adaptive" &&
    params.profile.supportsAdaptiveThinking
  ) {
    return "adaptive";
  }
  if (
    params.profile.preferredMode === "manual" &&
    params.profile.supportsManualThinking
  ) {
    return "manual";
  }
  return null;
}

/** A local validation failure for a main request's selected reasoning mode. */
export class ReasoningBudgetError extends Error {
  readonly code = "reasoning_budget_too_small" as const;

  constructor(message: string) {
    super(message);
    this.name = "ReasoningBudgetError";
  }
}

function resolveAnthropicManualBudget(params: {
  level: ReasoningLevel;
  profile: AnthropicReasoningProfile;
  maxTokens?: number;
  modelName?: string;
}): number {
  const requested = Math.max(
    1024,
    Math.floor(resolveAnthropicThinkingBudget(params.level, params.profile)),
  );
  const maxTokens = Math.floor(Number(params.maxTokens));
  if (!Number.isFinite(maxTokens) || maxTokens < 1) {
    return requested;
  }

  const reservedAnswerTokens = 1024;
  const maxBudgetTokens = maxTokens - reservedAnswerTokens;
  if (maxBudgetTokens < 1024) {
    const label = (params.modelName || "the selected Anthropic model").trim();
    throw new ReasoningBudgetError(
      `${label} extended thinking requires max_tokens of at least 2048 so budget_tokens can be less than max_tokens while leaving room for the answer. Increase max tokens or turn thinking off.`,
    );
  }
  return Math.min(requested, maxBudgetTokens);
}

function encode({
  reasoning,
  modelName,
  protocol,
  maxTokens,
  anthropicModeOverride,
}: ReasoningEncodeInput): ReasoningPayload {
  if (protocol !== "anthropic_messages") {
    return { extra: {}, omitTemperature: false };
  }
  const profile = resolveAnthropicProfile(modelName);
  const mode = resolveAnthropicThinkingMode({
    profile,
    override: anthropicModeOverride,
  });
  if (!mode) {
    return { extra: {}, omitTemperature: false };
  }
  if (mode === "adaptive") {
    const effort = resolveAnthropicAdaptiveEffort(reasoning.level, profile);
    return {
      extra: {
        thinking: {
          type: "adaptive",
        },
        ...(effort ? { output_config: { effort } } : {}),
      },
      omitTemperature: true,
    };
  }

  const budgetTokens = resolveAnthropicManualBudget({
    level: reasoning.level,
    profile,
    maxTokens,
    modelName,
  });
  return {
    extra: {
      thinking: {
        type: "enabled",
        budget_tokens: budgetTokens,
      },
    },
    omitTemperature: true,
  };
}

/**
 * The anthropic leg of the request-rejected recovery chain: adaptive thinking
 * degrades to manual on models that support both. Other providers recover by
 * resetting to the profile's default level (see llmClient).
 */
export function getAnthropicRecoverySelection(params: {
  currentLevel: ReasoningLevel;
  anthropicModeOverride?: AnthropicReasoningModeOverride;
  modelName?: string;
}):
  | {
      provider: "anthropic";
      level: ReasoningLevel;
      anthropicModeOverride?: AnthropicReasoningModeOverride;
    }
  | undefined
  | null {
  const profile = resolveAnthropicProfile(params.modelName);
  const currentMode = resolveAnthropicThinkingMode({
    profile,
    override: params.anthropicModeOverride,
  });
  if (currentMode === "adaptive" && profile.supportsManualThinking) {
    return {
      provider: "anthropic",
      level: params.currentLevel,
      anthropicModeOverride: "manual",
    };
  }
  return undefined;
}

export const anthropicAdapter: ReasoningAdapter = { encode };
