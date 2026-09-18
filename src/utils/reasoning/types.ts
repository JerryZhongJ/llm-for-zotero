/**
 * Shared contracts for the per-provider reasoning adapters.
 *
 * Dependency floor: this module (and everything under utils/reasoning) may
 * import only `utils/provider` and sibling reasoning modules — never
 * modelCapabilities or llmClient, whose modules import reasoningProfiles,
 * which assembles its table from these adapters (an import in the other
 * direction would close a static cycle).
 */

import type { ReasoningProvider } from "../provider";

export type ReasoningLevel =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  /** Future provider-defined values (for example `ultra`). */
  | (string & {});
export type OpenAIReasoningEffort =
  | "default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | (string & {});
export type GeminiThinkingParam = "thinking_level" | "thinking_budget";
export type GeminiThinkingValue =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | number;
export type GeminiReasoningOption = {
  level: ReasoningLevel;
  value: GeminiThinkingValue;
};
export type RuntimeReasoningOption = {
  level: ReasoningLevel;
  label: string;
  enabled: boolean;
};
export type OpenAIReasoningProfile = {
  defaultEffort: OpenAIReasoningEffort;
  supportedEfforts: OpenAIReasoningEffort[];
  levelToEffort: Partial<Record<ReasoningLevel, OpenAIReasoningEffort | null>>;
  defaultLevel: ReasoningLevel;
};
export type GeminiReasoningProfile = {
  param: GeminiThinkingParam;
  defaultValue: GeminiThinkingValue;
  options: GeminiReasoningOption[];
  levelToValue: Partial<Record<ReasoningLevel, GeminiThinkingValue>>;
  defaultLevel: ReasoningLevel;
};
export type AnthropicThinkingMode = "adaptive" | "manual" | "none";
export type AnthropicAdaptiveEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type AnthropicReasoningProfile = {
  defaultBudgetTokens: number;
  levelToBudgetTokens: Partial<Record<ReasoningLevel, number>>;
  levelToEffort: Partial<Record<ReasoningLevel, AnthropicAdaptiveEffort>>;
  defaultLevel: ReasoningLevel;
  preferredMode: AnthropicThinkingMode;
  supportsAdaptiveThinking: boolean;
  supportsManualThinking: boolean;
};
export type QwenReasoningProfile = {
  defaultEnableThinking: boolean | null;
  levelToEnableThinking: Partial<Record<ReasoningLevel, boolean | null>>;
  defaultLevel: ReasoningLevel;
};
export type DeepseekThinkingType = "enabled" | "disabled";
export type DeepseekReasoningEffort = "high" | "max";
export type DeepseekReasoningProfile = {
  defaultThinkingType: DeepseekThinkingType | null;
  defaultReasoningEffort: DeepseekReasoningEffort | null;
  levelToThinkingType: Partial<Record<ReasoningLevel, DeepseekThinkingType>>;
  levelToReasoningEffort: Partial<
    Record<ReasoningLevel, DeepseekReasoningEffort | null>
  >;
  defaultLevel: ReasoningLevel;
  omitTemperatureWhenThinking: boolean;
};
export type MimoThinkingType = "enabled";
export type MimoReasoningProfile = {
  levelToThinkingType: Partial<Record<ReasoningLevel, MimoThinkingType | null>>;
  defaultLevel: ReasoningLevel;
};

export type ProviderProfile = {
  supportsReasoning: boolean;
  defaultLevel: ReasoningLevel | null;
  options: RuntimeReasoningOption[];
  openai?: {
    defaultEffort: OpenAIReasoningEffort;
    levelToEffort: Partial<
      Record<ReasoningLevel, OpenAIReasoningEffort | null>
    >;
  };
  gemini?: {
    param: GeminiThinkingParam;
    defaultValue: GeminiThinkingValue;
    levelToValue: Partial<Record<ReasoningLevel, GeminiThinkingValue>>;
  };
  anthropic?: {
    defaultBudgetTokens: number;
    levelToBudgetTokens: Partial<Record<ReasoningLevel, number>>;
    levelToEffort?: Partial<Record<ReasoningLevel, AnthropicAdaptiveEffort>>;
    preferredMode: AnthropicThinkingMode;
    supportsAdaptiveThinking: boolean;
    supportsManualThinking: boolean;
  };
  qwen?: {
    defaultEnableThinking: boolean | null;
    levelToEnableThinking: Partial<Record<ReasoningLevel, boolean | null>>;
  };
  deepseek?: {
    defaultThinkingType: DeepseekThinkingType | null;
    defaultReasoningEffort: DeepseekReasoningEffort | null;
    levelToThinkingType: Partial<Record<ReasoningLevel, DeepseekThinkingType>>;
    levelToReasoningEffort: Partial<
      Record<ReasoningLevel, DeepseekReasoningEffort | null>
    >;
    omitTemperatureWhenThinking?: boolean;
  };
  mimo?: {
    levelToThinkingType: Partial<
      Record<ReasoningLevel, MimoThinkingType | null>
    >;
  };
};

export type ProfileRule = {
  match: RegExp;
  profile: ProviderProfile;
};

export type ReasoningConfig = {
  provider: ReasoningProvider;
  level: ReasoningLevel;
  effort?: string;
};

export type AnthropicReasoningModeOverride = Exclude<
  AnthropicThinkingMode,
  "none"
>;

export type ReasoningPayload = {
  extra: Record<string, unknown>;
  omitTemperature: boolean;
};

export function emptyReasoningPayload(): ReasoningPayload {
  return { extra: {}, omitTemperature: false };
}

export type ReasoningEncodeInput = {
  reasoning: ReasoningConfig;
  modelName?: string;
  /** Qwen's DashScope fork decides between two encodings on this. */
  apiBase?: string;
  /** The deepseek and anthropic encodings fork on anthropic_messages. */
  protocol?: string;
  /** The openai/grok encoding forks between Responses and chat shapes. */
  useResponses: boolean;
  /** Anthropic manual budgets clamp against the request's max tokens. */
  maxTokens?: number;
  anthropicModeOverride?: AnthropicReasoningModeOverride;
};

/**
 * A provider's imperative reasoning encoder. Static level tables live beside
 * it in the same module; families whose levels are fully declarative (registry
 * ModelControlPatches — glm, kimi k2.6+) need no adapter at all.
 */
export type ReasoningAdapter = {
  encode(input: ReasoningEncodeInput): ReasoningPayload;
  /**
   * Only openai/grok: a hand-typed effort string bypasses both the registry
   * and the level tables. Evaluated before the declarative step.
   */
  tryExactEffort?(input: {
    reasoning: ReasoningConfig;
    useResponses: boolean;
  }): ReasoningPayload | null;
};
