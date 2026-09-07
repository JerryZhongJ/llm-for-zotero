export type PanelContextLifecycleDecisionParams = {
  needsFullRender: boolean;
  storedItemKey?: string;
  newItemKey: string;
  currentKind?: string;
  currentRawContextItemKey?: string;
  rawContextItemKey: string;
  currentContextOwnerItemKey?: string;
  newContextOwnerItemKey: string;
  currentContextSourceStateKey?: string;
  newContextSourceStateKey: string;
};

function isSamePaperConversation(
  params: PanelContextLifecycleDecisionParams,
): boolean {
  return (
    !params.needsFullRender &&
    params.storedItemKey === params.newItemKey &&
    params.currentKind === "paper"
  );
}

export function hasPanelContextOwnerChanged(
  params: PanelContextLifecycleDecisionParams,
): boolean {
  if (!isSamePaperConversation(params)) return false;
  return Boolean(
    params.currentContextOwnerItemKey &&
    params.newContextOwnerItemKey &&
    params.currentContextOwnerItemKey !== params.newContextOwnerItemKey,
  );
}

export function shouldRefreshContextSourceWithoutPanelRebuild(
  params: PanelContextLifecycleDecisionParams,
): boolean {
  if (!isSamePaperConversation(params)) return false;
  if (hasPanelContextOwnerChanged(params)) return false;
  return (
    (params.currentRawContextItemKey || "") !== params.rawContextItemKey ||
    (params.currentContextSourceStateKey || "") !==
      params.newContextSourceStateKey
  );
}

/**
 * Anchored-conversation guard: the resolved conversation key drifted away
 * from the one the panel is currently displaying, but the raw context item
 * (the user's anchor) did not change. This happens when remembered
 * conversation state is rewritten without the user moving to another item
 * (e.g. deletion cleanup or surrender restore). Keep the displayed
 * conversation and treat the render as a context refresh instead of a
 * rebuild.
 */
export function shouldKeepDisplayedConversationWithoutRebuild(params: {
  needsFullRender: boolean;
  storedItemKey: string | undefined;
  newItemKey: string;
  currentRawContextItemKey?: string;
  rawContextItemKey: string;
}): boolean {
  if (params.needsFullRender) return false;
  if (params.storedItemKey === undefined) return false;
  if (params.storedItemKey === params.newItemKey) return false;
  return (
    Boolean(params.currentRawContextItemKey) &&
    params.currentRawContextItemKey === params.rawContextItemKey
  );
}
