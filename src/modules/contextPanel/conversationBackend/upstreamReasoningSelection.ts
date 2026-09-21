/**
 * The upstream LLM's selected thinking level: cache lookup, per-provider
 * memory, family default, and the fallback ladder. chat.ts
 * (getSelectedReasoningForItem) and setupHandlers (getReasoningState's
 * upstream leg) each kept a copy of this ladder; they now share it here.
 */

import { prefersReasoningOff } from "../../../utils/reasoningProfiles";
import type { ReasoningLevel } from "../../../utils/reasoningProfiles";
import {
  getLastUsedReasoningLevel,
  getLastUsedReasoningLevelForProvider,
} from "../prefHelpers";
import {
  selectedReasoningCache,
  selectedReasoningProviderCache,
} from "../state";
import type { ReasoningProviderKind } from "../types";

export type UpstreamSelectedLevel = {
  selectedLevel: "none" | ReasoningLevel;
};

export function resolveUpstreamSelectedLevel(params: {
  itemId: number;
  provider: ReasoningProviderKind;
  enabledLevels: ReasoningLevel[];
}): UpstreamSelectedLevel {
  const { itemId, provider, enabledLevels } = params;
  const cachedProvider = selectedReasoningProviderCache.get(itemId);
  const cachedLevel =
    cachedProvider === provider ? selectedReasoningCache.get(itemId) : null;
  let selectedLevel =
    cachedLevel ||
    getLastUsedReasoningLevelForProvider(provider) ||
    (prefersReasoningOff(provider)
      ? "none"
      : getLastUsedReasoningLevel() || "none");
  if (prefersReasoningOff(provider)) {
    if (!enabledLevels.includes(selectedLevel as ReasoningLevel)) {
      selectedLevel = "none";
    }
  } else if (enabledLevels.length > 0) {
    if (
      selectedLevel === "none" ||
      !enabledLevels.includes(selectedLevel as ReasoningLevel)
    ) {
      selectedLevel = enabledLevels[0];
    }
  } else {
    selectedLevel = "none";
  }
  selectedReasoningCache.set(itemId, selectedLevel);
  selectedReasoningProviderCache.set(itemId, provider);
  return { selectedLevel };
}
