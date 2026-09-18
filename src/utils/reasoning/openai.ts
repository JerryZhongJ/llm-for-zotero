import {
  cloneLevelMap,
  defaultLevelOfProfile,
  getReasoningLevelAlias,
  resolveProfileForRules,
  singleEnabledOptionProfile,
} from "./shared";
import {
  type OpenAIReasoningEffort,
  type OpenAIReasoningProfile,
  type ProfileRule,
  type ProviderProfile,
  type ReasoningAdapter,
  type ReasoningEncodeInput,
  type ReasoningLevel,
  type ReasoningPayload,
} from "./types";

// Grok rides the OpenAI effort encoding: both families share this module and
// the adapter registered under each id.

const OPENAI_GPT5_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [
    { level: "default", label: "default", enabled: true },
    { level: "low", label: "low", enabled: true },
    { level: "medium", label: "medium", enabled: true },
    { level: "high", label: "high", enabled: true },
  ],
  openai: {
    defaultEffort: "default",
    levelToEffort: {
      default: null,
      low: "low",
      medium: "medium",
      high: "high",
    },
  },
};

const GROK_REASONING_PROFILE: ProviderProfile = singleEnabledOptionProfile(
  "default",
  "enabled",
);

const UNSUPPORTED_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
};

// Named GPT-5/Grok ladders live in the capability registry (schema 2,
// protocol-keyed controls); only the guards and optimistic fallbacks remain
// here as the registry-miss path.
export const OPENAI_RULES = [
  // The GPT-3 and GPT-4 families predate reasoning and reject
  // `reasoning_effort` outright. They have to be named here rather than
  // left to the fallback, which is deliberately optimistic so an
  // unreleased OpenAI reasoning model still gets a usable level set
  // before the registry learns its name. `(?:chat)?` catches
  // `chatgpt-4o-latest`; no trailing boundary, so `gpt-35-turbo` (Azure's
  // spelling) and every dated `gpt-4o-*` snapshot fall out for free.
  {
    match: /^(?:chat)?gpt-[34]/,
    profile: UNSUPPORTED_PROFILE,
  },
];

export const OPENAI_FALLBACK_PROFILE = OPENAI_GPT5_PROFILE;

export const GROK_RULES: readonly ProfileRule[] = [];

export const GROK_FALLBACK_PROFILE = GROK_REASONING_PROFILE;

const OPENAI_EFFORT_ORDER: OpenAIReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

function resolveProfile(
  provider: "openai" | "grok",
  modelName?: string,
): ProviderProfile {
  return provider === "grok"
    ? resolveProfileForRules(GROK_RULES, GROK_FALLBACK_PROFILE, modelName)
    : resolveProfileForRules(OPENAI_RULES, OPENAI_FALLBACK_PROFILE, modelName);
}

export function getOpenAIReasoningProfileForModel(
  modelName?: string,
): OpenAIReasoningProfile {
  return getReasoningEffortProfileForModel("openai", modelName);
}

export function getGrokReasoningProfileForModel(
  modelName?: string,
): OpenAIReasoningProfile {
  return getReasoningEffortProfileForModel("grok", modelName);
}

function getReasoningEffortProfileForModel(
  provider: "openai" | "grok",
  modelName?: string,
): OpenAIReasoningProfile {
  const profile = resolveProfile(provider, modelName);
  const fallbackOpenAIProfile =
    provider === "openai" ? OPENAI_GPT5_PROFILE.openai : undefined;
  const openaiProfile = profile.openai || fallbackOpenAIProfile;
  const defaultLevel = defaultLevelOfProfile(profile) || "default";
  const levelToEffort = cloneLevelMap(openaiProfile?.levelToEffort);
  const supportedEfforts = OPENAI_EFFORT_ORDER.filter((effort) => {
    return Object.values(levelToEffort).includes(effort);
  });
  return {
    defaultEffort: openaiProfile?.defaultEffort || "default",
    supportedEfforts,
    levelToEffort,
    defaultLevel,
  };
}

function resolveOpenAIReasoningEffort(
  provider: "openai" | "grok",
  level: ReasoningLevel,
  modelName?: string,
): OpenAIReasoningEffort | null {
  const profile =
    provider === "grok"
      ? getGrokReasoningProfileForModel(modelName)
      : getOpenAIReasoningProfileForModel(modelName);
  const direct = profile.levelToEffort[level];
  if (direct !== undefined) {
    return direct;
  }

  const requestedAlias = getReasoningLevelAlias(level);
  if (requestedAlias) {
    const aliasValue = profile.levelToEffort[requestedAlias];
    if (aliasValue !== undefined) {
      return aliasValue;
    }
  }

  for (const candidate of OPENAI_EFFORT_ORDER) {
    if (profile.supportedEfforts.includes(candidate)) {
      return candidate;
    }
  }

  const defaultEffort = profile.levelToEffort[profile.defaultLevel];
  if (defaultEffort !== undefined) {
    return defaultEffort;
  }

  return null;
}

function tryExactEffort({
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

function encode({
  reasoning,
  modelName,
  useResponses,
}: ReasoningEncodeInput): ReasoningPayload {
  const provider = reasoning.provider === "grok" ? "grok" : "openai";
  const effort = resolveOpenAIReasoningEffort(
    provider,
    reasoning.level,
    modelName,
  );
  const omitTemperature = provider === "openai";
  if (useResponses) {
    const responseReasoning: Record<string, unknown> = {
      summary: "detailed",
    };
    if (effort) {
      responseReasoning.effort = effort;
    }
    return {
      extra: {
        reasoning: responseReasoning,
      },
      // GPT-5 families may reject temperature when reasoning is configured.
      omitTemperature,
    };
  }
  return {
    extra: effort ? { reasoning_effort: effort } : {},
    omitTemperature,
  };
}

export const openaiAdapter: ReasoningAdapter = { encode, tryExactEffort };
export const grokAdapter: ReasoningAdapter = { encode, tryExactEffort };
