import type { ConversationSystem } from "../../../shared/types";

/**
 * Turn-level dispatch facts shared by the send and retry flows. A codex
 * native turn is the one case where the panel does not call the upstream
 * LLM client at all — the app-server client owns the turn — and every
 * runMode/trace decision keys off that one predicate. It used to be derived
 * inline at three places in chat.ts; deriving it wrong at any one of them
 * would route a turn to the wrong runtime.
 */

export function isCodexNativeConversationTurn(
  system: ConversationSystem,
  authMode: string | undefined,
): boolean {
  return system === "codex" && authMode === "codex_app_server";
}

export function resolveTurnRunMode(
  codexNativeTurn: boolean,
  nonCodexRunMode: "chat" | "agent",
): "agent" | "chat" {
  return codexNativeTurn ? "agent" : nonCodexRunMode;
}
