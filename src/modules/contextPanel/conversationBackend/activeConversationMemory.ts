/**
 * Remembering which conversation a panel last used, per runtime system.
 * The three runtimes (upstream, claude_code, codex) each own their state
 * maps and preference keys; the branches used to live inline in
 * setupHandlers' syncConversationIdentity, which made every runtime change
 * touch the panel god-module. They live here behind one call.
 */

import {
  activeClaudeConversationModeByLibrary,
  buildClaudeLibraryStateKey,
} from "../../../claudeCode/state";
import { setLastUsedClaudeConversationMode } from "../../../claudeCode/prefs";
import {
  activeCodexConversationModeByLibrary,
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
  buildCodexLibraryStateKey,
  buildCodexPaperStateKey,
} from "../../../codexAppServer/state";
import {
  setLastUsedCodexConversationMode,
  setLastUsedCodexGlobalConversationKey,
  setLastUsedCodexPaperConversationKey,
} from "../../../codexAppServer/prefs";
import type { ConversationSystem } from "../../../shared/types";

export type ActiveConversationMemoryInput = {
  system: ConversationSystem;
  libraryID: number;
  mode: "global" | "paper";
  itemID: number;
  conversationKey: number;
  basePaperItemID: number;
};

type UpstreamMemoryDeps = {
  activeGlobalConversationByLibrary: Map<number, number>;
  activePaperConversationByPaper: Map<string, number>;
  setLastUsedUpstreamGlobalConversationKey: (
    libraryID: number,
    key: number,
  ) => void;
  setLastUsedPaperConversationKey: (
    libraryID: number,
    basePaperItemID: number,
    key: number,
  ) => void;
  getLockedGlobalConversationKey: (libraryID: number) => number | null;
  setLockedGlobalConversationKey: (
    libraryID: number,
    key: number | null,
  ) => void;
  removeAutoLockedGlobalConversationKey: (key: number) => void;
  buildPaperStateKey: (libraryID: number, basePaperItemID: number) => string;
};

/**
 * The upstream maps live in the panel's own closure (they are per-panel
 * wiring, not a subsystem's), so they are injected; the claude/codex
 * subsystems own theirs and are imported directly.
 */
export function rememberActiveConversation(
  input: ActiveConversationMemoryInput,
  upstream: UpstreamMemoryDeps,
): void {
  const { system, libraryID, mode, itemID } = input;
  if (system === "claude_code") {
    activeClaudeConversationModeByLibrary.set(
      buildClaudeLibraryStateKey(libraryID),
      mode,
    );
    setLastUsedClaudeConversationMode(libraryID, mode);
    return;
  }
  if (system === "codex") {
    activeCodexConversationModeByLibrary.set(
      buildCodexLibraryStateKey(libraryID),
      mode,
    );
    setLastUsedCodexConversationMode(libraryID, mode);
    if (mode === "global") {
      activeCodexGlobalConversationByLibrary.set(
        buildCodexLibraryStateKey(libraryID),
        itemID,
      );
      setLastUsedCodexGlobalConversationKey(libraryID, itemID);
    } else if (input.conversationKey > 0 && input.basePaperItemID > 0) {
      activeCodexPaperConversationByPaper.set(
        buildCodexPaperStateKey(libraryID, input.basePaperItemID),
        input.conversationKey,
      );
      setLastUsedCodexPaperConversationKey(
        libraryID,
        input.basePaperItemID,
        input.conversationKey,
      );
    }
    return;
  }
  // Upstream surfaces no longer persist a conversation mode — the kind is
  // fixed by the surface — only the conversation keys are remembered.
  if (mode === "global") {
    upstream.activeGlobalConversationByLibrary.set(libraryID, itemID);
    upstream.setLastUsedUpstreamGlobalConversationKey(libraryID, itemID);
  } else if (input.conversationKey > 0 && input.basePaperItemID > 0) {
    const lockedGlobalKey = upstream.getLockedGlobalConversationKey(libraryID);
    if (lockedGlobalKey !== null) {
      upstream.setLockedGlobalConversationKey(libraryID, null);
      upstream.removeAutoLockedGlobalConversationKey(lockedGlobalKey);
    }
    upstream.activePaperConversationByPaper.set(
      upstream.buildPaperStateKey(libraryID, input.basePaperItemID),
      input.conversationKey,
    );
    upstream.setLastUsedPaperConversationKey(
      libraryID,
      input.basePaperItemID,
      input.conversationKey,
    );
  }
}
