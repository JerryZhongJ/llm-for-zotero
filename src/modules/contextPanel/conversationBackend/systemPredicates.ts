import type { ConversationSystem } from "../../../shared/types";

/**
 * System predicates in one place. setupHandlers and standaloneWindow each
 * kept a verbatim copy of these three closures; a fourth spelling had
 * already started drifting in chat.ts' inline comparisons.
 */

export const isClaudeSystem = (system: ConversationSystem): boolean =>
  system === "claude_code";

export const isCodexSystem = (system: ConversationSystem): boolean =>
  system === "codex";

export const isRuntimeSystem = (system: ConversationSystem): boolean =>
  system === "claude_code" || system === "codex";
