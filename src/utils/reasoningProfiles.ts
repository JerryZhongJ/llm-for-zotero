const REASONING_PROFILE_TABLE_VERSION = 7;

/**
 * Facade over the per-provider reasoning adapters.
 *
 * The level tables, model-matching rules, and imperative encoders live in
 * `utils/reasoning/<family>.ts`; this module keeps the historical import path
 * and the cross-provider queries (`getRuntimeReasoningOptionsForModel`,
 * `supportsReasoningForModel`, `getReasoningDefaultLevelForModel`) that read
 * the assembled table. Provider membership itself comes from
 * `utils/provider.ts` (single source of truth).
 */

// The member list lives in src/utils/provider.ts (single source of truth);
// re-exported here so every existing consumer keeps its import path.
export type { ReasoningProvider } from "./provider";
import type { ReasoningProvider } from "./provider";

export type {
  ReasoningLevel,
  OpenAIReasoningEffort,
  GeminiThinkingParam,
  GeminiThinkingValue,
  GeminiReasoningOption,
  RuntimeReasoningOption,
  OpenAIReasoningProfile,
  GeminiReasoningProfile,
  AnthropicThinkingMode,
  AnthropicAdaptiveEffort,
  AnthropicReasoningProfile,
  QwenReasoningProfile,
  DeepseekThinkingType,
  DeepseekReasoningEffort,
  DeepseekReasoningProfile,
  MimoThinkingType,
  MimoReasoningProfile,
} from "./reasoning/types";
import type {
  ProviderProfile,
  ProfileRule,
  ReasoningLevel,
} from "./reasoning/types";

export {
  getOpenAIReasoningProfileForModel,
  getGrokReasoningProfileForModel,
} from "./reasoning/openai";
export { getGeminiReasoningProfileForModel } from "./reasoning/gemini";
export { getQwenReasoningProfileForModel } from "./reasoning/qwen";
export { getDeepseekReasoningProfileForModel } from "./reasoning/deepseek";
export { getMimoReasoningProfileForModel } from "./reasoning/mimo";
export { getAnthropicReasoningProfileForModel } from "./reasoning/anthropic";
export {
  REASONING_LEVEL_ALIAS_MAP,
  getReasoningLevelAlias,
} from "./reasoning/shared";

import {
  ANTHROPIC_FALLBACK_PROFILE,
  ANTHROPIC_RULES,
} from "./reasoning/anthropic";
import {
  DEEPSEEK_FALLBACK_PROFILE,
  DEEPSEEK_RULES,
} from "./reasoning/deepseek";
import { GEMINI_FALLBACK_PROFILE, GEMINI_RULES } from "./reasoning/gemini";
import { KIMI_FALLBACK_PROFILE, KIMI_RULES } from "./reasoning/kimi";
import { MIMO_FALLBACK_PROFILE, MIMO_RULES } from "./reasoning/mimo";
import {
  GROK_FALLBACK_PROFILE,
  GROK_RULES,
  OPENAI_FALLBACK_PROFILE,
  OPENAI_RULES,
} from "./reasoning/openai";
import { QWEN_FALLBACK_PROFILE, QWEN_RULES } from "./reasoning/qwen";
import { resolveProfileForRules } from "./reasoning/shared";

/**
 * Context tokens set aside for a reasoning level's thinking, shared by the
 * chat budget estimator and the utility-LLM planner (which used to keep
 * identical copies). Callers keep their own fallback for unknown levels.
 */
export const REASONING_RESERVE_TOKENS_BY_LEVEL: Record<string, number> = {
  minimal: 512,
  low: 1_024,
  default: 1_024,
  medium: 2_048,
  high: 4_096,
  xhigh: 8_192,
  ultra: 8_192,
  max: 8_192,
};

const UNSUPPORTED_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
};

const PROFILE_RULES: Record<
  ReasoningProvider,
  { rules: readonly ProfileRule[]; fallback: ProviderProfile }
