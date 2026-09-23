/**
 * Item-change notification bus.
 *
 * With the item-pane section retired, the embedded surfaces (library bottom
 * panel, reader bottom panels) are the only observers of selection and
 * reader-tab changes. The standalone window still needs those notifications
 * to follow the active paper, but it imports the panel modules for its
 * restore path — a direct dependency from the panels back to
 * standaloneWindow would be circular. This bus inverts the dependency
 * (hooks.ts registers the standalone forwarder).
 */

type ItemChangeNotifier = (item: Zotero.Item | null) => void;

let notifier: ItemChangeNotifier | null = null;

export function setEmbeddedItemChangeNotifier(
  next: ItemChangeNotifier | null,
): void {
  notifier = next;
}

export function notifyEmbeddedItemChange(item: Zotero.Item | null): void {
  if (!notifier) return;
  try {
    notifier(item);
  } catch {
    // A failing consumer must never break the panel's own event flow.
  }
}
