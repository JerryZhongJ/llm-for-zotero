/**
 * Library chat ambient context
 *
 * The library chat panel anchors one global conversation per library; the
 * user's library-pane state (the open collection, the highlighted item) is
 * transient UI state, deliberately excluded from the explicit "/" resource
 * model. When the `libraryChatAmbientContext` preference is enabled, these
 * helpers mirror that state into each agent turn as *ambient* context:
 * metadata references only, marked as ambient so the model can distinguish
 * them from user-attached resources.
 *
 * Everything here is defensive: a missing pane, an unreadable selection, or a
 * cross-library resource must degrade to "no ambient context", never fail a
 * turn (turn-level normalization hard-fails on library mismatches).
 */

import type { CollectionContextRef, PaperContextRef } from "../../shared/types";
import { normalizePositiveInt } from "./normalizers";
import { resolvePaperContextRefFromItem } from "./paperAttribution";
import { getLibraryChatAmbientContextPref } from "./prefHelpers";

/** First regular item / attachment in the pane selection, or null. */
export function getFirstSelectedLibraryContextItem(
  pane: { getSelectedItems?: () => Zotero.Item[] } | null | undefined,
): Zotero.Item | null {
  try {
    const items = pane?.getSelectedItems?.() || [];
    return (
      items.find(
        (item) =>
          item && (item.isRegularItem?.() || item.isAttachment?.() === true),
      ) || null
    );
  } catch {
    return null;
  }
}

/**
 * Selected collection of the active Zotero pane, or null. Saved searches,
 * feeds, and other non-collection tree rows are rejected by round-tripping
 * the id through Zotero.Collections — only registered collections pass.
 */
export function getAmbientCollectionFromActivePane(): CollectionContextRef | null {
  try {
    const pane = Zotero.getActiveZoteroPane?.() as unknown as {
      getSelectedCollection?: () => unknown;
    } | null;
    const ref = pane?.getSelectedCollection?.() as
      | { id?: unknown; libraryID?: unknown; name?: unknown }
      | null
      | undefined;
    const collectionId = normalizePositiveInt(ref?.id);
    const libraryID = normalizePositiveInt(ref?.libraryID);
    if (!collectionId || !libraryID) return null;
    const registered = (
      Zotero as unknown as {
        Collections?: { get?: (id: number) => { libraryID?: unknown } | false };
      }
    ).Collections?.get?.(collectionId);
    if (
      !registered ||
      normalizePositiveInt(registered.libraryID) !== libraryID
    ) {
      // Saved search, feed, or a stale row — not a real collection.
      return null;
    }
    const name =
      typeof ref?.name === "string" && ref.name.trim()
        ? ref.name.trim()
        : `Collection ${collectionId}`;
    return { collectionId, libraryID, name };
  } catch {
    return null;
  }
}

/** First selected paper of the active Zotero pane as a context ref, or null. */
function getAmbientPaperFromActivePane(): PaperContextRef | null {
  try {
    const pane = Zotero.getActiveZoteroPane?.() as unknown as {
      getSelectedItems?: () => Zotero.Item[];
    } | null;
    return resolvePaperContextRefFromItem(
      getFirstSelectedLibraryContextItem(pane),
    );
  } catch {
    return null;
  }
}

export type LibraryChatAmbientContext = Readonly<{
  paperContext?: PaperContextRef;
  collectionContext?: CollectionContextRef;
}>;

/**
 * Single entry point consumed by buildAgentRuntimeRequest. Returns ambient
 * resources for the *current* library-pane state, gated on the global
 * conversation kind and the preference. Never throws and never returns
 * resources from another library — turn-level normalization would otherwise
 * hard-fail the request.
 */
export function resolveLibraryChatAmbientContext(params: {
  conversationKind: "global" | "paper" | null | undefined;
  libraryID: number;
}): LibraryChatAmbientContext {
  if (params.conversationKind !== "global") return {};
  if (!getLibraryChatAmbientContextPref()) return {};
  const libraryID = normalizePositiveInt(params.libraryID) || 0;
  if (!libraryID) return {};

  const collectionRaw = getAmbientCollectionFromActivePane();
  const collectionContext =
    collectionRaw && collectionRaw.libraryID === libraryID
      ? collectionRaw
      : undefined;

  const paperRaw = getAmbientPaperFromActivePane();
  const paperContext =
    paperRaw && normalizePositiveInt(paperRaw.libraryID) === libraryID
      ? paperRaw
      : undefined;

  return { paperContext, collectionContext };
}
