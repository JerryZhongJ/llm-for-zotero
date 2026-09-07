/**
 * Library Chat Panel
 *
 * An independent chat surface mounted at the bottom of the item list in the
 * library tab (inside #item-tree-main-default), toggled by a toolbar button
 * in #zotero-items-toolbar. Unlike the item pane section it does not depend
 * on item selection to exist and owns its scrolling.
 *
 * The panel always hosts the library-wide (global) conversation for the
 * active library. Selection changes are anchored to the conversation: they
 * only refresh the auto-loaded context via the existing context-refresh
 * pipeline, never rebuild the panel.
 */

import { config } from "./constants";
import { t } from "../../utils/i18n";
import {
  activeContextPanels,
  activeContextPanelRawItems,
  activeContextPanelStateSync,
} from "./state";
import {
  resolveActiveLibraryID,
  resolvePreferredConversationSystem,
  resolveRememberedGlobalPanelItem,
} from "./portalScope";
import {
  getLibraryPanelEnabledPref,
  setLibraryPanelEnabledPref,
  getLibraryPanelHeightPref,
  setLibraryPanelHeightPref,
  applyPanelFontScale,
} from "./prefHelpers";
import { buildUI } from "./buildUI";
import { setupHandlers, disposeSetupHandlers } from "./setupHandlers";
import { ensureConversationLoaded, refreshChat } from "./chat";
import { renderShortcuts } from "./shortcuts";
import {
  retainClaudeRuntimeForBody,
  releaseClaudeRuntimeForBody,
} from "../../claudeCode/runtimeRetention";
import type { ConversationSystem } from "../../shared/types";

const LIBRARY_PANEL_TOGGLE_ID = "llmforzotero-library-chat-toggle";
const LIBRARY_PANEL_ID = "llmforzotero-library-panel";
const LIBRARY_PANEL_BODY_CLASS = "llm-library-panel-body";
const LIBRARY_PANEL_RESIZER_CLASS = "llm-library-panel-resizer";
const LIBRARY_PANEL_MIN_HEIGHT_PX = 200;
const LIBRARY_PANEL_MAX_HEIGHT_PX = 2000;
const ITEM_TREE_MAIN_SELECTOR = "#item-tree-main-default";
const ITEM_TREE_WAIT_TIMEOUT_MS = 30_000;
const ITEM_TREE_POLL_INTERVAL_MS = 100;

type LibraryPanelController = {
  win: _ZoteroTypes.MainWindow;
  doc: Document;
  button: Element | null;
  container: HTMLElement | null;
  body: HTMLElement | null;
  mounted: boolean;
  cancelled: boolean;
  dispose: () => void;
};

const controllers = new Map<Window, LibraryPanelController>();

export function isLibraryPanelBody(body: Element): boolean {
  return (
    (body as HTMLElement).classList?.contains(LIBRARY_PANEL_BODY_CLASS) === true
  );
}

/** The global conversation item this panel currently anchors, if mounted. */
export function resolveLibraryPanelPinnedItem(win: Window): Zotero.Item | null {
  const controller = controllers.get(win);
  const body = controller?.body;
  if (!controller || !body || !controller.mounted) return null;
  return activeContextPanels.get(body)?.() || null;
}

function getLibraryPanelSystem(): ConversationSystem {
  // Same preference handling as every other surface: a runtime system is
  // honored only while its mode is enabled.
  return resolvePreferredConversationSystem({ item: null }) || "upstream";
}

