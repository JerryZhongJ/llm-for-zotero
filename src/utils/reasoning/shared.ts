import type {
  ProviderProfile,
  ReasoningLevel,
  RuntimeReasoningOption,
} from "./types";

/** Levels some providers accept in place of their official spelling. */
export const REASONING_LEVEL_ALIAS_MAP: Partial<
  Record<ReasoningLevel, ReasoningLevel>
> = {
  minimal: "low",
  xhigh: "high",
};

export function getReasoningLevelAlias(
  level: ReasoningLevel,
): ReasoningLevel | null {
  return REASONING_LEVEL_ALIAS_MAP[level] || null;
}

export const option = (
  level: ReasoningLevel,
  label: string,
): RuntimeReasoningOption => {
  return { level, label, enabled: true };
};

export function singleEnabledOptionProfile(
  level: ReasoningLevel,
  label: string,
  extras: Omit<
    Partial<ProviderProfile>,
    "supportsReasoning" | "defaultLevel" | "options"
  > = {},
): ProviderProfile {
  return {
    supportsReasoning: true,
    defaultLevel: level,
    options: [option(level, label)],
    ...extras,
  };
}

/** The profile's effective default level, mirroring the facade's rules. */
export function defaultLevelOfProfile(
  profile: ProviderProfile,
): ReasoningLevel | null {
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

export function cloneLevelMap<T>(
  levelMap?: Partial<Record<ReasoningLevel, T>>,
): Partial<Record<ReasoningLevel, T>> {
  return { ...(levelMap || {}) };
}

export function normalizeModelName(modelName?: string): string {
  return (modelName || "").trim().toLowerCase();
}

/** Resolve a model against one family's rules, exactly as the facade does. */
export function resolveProfileForRules(
  rules: readonly { match: RegExp; profile: ProviderProfile }[],
  fallback: ProviderProfile,
  modelName?: string,
): ProviderProfile {
  const normalized = normalizeModelName(modelName);
  for (const rule of rules) {
    if (rule.match.test(normalized)) {
      return rule.profile;
    }
  }
  return fallback;
}
