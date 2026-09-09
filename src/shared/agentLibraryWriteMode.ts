/**
 * How much the in-plugin agent may change the Zotero library without asking.
 *
 * - `manual`     — every library write is confirmed. Batch jobs pause per
 *                  page.
 * - `semi_auto`  — the default. Reversible writes apply immediately (each
 *                  one is journalled with a frozen inverse and can be
 *                  undone from the conversation); irreversible writes are
 *                  confirmed.
 * - `auto`       — nothing waits for confirmation. A model gate judges
 *                  model-originated irreversible writes against the user's
 *                  request; reversible writes apply immediately.
 *
 * Legacy values migrate on read: safe → manual, auto → semi_auto, yolo →
 * auto.
 */
export type AgentLibraryWriteMode = "manual" | "semi_auto" | "auto";

export function normalizeAgentLibraryWriteMode(
  value: unknown,
): AgentLibraryWriteMode {
  if (value === "manual" || value === "semi_auto" || value === "auto") {
    return value;
  }
  // Legacy mappings from the pre-rename mode set. The legacy "auto" cannot be
  // mapped here — it collides with the new "auto" — so it is migrated at
  // read time with a one-time marker (see getAgentLibraryWriteMode).
  if (value === "safe") return "manual";
  if (value === "yolo") return "auto";
  return "semi_auto";
}

export function getAgentLibraryWriteModeDescription(): string {
  return "manual confirms every library write before it happens. semi_auto (default) applies reversible changes immediately — each stays undoable from the conversation — and confirms only irreversible ones. auto applies everything without asking; a model gate judges irreversible writes against your request and refuses anything it cannot justify. Every reversible change is journalled either way and can be undone.";
}
