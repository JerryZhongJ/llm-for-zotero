/**
 * Cross-cutting reasoning helpers and the historical type re-export path.
 * The per-family knowledge itself now lives elsewhere: declarative ladders
 * (including the registry-miss family fallbacks) in the capability
 * registry, imperative encodings in `utils/reasoning/<family>.ts` (only
 * qwen and anthropic remain imperative). Provider membership comes from
 * `utils/provider.ts` (single source of truth).
 */

// The member list lives in src/utils/provider.ts (single source of truth);
// re-exported here so every existing consumer keeps its import path.
export type { ReasoningProvider } from "./provider";

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
} from "./reasoning/types";

export {
  REASONING_LEVEL_ALIAS_MAP,
  getReasoningLevelAlias,
} from "./reasoning/shared";

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

/**
 * Whether a provider's conversations should start with reasoning off and
 * only turn it on explicitly. The chat selector uses this instead of
 * branching on the provider name: the preference belongs to the family's
 * profile layer, not to every caller that needs a default level.
 */
export function prefersReasoningOff(provider: string): boolean {
  return provider === "anthropic";
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
