/**
 * The standalone window's opening conversation: which global conversation
 * key to open and which pseudo-portal item to mount, per runtime system.
 * The three-way resolution used to live inline in standaloneWindow (with a
 * sibling copy of the flow in setupHandlers' system switch); it lives here
 * so both surfaces read the same rules.
 */

import { buildDefaultClaudeGlobalConversationKey } from "../../../claudeCode/constants";
import {
  buildCodexLibraryStateKey,
  activeCodexGlobalConversationByLibrary,
} from "../../../codexAppServer/state";
import { buildDefaultCodexGlobalConversationKey } from "../../../codexAppServer/constants";
import { createClaudeGlobalPortalItem } from "../../../claudeCode/portal";
import { createCodexGlobalPortalItem } from "../../../codexAppServer/portal";
import type { ConversationSystem } from "../../../shared/types";

export type UpstreamIdentityDeps = {
  getLockedGlobalConversationKey: (libraryID: number) => number | null;
  activeGlobalConversationByLibrary: Map<number, number>;
  getLastUsedUpstreamGlobalConversationKey: (
    libraryID: number,
  ) => number | null | undefined;
  buildDefaultUpstreamGlobalConversationKey: (libraryID: number) => number;
  globalConversationKeyBase: number;
  createGlobalPortalItem: (libraryID: number, conversationKey: number) => any;
};

export type InitialGlobalIdentityInput = {
  system: ConversationSystem;
  libraryID: number;
  sourceClaudeGlobalKey: number;
  sourceCodexGlobalKey: number;
  sourceUpstreamGlobalKey: number;
  claude: {
    resolveRememberedClaudeConversationKey: (params: {
      libraryID: number;
      kind: "global";
    }) => number | null | undefined;
  };
  codex: {
    getLastUsedCodexGlobalConversationKey: (
      libraryID: number,
    ) => number | null | undefined;
  };
};

export function resolveInitialGlobalConversationKey(
  input: InitialGlobalIdentityInput,
  upstream: UpstreamIdentityDeps,
): number {
  const { system, libraryID } = input;
  if (system === "claude_code") {
    return input.sourceClaudeGlobalKey > 0
      ? input.sourceClaudeGlobalKey
      : input.claude.resolveRememberedClaudeConversationKey({
          libraryID,
          kind: "global",
        }) || buildDefaultClaudeGlobalConversationKey(libraryID);
  }
  if (system === "codex") {
    return input.sourceCodexGlobalKey > 0
      ? input.sourceCodexGlobalKey
      : activeCodexGlobalConversationByLibrary.get(
          buildCodexLibraryStateKey(libraryID),
        ) ||
          input.codex.getLastUsedCodexGlobalConversationKey(libraryID) ||
          buildDefaultCodexGlobalConversationKey(libraryID);
  }
  const remembered =
    upstream.activeGlobalConversationByLibrary.get(libraryID) ??
    upstream.getLastUsedUpstreamGlobalConversationKey(libraryID);
  const lockedKey = upstream.getLockedGlobalConversationKey(libraryID);
  return input.sourceUpstreamGlobalKey > 0
    ? input.sourceUpstreamGlobalKey
    : (lockedKey ??
        (remembered === upstream.globalConversationKeyBase
          ? upstream.buildDefaultUpstreamGlobalConversationKey(libraryID)
          : remembered) ??
        upstream.buildDefaultUpstreamGlobalConversationKey(libraryID));
}

export function createGlobalPortalItemForSystem(
  system: ConversationSystem,
  libraryID: number,
  conversationKey: number,
  upstream: UpstreamIdentityDeps,
): any {
  if (system === "claude_code") {
    return createClaudeGlobalPortalItem(libraryID, conversationKey);
  }
  if (system === "codex") {
    return createCodexGlobalPortalItem(libraryID, conversationKey);
  }
  return upstream.createGlobalPortalItem(libraryID, conversationKey);
}