function getFirstSelectedContextItem(
  win: _ZoteroTypes.MainWindow,
): Zotero.Item | null {
  try {
    const pane = (
      win as unknown as {
        ZoteroPane?: { getSelectedItems?: () => Zotero.Item[] };
      }
    ).ZoteroPane;
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

function clampLibraryPanelHeight(value: number): number {
  return Math.max(
    LIBRARY_PANEL_MIN_HEIGHT_PX,
    Math.min(
      Number.isFinite(value) ? Math.floor(value) : LIBRARY_PANEL_MIN_HEIGHT_PX,
      LIBRARY_PANEL_MAX_HEIGHT_PX,
    ),
  );
}

async function waitForItemTreeMain(doc: Document): Promise<HTMLElement | null> {
  const existing = doc.querySelector(ITEM_TREE_MAIN_SELECTOR);
  if (existing) return existing as HTMLElement;
  const deadline = Date.now() + ITEM_TREE_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Zotero.Promise.delay(ITEM_TREE_POLL_INTERVAL_MS);
    const found = doc.querySelector(ITEM_TREE_MAIN_SELECTOR);
    if (found) return found as HTMLElement;
  }
  return null;
}

function updateToggleButtonState(controller: LibraryPanelController): void {
  const open =
    Boolean(controller.container) &&
    controller.container!.style.display !== "none";
  controller.button?.setAttribute("aria-pressed", open ? "true" : "false");
}

function notifyLibraryPanelSelectionChanged(win: Window): void {
  const controller = controllers.get(win);
  const body = controller?.body;
  if (!controller || !body || !controller.mounted) return;
  if (controller.container?.style.display === "none") return;
  const rawItem = getFirstSelectedContextItem(controller.win);
  if (!rawItem) return;
  const pinnedItem = activeContextPanels.get(body)?.() || null;
  const activeLibraryID = resolveActiveLibraryID() || 0;
  const pinnedLibraryID = Number(pinnedItem?.libraryID || 0);
  if (
    activeLibraryID > 0 &&
    pinnedLibraryID > 0 &&
    pinnedLibraryID !== activeLibraryID
  ) {
    // The user switched to another library/group: the anchored conversation
    // belongs elsewhere, so remount with that library's global conversation.
    remountLibraryPanel(controller);
    return;
  }
  // Anchor holds: only the context follows the selection.
  activeContextPanelRawItems.set(body, rawItem);
  const llmMain = body.querySelector("#llm-main") as HTMLElement | null;
  if (llmMain) {
    llmMain.dataset.rawContextItemId = String(Number(rawItem.id || 0) || "");
    llmMain.dataset.contextItemId = String(Number(rawItem.id || 0) || "");
    llmMain.dataset.contextOwnerItemId = String(Number(rawItem.id || 0) || "");
  }
  const refreshContextSource = (body as any)
    .__llmRefreshContextSourceForCurrentItem;
  if (typeof refreshContextSource === "function") {
    refreshContextSource();
  } else {
    activeContextPanelStateSync.get(body)?.();
  }
}

function remountLibraryPanel(controller: LibraryPanelController): void {
  if (controller.cancelled || !controller.body) return;
  void mountLibraryPanelConversation(controller);
}

async function mountLibraryPanelConversation(
  controller: LibraryPanelController,
): Promise<void> {
  const { body } = controller;
  if (!body || controller.cancelled) return;
  const libraryID = resolveActiveLibraryID() || 1;
  const system = getLibraryPanelSystem();
  const pinnedItem = resolveRememberedGlobalPanelItem(libraryID, system);
  if (!pinnedItem) {
    ztoolkit.log("LLM: library panel could not resolve a global conversation");
    return;
  }
  try {
    buildUI(body, pinnedItem);
    const llmMain = body.querySelector("#llm-main") as HTMLElement | null;
    if (llmMain) {
      llmMain.dataset.libraryPanel = "true";
      llmMain.dataset.conversationKind = "global";
      llmMain.dataset.conversationSystem = system;
      llmMain.dataset.itemId = `${Number(pinnedItem.id || 0) || ""}`;
      const rawItem = getFirstSelectedContextItem(controller.win);
      if (rawItem) {
        const rawId = String(Number(rawItem.id || 0) || "");
        llmMain.dataset.rawContextItemId = rawId;
        llmMain.dataset.contextItemId = rawId;
        llmMain.dataset.contextOwnerItemId = rawId;
      }
    }
    // The anchor starts at the resolved global conversation. setupHandlers'
    // syncConversationIdentity replaces this entry whenever the user switches
    // conversations, so the anchor always tracks the displayed conversation.
    activeContextPanels.set(body, () => pinnedItem);
    activeContextPanelRawItems.set(
      body,
      getFirstSelectedContextItem(controller.win),
    );
    void retainClaudeRuntimeForBody(body, pinnedItem);
    setupHandlers(body, pinnedItem);
    controller.mounted = true;
  } catch (err) {
    ztoolkit.log("LLM: library panel mount failed", err);
    return;
  }
  try {
    await ensureConversationLoaded(pinnedItem);
    if (controller.cancelled || !controller.mounted) return;
    refreshChat(body, pinnedItem);
    void renderShortcuts(body, pinnedItem, "library");
    const llmMain = body.querySelector("#llm-main") as HTMLElement | null;
    applyPanelFontScale(llmMain);
  } catch (err) {
    ztoolkit.log("LLM: library panel conversation load failed", err);
  }
}

function attachResizer(controller: LibraryPanelController): void {
  const { doc, container } = controller;
  const resizer = container?.querySelector(
    `.${LIBRARY_PANEL_RESIZER_CLASS}`,
  ) as HTMLElement | null;
  if (!resizer || !container) return;
  resizer.addEventListener("mousedown", (event: Event) => {
    const mouseEvent = event as MouseEvent;
    if (mouseEvent.button !== 0) return;
    event.preventDefault();
    const startY = mouseEvent.clientY;
    const startHeight = container.getBoundingClientRect().height;
    const onMouseMove = (moveEvent: Event) => {
      const dy = (moveEvent as MouseEvent).clientY - startY;
      container.style.height = `${clampLibraryPanelHeight(startHeight - dy)}px`;
    };
    const onMouseUp = () => {
      doc.removeEventListener("mousemove", onMouseMove);
      doc.removeEventListener("mouseup", onMouseUp);
      setLibraryPanelHeightPref(
        clampLibraryPanelHeight(container.getBoundingClientRect().height),
      );
    };
    doc.addEventListener("mousemove", onMouseMove);
    doc.addEventListener("mouseup", onMouseUp);
  });
}

async function ensurePanelContainer(
  controller: LibraryPanelController,
): Promise<void> {
  if (controller.container || controller.cancelled) return;
  const mainNode = await waitForItemTreeMain(controller.doc);
  if (!mainNode || controller.cancelled) {
    ztoolkit.log(
      "LLM: library panel container not found (item tree unavailable)",
    );
    return;
  }
  const doc = controller.doc;
  const container = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLElement;
  container.id = LIBRARY_PANEL_ID;
  container.style.height = `${getLibraryPanelHeightPref()}px`;
  container.style.minHeight = `${LIBRARY_PANEL_MIN_HEIGHT_PX}px`;
  const resizer = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLElement;
  resizer.className = LIBRARY_PANEL_RESIZER_CLASS;
  const body = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLElement;
  body.className = LIBRARY_PANEL_BODY_CLASS;
  container.append(resizer, body);
  mainNode.append(container);
  controller.container = container;
  controller.body = body;
  attachResizer(controller);
  if (!getLibraryPanelEnabledPref()) {
    container.style.display = "none";
  }
  updateToggleButtonState(controller);
}

function toggleLibraryPanel(controller: LibraryPanelController): void {
  const container = controller.container;
  if (!container) return;
  const open = container.style.display !== "none";
  if (open) {
    container.style.display = "none";
    setLibraryPanelEnabledPref(false);
  } else {
    container.style.display = "";
    setLibraryPanelEnabledPref(true);
  }
  updateToggleButtonState(controller);
}

function registerToolbarButton(controller: LibraryPanelController): void {
  const doc = controller.doc;
  const toolbar = doc.querySelector("#zotero-items-toolbar");
  if (!toolbar) {
    ztoolkit.log("LLM: items toolbar not found; library panel button skipped");
    return;
  }
  if (doc.getElementById(LIBRARY_PANEL_TOGGLE_ID)) return;
  const button = doc.createXULElement("toolbarbutton");
  button.id = LIBRARY_PANEL_TOGGLE_ID;
  button.className = "zotero-tb-btn";
  button.setAttribute("tooltiptext", t("Library chat panel"));
  button.setAttribute("aria-pressed", "false");
  (button as unknown as HTMLElement).style.listStyleImage =
    `url(chrome://${config.addonRef}/content/icons/icon.svg)`;
  button.addEventListener("command", () => {
    toggleLibraryPanel(controller);
  });
  const anchor = doc.querySelector("#zotero-tb-advanced-search");
  if (anchor?.parentElement === toolbar && anchor.nextElementSibling) {
    toolbar.insertBefore(button, anchor.nextElementSibling);
  } else {
    toolbar.appendChild(button);
  }
  controller.button = button;
}

// ── itemSelected patch (selection anchoring) ──────────────────────────────

type PatchedItemSelectedState = {
  original: (...args: unknown[]) => unknown;
  patched: (...args: unknown[]) => unknown;
};

const itemSelectedPatches = new WeakMap<Window, PatchedItemSelectedState>();

function patchItemSelected(win: _ZoteroTypes.MainWindow): void {
  const pane = (
    win as unknown as {
      ZoteroPane?: { itemSelected?: (...args: unknown[]) => unknown };
    }
  ).ZoteroPane;
  const original = pane?.itemSelected;
  if (!pane || typeof original !== "function") return;
  if (itemSelectedPatches.has(win)) return;
  const patched = function patchedItemSelected(
    this: unknown,
    ...args: unknown[]
  ) {
    const result = original.apply(this, args);
    Promise.resolve(result).finally(() => {
      try {
        notifyLibraryPanelSelectionChanged(win);
      } catch (err) {
        ztoolkit.log("LLM: library panel selection notify failed", err);
      }
    });
    return result;
  };
  pane.itemSelected = patched as typeof original;
  itemSelectedPatches.set(win, { original, patched });
}

function unpatchItemSelected(win: Window): void {
  const patchState = itemSelectedPatches.get(win);
  if (!patchState) return;
  const pane = (
    win as unknown as {
      ZoteroPane?: { itemSelected?: (...args: unknown[]) => unknown };
    }
  ).ZoteroPane;
  if (pane && pane.itemSelected === patchState.patched) {
    pane.itemSelected = patchState.original as typeof pane.itemSelected;
  }
  itemSelectedPatches.delete(win);
}

// ── Public API ─────────────────────────────────────────────────────────────

export function registerLibraryChatPanel(win: _ZoteroTypes.MainWindow): void {
  if (controllers.has(win)) return;
  const doc = win.document;
  const controller: LibraryPanelController = {
    win,
    doc,
    button: null,
    container: null,
    body: null,
    mounted: false,
    cancelled: false,
    dispose: () => {
      controller.cancelled = true;
      if (controller.body) {
        disposeSetupHandlers(controller.body);
        void releaseClaudeRuntimeForBody(controller.body);
        activeContextPanels.delete(controller.body);
        activeContextPanelRawItems.delete(controller.body);
        activeContextPanelStateSync.delete(controller.body);
      }
      controller.mounted = false;
      controller.container?.remove();
      controller.container = null;
      controller.body = null;
      doc.getElementById(LIBRARY_PANEL_TOGGLE_ID)?.remove();
      unpatchItemSelected(win);
      controllers.delete(win);
    },
  };
  controllers.set(win, controller);
  registerToolbarButton(controller);
  patchItemSelected(win);
  void (async () => {
    await ensurePanelContainer(controller);
    if (controller.cancelled || !controller.container) return;
    if (controller.container.style.display === "none") return;
    await mountLibraryPanelConversation(controller);
  })();
}

export function unregisterLibraryChatPanel(win: Window): void {
  controllers.get(win)?.dispose();
}

export function unregisterAllLibraryChatPanels(): void {
  for (const win of [...controllers.keys()]) {
    controllers.get(win)?.dispose();
  }
}

/** Re-mount the anchored global conversation on a library panel body.
 *  Used by the standalone-window restore path, which otherwise resolves the
 *  body against a paper item. */
export function remountLibraryPanelBody(body: Element): boolean {
  const win = body.ownerDocument?.defaultView;
  if (!win) return false;
  const controller = controllers.get(win);
  if (!controller || controller.body !== body) return false;
  void mountLibraryPanelConversation(controller);
  return true;
}