> = {
  openai: { rules: OPENAI_RULES, fallback: OPENAI_FALLBACK_PROFILE },
  grok: { rules: GROK_RULES, fallback: GROK_FALLBACK_PROFILE },
  gemini: { rules: GEMINI_RULES, fallback: GEMINI_FALLBACK_PROFILE },
  deepseek: { rules: DEEPSEEK_RULES, fallback: DEEPSEEK_FALLBACK_PROFILE },
  kimi: { rules: KIMI_RULES, fallback: KIMI_FALLBACK_PROFILE },
  mimo: { rules: MIMO_RULES, fallback: MIMO_FALLBACK_PROFILE },
  qwen: { rules: QWEN_RULES, fallback: QWEN_FALLBACK_PROFILE },
  anthropic: { rules: ANTHROPIC_RULES, fallback: ANTHROPIC_FALLBACK_PROFILE },
  // Locally-served models carry no hand-maintained profile: their options come
  // from what the server reports plus whatever the user configures, resolved
  // entirely through declarative ModelControlPatches. This entry exists so
  // ReasoningConfig.provider stays type-safe and every lookup here is inert.
  local: { rules: [], fallback: UNSUPPORTED_PROFILE },
  // GLM's levels live in the model-capability registry (glm-5.3's
  // reasoning_effort select), not in a hand-maintained profile. Inert here for
  // the same type-safety reason as `local`.
  glm: { rules: [], fallback: UNSUPPORTED_PROFILE },
};

function resolveProviderProfile(
  provider: ReasoningProvider,
  modelName?: string,
): ProviderProfile {
  const table = PROFILE_RULES[provider];
  return resolveProfileForRules(table.rules, table.fallback, modelName);
}

function cloneRuntimeOptions(
  options: ProviderProfile["options"],
): ProviderProfile["options"] {
  return options.map((entry) => ({ ...entry }));
}

export function getRuntimeReasoningOptionsForModel(
  provider: ReasoningProvider,
  modelName?: string,
): ReturnType<typeof cloneRuntimeOptions> {
  const profile = resolveProviderProfile(provider, modelName);
  if (!profile.supportsReasoning) return [];
  return cloneRuntimeOptions(profile.options);
}

export function supportsReasoningForModel(
  provider: ReasoningProvider,
  modelName?: string,
): boolean {
  const profile = resolveProviderProfile(provider, modelName);
  if (!profile.supportsReasoning) return false;
  return profile.options.some((optionState) => optionState.enabled);
}

export function getReasoningDefaultLevelForModel(
  provider: ReasoningProvider,
  modelName?: string,
): ReasoningLevel | null {
  const profile = resolveProviderProfile(provider, modelName);
  if (!profile.supportsReasoning) return null;
  if (
    profile.defaultLevel &&
    profile.options.some(
      (optionState) =>
        optionState.enabled && optionState.level === profile.defaultLevel,
    )
  ) {
    return profile.defaultLevel;
  }
  const firstEnabled = profile.options.find(
    (optionState) => optionState.enabled,
  );
  return firstEnabled?.level || null;
}

/**
 * Thought summaries are the plugin's ask, not the profile's: every branch that
 * builds a `thinkingConfig` from a known profile requests them, so a config
 * that arrives declared — from the registry, or from a reasoning level the
 * user typed — must not cost the reasoning stream merely by saying nothing
 * about it. An explicit `includeThoughts: false` still wins.
 */
export function withGeminiThoughtSummaries(
  config: Record<string, unknown>,
): Record<string, unknown> {
  // Both call sites accept `thinking_config` as well as `thinkingConfig`, and
  // this repo's own legacy encoder writes snake_case, so both spellings of the
  // field have to count as "already stated" — adding the camelCase one beside
  // an existing `include_thoughts` would send Gemini the same field twice.
  return "includeThoughts" in config || "include_thoughts" in config
    ? config
    : { includeThoughts: true, ...config };
}
