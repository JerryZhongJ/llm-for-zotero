import { config } from "../../package.json";
import {
  normalizeAgentLibraryWriteMode,
  type AgentLibraryWriteMode,
} from "../shared/agentLibraryWriteMode";

const PREF_KEY = `${config.prefsPrefix}.agentLibraryWriteMode`;
const LEGACY_MIGRATION_MARKER = `${PREF_KEY}LegacyAutoMigrated`;

/**
 * Reads the in-plugin agent's library write mode.
 *
 * A missing or unset pref normalises to `semi_auto`, the shipped default. A
 * pref that cannot be READ at all falls back to `manual`, which is
 * deliberately stricter than the default: a corrupt or inaccessible
 * preference must never be the reason a write goes unreviewed.
 *
 * The pre-rename "auto" (reversible runs, irreversible confirms) is a
 * DIFFERENT mode from the post-rename "auto" (gate model). A stored "auto"
 * without the migration marker is therefore the legacy value and is
 * rewritten to "semi_auto", its nearest equivalent — never silently to the
 * more permissive new "auto".
 */
export function getAgentLibraryWriteMode(): AgentLibraryWriteMode {
  try {
    const prefs = (
      Zotero as unknown as {
        Prefs?: {
          get?: (key: string, global?: boolean) => unknown;
          set?: (key: string, value: unknown, global?: boolean) => void;
        };
      }
    ).Prefs;
    const raw = prefs?.get?.(PREF_KEY, true);
    const normalized = normalizeAgentLibraryWriteMode(
      typeof raw === "string" ? raw.trim().toLowerCase() : raw,
    );
    if (normalized === "auto") {
      const migrated = Boolean(prefs?.get?.(LEGACY_MIGRATION_MARKER, true));
      if (!migrated) {
        prefs?.set?.(PREF_KEY, "semi_auto", true);
        prefs?.set?.(LEGACY_MIGRATION_MARKER, true, true);
        return "semi_auto";
      }
    } else {
      // Any other stored value proves the dropdown was touched after the
      // rename, so a later manual switch back to "auto" is intentional.
      prefs?.set?.(LEGACY_MIGRATION_MARKER, true, true);
    }
    return normalized;
  } catch {
    return "manual";
  }
}

export function setAgentLibraryWriteMode(mode: AgentLibraryWriteMode): void {
  try {
    (
      Zotero as unknown as {
        Prefs?: {
          set?: (key: string, value: unknown, global?: boolean) => void;
        };
      }
    ).Prefs?.set?.(PREF_KEY, mode, true);
  } catch {
    /* a pref we cannot write is not worth failing a turn over */
  }
}
