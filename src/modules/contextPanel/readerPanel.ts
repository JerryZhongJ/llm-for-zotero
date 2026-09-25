/**
 * Reader Chat Panel
 *
 * A per-reader-tab chat surface overlaid at the bottom of the reader tab
 * container (reader._tabContainer in the main window's #tabs-deck), toggled
 * by a toolbar button injected through the Zotero.Reader "renderToolbar"
 * hook. Each panel anchors the paper conversation of its reader tab's
 * attachment. Like the library bottom panel it owns its scrolling: the
 * container has a fixed height and only .llm-messages scrolls, so the chat
 * never joins any other scroll context.
 *
 * The panel is absolutely positioned instead of shrinking the reader
 * browser: the iframe keeps full height, so the reader's own sidebar
 * (outline, bottom:0 inside the iframe) keeps full height alongside the
 * panel, and the opaque panel simply overlays the bottom of the pages
 * area. Writing the reader's internal "bottom placeholder" state instead
 * was tried and abandoned: reads of the content-side React state from
 * chrome are unreliable, which made the re-assert guard misfire and sent
 * the reader into an unbounded re-render loop (100% CPU, toolbar buttons
 * flickering away).
 *
 * Controllers are keyed by reader tabID (one panel per reader tab); tab
 * lifecycle is driven by a Zotero.Notifier observer on 'tab' events.
 */

import { config } from "./constants";
import {
  activeContextPanels,
  activeContextPanelRawItems,
  activeContextPanelStateSync,
} from "./state";
import { resolveInitialPanelItemState } from "./portalScope";
import {
  getReaderPanelEnabledPref,
  setReaderPanelEnabledPref,
  getReaderPanelHeightPref,
  setReaderPanelHeightPref,
  applyPanelFontScale,
} from "./prefHelpers";
import { buildUI } from "./buildUI";
import { persistPendingChatScrollRestoreFromBody } from "./chatScrollSnapshots";
import { disposeSetupHandlers, setupHandlers } from "./setupHandlers";
import { ensureConversationLoaded, refreshChat } from "./chat";
import { renderShortcuts } from "./shortcuts";
import { getFirstSelectedLibraryContextItem } from "./ambientContext";
import { notifyEmbeddedItemChange } from "./itemChangeBus";
import {
  computeReaderPanelInsets,
  computeSidebarRailInsets,
} from "./readerPanelGeometry";
import {
  retainClaudeRuntimeForBody,
  releaseClaudeRuntimeForBody,
} from "../../claudeCode/runtimeRetention";

const READER_PANEL_ID_PREFIX = "llmforzotero-reader-panel";
const READER_PANEL_CONTAINER_CLASS = "llm-reader-panel";
const READER_PANEL_BODY_CLASS = "llm-reader-panel-body";
const READER_PANEL_RESIZER_CLASS = "llm-reader-panel-resizer";
// Marks a Zotero tab-content element as hosting a docked reader panel; CSS
// makes it the positioning context for the absolutely-positioned panel.
const READER_HOST_CLASS = "llm-reader-host";
const READER_PANEL_TOGGLE_ID = "llmforzotero-reader-chat-toggle";
// Inline copy of the addon logo (addon/content/icons/icon.svg body): the
// reader iframe is a content document, so chrome:// icon URLs will not load
// there and the icon must travel with the element. All colors are set via
// inline style attributes — the reader toolbar CSS overrides SVG fill/stroke
// presentation attributes with currentColor, and only inline styles outrank
// it.
const READER_PANEL_TOGGLE_ICON_PATHS = `
  <path style="fill:#CED8DC" d="M256 50 A88 88 0 0 0 100 104 A86 86 0 0 0 50 258 A120 120 0 0 0 104 412 A85.5 85.5 0 0 0 256 462 A85.5 85.5 0 0 0 408 412 A120 120 0 0 0 462 258 A86 86 0 0 0 412 104 A88 88 0 0 0 256 50 Z" />
  <g style="stroke:#000;fill:none" stroke-linecap="round" stroke-linejoin="round">
    <path style="stroke-width:32;fill:none" d="M256 50 A88 88 0 0 0 100 104 A86 86 0 0 0 50 258 A120 120 0 0 0 104 412 A85.5 85.5 0 0 0 256 462 A85.5 85.5 0 0 0 408 412 A120 120 0 0 0 462 258 A86 86 0 0 0 412 104 A88 88 0 0 0 256 50 Z" />
    <path style="stroke-width:25;fill:none" d="M104 100 C130 110 146 128 149 148 C150 155 151 163 149 170" />
    <path style="stroke-width:25;fill:none" d="M412 102 C384 109 362 124 358 148 C355 170 364 187 382 193 C397 197 407 189 406 178" />
    <path style="stroke-width:31;fill:none" d="M255.5 192 L255.5 458 M149 298 L252 458 M362 298 L259 458" />
  </g>
  <circle style="fill:#000" cx="255.5" cy="192" r="41.5" />
  <circle style="fill:#000" cx="149" cy="298" r="41.5" />
  <circle style="fill:#000" cx="362" cy="298" r="41.5" />
  <circle style="fill:#2196F3" cx="255.5" cy="192" r="11.5" />
  <circle style="fill:#2196F3" cx="149" cy="298" r="11.5" />
  <circle style="fill:#2196F3" cx="362" cy="298" r="11.5" />
`;

type ReaderLike = {
  tabID?: string;
  _tabID?: string;
  itemID?: number;
  _item?: Zotero.Item;
  _tabContainer?: Element;
  _iframe?: Element;
  _splitViewContainer?: HTMLElement;
  _sidebarOpen?: boolean;
  _sidebarWidth?: number;
  _internalReader?: {
    _splitViewContainer?: HTMLElement;
    _lastView?: { _iframeWindow?: Window };
    _primaryView?: { _iframeWindow?: Window };
    _state?: { sidebarOpen?: boolean; sidebarWidth?: number };
  };
};

type RectLike = Pick<DOMRectReadOnly, "left" | "right" | "width" | "height">;

type ReaderPanelController = {
  win: _ZoteroTypes.MainWindow;
  doc: Document;
  tabID: string;
  reader: ReaderLike;
  container: HTMLElement | null;
  body: HTMLElement | null;
  mounted: boolean;
  cancelled: boolean;
  open: boolean;
  sidebarResizeObserver: ResizeObserver | null;
  sidebarResizeTarget: Element | null;
  sidebarMutationObserver: MutationObserver | null;
  sidebarMutationBody: HTMLElement | null;
  readerLoadTarget: Element | null;
  readerLoadListener: EventListener | null;
  dispose: () => void;
};

const controllers = new Map<string, ReaderPanelController>();

let tabNotifierID: string | null = null;
type ToolbarEventHandler = (event: {
  reader?: unknown;
  doc?: Document;
  append?: (el: Element) => void;
}) => void;
let toolbarHandler: ToolbarEventHandler | null = null;

export function isReaderPanelBody(body: Element): boolean {
  return (
    (body as HTMLElement).classList?.contains(READER_PANEL_BODY_CLASS) === true
  );
}

function getReaderTabID(reader: ReaderLike | null | undefined): string {
  const raw = reader?.tabID ?? reader?._tabID;
  return raw ? `${raw}` : "";
}

function getReaderItem(
  reader: ReaderLike | null | undefined,
): Zotero.Item | null {
  const direct = reader?._item;
  if (direct) return direct;
  const itemID = Number(reader?.itemID);
  if (Number.isFinite(itemID) && itemID > 0) {
    return Zotero.Items.get(itemID) || null;
  }
  return null;
}

// ── Panel container & mount ────────────────────────────────────────────────

function ensurePanelContainer(controller: ReaderPanelController): boolean {
  if (controller.container || controller.cancelled) return true;
  const tabContainer = controller.reader._tabContainer;
  if (!tabContainer || !(tabContainer as Element).isConnected) return false;
  const doc = controller.doc;
  // The host class gives the absolutely-positioned panel a positioning
  // context; the reader browser keeps filling the tab and the reader is told
  // to reserve the panel's height inside its own layout.
  tabContainer.classList.add(READER_HOST_CLASS);
  const container = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLElement;
  container.id = `${READER_PANEL_ID_PREFIX}-${controller.tabID}`;
  container.className = READER_PANEL_CONTAINER_CLASS;
  container.dataset.tabId = controller.tabID;
  container.style.height = `${getReaderPanelHeightPref()}px`;
  const resizer = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLElement;
  resizer.className = READER_PANEL_RESIZER_CLASS;
  const body = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLElement;
  body.className = READER_PANEL_BODY_CLASS;
  container.append(resizer, body);
  tabContainer.append(container);
  controller.container = container;
  controller.body = body;
  attachResizer(controller);
  controller.open = getReaderPanelEnabledPref();
  if (!controller.open) {
    container.style.display = "none";
  }
  ensureReaderDocumentLoadListener(controller);
  applyPanelInset(controller);
  ensureSidebarInsetObserver(controller);
  scheduleToolbarButtonSweep(controller);
  return true;
}

async function mountReaderPanelConversation(
  controller: ReaderPanelController,
): Promise<void> {
  const { body } = controller;
  if (!body || controller.cancelled) return;
  const rawItem = getReaderItem(controller.reader);
  if (!rawItem) {
    ztoolkit.log("LLM: reader panel could not resolve a paper item");
    return;
  }
  const resolvedState = resolveInitialPanelItemState(rawItem, {
    conversationMode: "paper",
  });
  const pinnedItem = resolvedState.item;
  if (!pinnedItem) {
    ztoolkit.log("LLM: reader panel could not resolve a paper conversation");
    return;
  }
  try {
    persistPendingChatScrollRestoreFromBody(body);
    buildUI(body, pinnedItem);
    const llmMain = body.querySelector("#llm-main") as HTMLElement | null;
    if (llmMain) {
      llmMain.dataset.readerPanel = "true";
      llmMain.dataset.conversationKind = "paper";
      llmMain.dataset.itemId = `${Number(pinnedItem.id || 0) || ""}`;
      const rawId = String(Number(rawItem.id || 0) || "");
      llmMain.dataset.rawContextItemId = rawId;
      llmMain.dataset.contextItemId = rawId;
      llmMain.dataset.contextOwnerItemId = rawId;
    }
    // The anchor starts at the resolved paper conversation. setupHandlers'
    // syncConversationIdentity replaces this entry whenever the user switches
    // conversations, so the anchor always tracks the displayed conversation.
    activeContextPanels.set(body, () => pinnedItem);
    activeContextPanelRawItems.set(body, rawItem);
    void retainClaudeRuntimeForBody(body, pinnedItem);
    setupHandlers(body, pinnedItem);
    controller.mounted = true;
  } catch (err) {
    ztoolkit.log("LLM: reader panel mount failed", err);
    return;
  }
  try {
    await ensureConversationLoaded(pinnedItem);
    if (controller.cancelled || !controller.mounted) return;
    refreshChat(body, pinnedItem);
    void renderShortcuts(body, pinnedItem, "paper");
    const llmMain = body.querySelector("#llm-main") as HTMLElement | null;
    applyPanelFontScale(llmMain);
  } catch (err) {
    ztoolkit.log("LLM: reader panel conversation load failed", err);
  }
}

function remountReaderPanel(controller: ReaderPanelController): void {
  if (controller.cancelled || !controller.body) return;
  void mountReaderPanelConversation(controller);
}

// ── Sidebar inset (keep the panel inside the reading area) ─────────────────

// The reader's own sidebar (outline/thumbnails) lives INSIDE the reader
// iframe, so from the main window the tab container has no left rail. The
// inset is event-driven: the reader UI's class and sidebar-width style
// signal sidebar changes, while a ResizeObserver follows the pages area,
// iframe, and context-pane splitter. Observer attachment is retried during
// toolbar startup because a restored reader can mount its UI later.

function getReaderViewContainer(
  controller: ReaderPanelController,
): HTMLElement | null {
  const reader = controller.reader;
  const candidate =
    reader._internalReader?._splitViewContainer ??
    reader._splitViewContainer ??
    null;
  return candidate?.isConnected ? candidate : null;
}

// The reader's pages area: a .split-view element that sits right of the
// outline sidebar inside the reader iframe. Because the sidebar is
// conditionally mounted by React, this element's left edge tracks BOTH
// sidebar toggling and sidebar drags — DOM geometry reads are reliable from
// chrome, unlike the content-side React state (see the overlay-docking
// lesson in this file's header).
function getReaderSplitViewElement(reader: ReaderLike): Element | null {
  try {
    return getReaderContentDoc(reader)?.querySelector(".split-view") ?? null;
  } catch {
    return null;
  }
}

// The body class is Zotero's immediate open/closed signal. React can mount
// #sidebarContainer a moment after that class changes, so use the live CSS
// width until its rectangle is available. On close, the class clears first
// and the inset must collapse to zero even if the old element still exists.
function getReaderSidebarRect(reader: ReaderLike): RectLike | null {
  try {
    const doc = getReaderContentDoc(reader);
    if (!doc?.body?.classList.contains("sidebar-open")) return null;
    const rect = doc
      .getElementById("sidebarContainer")
      ?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.left >= 0) return rect;
    const cssWidth = Number.parseFloat(
      doc.documentElement.style.getPropertyValue("--sidebar-width"),
    );
    const state = reader._internalReader?._state;
    const width =
      Number.isFinite(cssWidth) && cssWidth > 0
        ? cssWidth
        : Number(reader._sidebarWidth ?? state?.sidebarWidth);
    if (!Number.isFinite(width) || width <= 0) return null;
    return { left: 0, right: width, width, height: 1 };
  } catch {
    return null;
  }
}

function getReaderPanelInsets(controller: ReaderPanelController): {
  left: number;
  right: number;
} {
  try {
    const reader = controller.reader;
    const iframe = reader._iframe;
    const host = reader._tabContainer;
    const state = reader._internalReader?._state;
    const open = reader._sidebarOpen ?? state?.sidebarOpen;
    const width = Math.floor(
      Number(reader._sidebarWidth ?? state?.sidebarWidth),
    );
    const fallbackLeft =
      open && Number.isFinite(width) && width > 0 ? width : 0;
    if (!host) return { left: fallbackLeft, right: 0 };

    const splitter = controller.win.ZoteroContextPane?.splitter;
    const splitterRect = splitter?.isConnected
      ? splitter.getBoundingClientRect()
      : undefined;
    const hostRect = host.getBoundingClientRect();
    // Measure the sidebar rail, including the brief interval before React
    // mounts its element after the open class is set.
    if (iframe) {
      return computeSidebarRailInsets({
        hostRect,
        frameRect: iframe.getBoundingClientRect(),
        sidebarRect: getReaderSidebarRect(reader) ?? undefined,
        splitViewRect:
          getReaderSplitViewElement(reader)?.getBoundingClientRect(),
        splitterRect,
      });
    }
    // No iframe to anchor on: fall back to the legacy view-container
    // measurement (left comes from the state-based fallback).
    const viewContainer = getReaderViewContainer(controller);
    return computeReaderPanelInsets({
      hostRect,
      viewRect: viewContainer?.getBoundingClientRect(),
      splitterRect,
      fallbackLeft,
    });
  } catch {
    return { left: 0, right: 0 };
  }
}

function applyPanelInset(controller: ReaderPanelController): void {
  if (!controller.container) return;
  const insets = controller.open
    ? getReaderPanelInsets(controller)
    : { left: 0, right: 0 };
  for (const [side, inset] of [
    ["left", insets.left],
    ["right", insets.right],
  ] as const) {
    const value = inset > 0 ? `${inset}px` : "";
    if (controller.container.style[side] !== value) {
      controller.container.style[side] = value;
    }
  }
}

function disconnectSidebarObserver(
  observer: MutationObserver | ResizeObserver | null,
): void {
  try {
    observer?.disconnect();
  } catch {
    // A browser navigation can invalidate an observer's old document.
  }
}

function ensureSidebarInsetObserver(controller: ReaderPanelController): void {
  // Zotero toggles body.sidebar-open and writes --sidebar-width on the UI
  // document root. Observe those signals directly because an early
  // ResizeObserver may be attached before the reader view has mounted.
  let uiDoc: Document | null = null;
  try {
    uiDoc = getReaderContentDoc(controller.reader);
  } catch {
    // The browser may be navigating while a restored reader initializes.
  }
  if (uiDoc?.body && controller.sidebarMutationBody !== uiDoc.body) {
    disconnectSidebarObserver(controller.sidebarMutationObserver);
    controller.sidebarMutationObserver = null;
    controller.sidebarMutationBody = null;
    const MutationObserverCtor = uiDoc.defaultView?.MutationObserver;
    if (MutationObserverCtor) {
      const observer = new MutationObserverCtor(() => {
        applyPanelInset(controller);
      });
      observer.observe(uiDoc.body, {
        attributes: true,
        attributeFilter: ["class"],
      });
      observer.observe(uiDoc.documentElement, {
        attributes: true,
        attributeFilter: ["style"],
      });
      controller.sidebarMutationObserver = observer;
      controller.sidebarMutationBody = uiDoc.body;
    }
  }
  // The live pages area is the best observation target: it resizes when the
  // sidebar toggles (width grows as the sidebar unmounts) and while it is
  // dragged, so both paths update the inset immediately.
  const target =
    getReaderSplitViewElement(controller.reader) ??
    getReaderViewContainer(controller);
  if (
    target &&
    controller.sidebarResizeTarget === target &&
    controller.sidebarResizeObserver
  ) {
    return;
  }
  disconnectSidebarObserver(controller.sidebarResizeObserver);
  controller.sidebarResizeObserver = null;
  controller.sidebarResizeTarget = null;
  if (!target) return;
  const ResizeObserverCtor = target.ownerDocument.defaultView?.ResizeObserver;
  if (!ResizeObserverCtor) return;
  const observer = new ResizeObserverCtor(() => {
    applyPanelInset(controller);
  });
  observer.observe(target);
  const iframe = controller.reader._iframe;
  if (iframe?.isConnected) {
    try {
      observer.observe(iframe);
    } catch {
      // Cross-document XUL elements are not accepted on every Zotero version.
    }
  }
  const splitterParent =
    controller.win.ZoteroContextPane?.splitter?.parentElement;
  if (splitterParent?.isConnected) {
    try {
      observer.observe(splitterParent);
    } catch {
      // Cross-document XUL elements are not accepted on every Zotero version.
    }
  }
  controller.sidebarResizeObserver = observer;
  controller.sidebarResizeTarget = target;
}

function ensureReaderDocumentLoadListener(
  controller: ReaderPanelController,
): void {
  const frame = controller.reader._iframe;
  if (!frame || controller.readerLoadTarget === frame) return;
  if (controller.readerLoadTarget && controller.readerLoadListener) {
    controller.readerLoadTarget.removeEventListener(
      "load",
      controller.readerLoadListener,
      true,
    );
  }
  const listener: EventListener = () => {
    if (controller.cancelled) return;
    // A capturing load event can arrive before Reader._iframeWindow points
    // at the new document. Rebind on the following task.
    void Zotero.Promise.delay(0).then(() => {
      if (controller.cancelled) return;
      disconnectSidebarObserver(controller.sidebarMutationObserver);
      controller.sidebarMutationObserver = null;
      controller.sidebarMutationBody = null;
      disconnectSidebarObserver(controller.sidebarResizeObserver);
      controller.sidebarResizeObserver = null;
      controller.sidebarResizeTarget = null;
      ensureSidebarInsetObserver(controller);
      applyPanelInset(controller);
      scheduleToolbarButtonSweep(controller);
    });
  };
  frame.addEventListener("load", listener, true);
  controller.readerLoadTarget = frame;
  controller.readerLoadListener = listener;
}

function attachResizer(controller: ReaderPanelController): void {
  const { doc, container } = controller;
  const resizer = container?.querySelector(
    `.${READER_PANEL_RESIZER_CLASS}`,
  ) as HTMLElement | null;
  if (!resizer || !container) return;
  resizer.addEventListener("mousedown", (event: Event) => {
    const mouseEvent = event as MouseEvent;
    if (mouseEvent.button !== 0) return;
    event.preventDefault();
    const startY = mouseEvent.clientY;
    const startHeight = container.getBoundingClientRect().height;
    const clamp = (value: number): number => {
      const parsed = Math.floor(Number(value));
      if (!Number.isFinite(parsed)) return startHeight;
      return Math.max(200, Math.min(parsed, 2000));
    };
    // While dragging, the cursor leads the panel's top edge and hovers over
    // the reader browser — without this, the iframe swallows the mousemoves
    // and the edge jitters as it keeps falling behind and catching up.
    // Disabling pointer events on the browser for the duration of the drag
    // keeps every event in the main window; only the 4px resizer separates
    // the panel from the browser anyway.
    const frame = controller.reader._iframe as HTMLElement | null;
    const restoreFrameEvents = (): void => {
      if (frame) frame.style.pointerEvents = "";
    };
    if (frame) frame.style.pointerEvents = "none";
    const onMouseMove = (moveEvent: Event) => {
      const dy = (moveEvent as MouseEvent).clientY - startY;
      container.style.height = `${clamp(startHeight - dy)}px`;
    };
    const onMouseUp = () => {
      doc.removeEventListener("mousemove", onMouseMove);
      doc.removeEventListener("mouseup", onMouseUp);
      restoreFrameEvents();
      setReaderPanelHeightPref(clamp(container.getBoundingClientRect().height));
    };
    doc.addEventListener("mousemove", onMouseMove);
    doc.addEventListener("mouseup", onMouseUp);
  });
}

// ── Toolbar button (Zotero.Reader renderToolbar hook) ──────────────────────

// The reader toolbar's CustomSections component re-fires "renderToolbar" on
// every React render, so a listener registered before a reader's FIRST
// toolbar render keeps the button alive forever after. Registering at
// onMainWindowLoad lost that race to session-restored readers (the toggle
// was missing until the tab was reopened); hooks.ts now calls this at the
// very top of startup, retrying briefly until the Zotero.Reader module
// exists. Session restore can STILL render a toolbar before the plugin
// loads at all, so ensurePanelContainer also starts the bounded
// scheduleToolbarButtonSweep as the belt to these suspenders.
export function registerReaderToolbarListenerWhenReady(attempt = 0): void {
  const readerAPI = Zotero.Reader as
    | {
        registerEventListener?: (
          type: string,
          handler: ToolbarEventHandler,
          pluginID?: string,
        ) => void;
      }
    | undefined;
  if (readerAPI?.registerEventListener && !toolbarHandler) {
    readerAPI.registerEventListener(
      "renderToolbar",
      getToolbarHandler(),
      config.addonID,
    );
    return;
  }
  if (toolbarHandler) return;
  if (attempt >= 120) {
    ztoolkit.log("LLM: Zotero.Reader never became ready; toolbar button off");
    return;
  }
  void Zotero.Promise.delay(250).then(() =>
    registerReaderToolbarListenerWhenReady(attempt + 1),
  );
}

// The reader UI document: toolbar, outline sidebar, and .split-view all live
// in the OUTER browser element's document (the chrome-side Reader instance
// exposes it as _iframeWindow — verified against Zotero 9.0.6's xpcom code,
// which itself queries this document via getElementById). Do NOT reach for
// _internalReader._primaryView._iframeWindow: those are the NESTED pdf.js
// view iframes (one per split-view pane) — querying them for .toolbar,
// #sidebarContainer, or .custom-sections silently finds nothing.
function getReaderContentDoc(reader: ReaderLike): Document | null {
  const win =
    (reader as { _iframeWindow?: Window })._iframeWindow ??
    (reader as { _iframe?: { contentWindow?: Window } })._iframe
      ?.contentWindow ??
    null;
  const doc = win?.document ?? null;
  return doc ? (doc as Document) : null;
}

// Belt to the early-registration suspenders: on this machine even a
// startup-registered renderToolbar listener can lose to session-restored
// readers (the toolbar rendered before the plugin loaded at all). Retry
// injecting the toggle until it sticks, then stop — the official event
// maintains it afterwards. Returns true once the button exists.
function injectToolbarButtonIfMissing(
  controller: ReaderPanelController,
): boolean {
  if (!controller.container || controller.cancelled) return false;
  let doc: Document | null = null;
  try {
    doc = getReaderContentDoc(controller.reader);
  } catch {
    return false;
  }
  if (!doc) return false;
  try {
    if (doc.getElementById(READER_PANEL_TOGGLE_ID)) return true;
    const customSections = doc.querySelector(".toolbar .custom-sections");
    if (!customSections) return false;
    getToolbarHandler()({
      reader: controller.reader,
      doc,
      append: (el) => {
        const section = doc.createElement("div");
        section.className = "section";
        section.append(el);
        customSections.append(section);
      },
    });
    return true;
  } catch (err) {
    ztoolkit.log("LLM: reader toolbar button sweep failed", err);
    return false;
  }
}

const TOOLBAR_SWEEP_INTERVAL_MS = 400;
const TOOLBAR_SWEEP_MAX_ATTEMPTS = 75; // ~30s covers slow startup restores

function scheduleToolbarButtonSweep(
  controller: ReaderPanelController,
  attempt = 0,
): void {
  if (controller.cancelled) return;
  ensureSidebarInsetObserver(controller);
  applyPanelInset(controller);
  if (injectToolbarButtonIfMissing(controller)) return;
  if (attempt >= TOOLBAR_SWEEP_MAX_ATTEMPTS) return;
  void Zotero.Promise.delay(TOOLBAR_SWEEP_INTERVAL_MS).then(() =>
    scheduleToolbarButtonSweep(controller, attempt + 1),
  );
}

function toggleReaderPanel(tabID: string): void {
  const controller = controllers.get(tabID);
  if (!controller || !controller.container) return;
  if (controller.open) {
    controller.open = false;
    controller.container.style.display = "none";
    setReaderPanelEnabledPref(false);
  } else {
    controller.open = true;
    controller.container.style.display = "";
    setReaderPanelEnabledPref(true);
    // A first-ever open (or one after a failed mount) must mount here —
    // otherwise the toggle reveals an empty container.
    if (!controller.mounted) {
      remountReaderPanel(controller);
    }
  }
  applyPanelInset(controller);
}

function getToolbarHandler(): ToolbarEventHandler {
  if (toolbarHandler) return toolbarHandler;
  toolbarHandler = (event) => {
    const reader = event.reader as ReaderLike | undefined;
    const tabID = getReaderTabID(reader);
    if (!tabID || !event.doc || typeof event.append !== "function") return;
    // renderToolbar re-fires on toolbar re-renders without clearing our
    // previous button, and the startup sweep can have injected one already.
    // Duplicate ids hide from getElementById, so sweep by attribute selector.
    event.doc
      .querySelectorAll(`[id="${READER_PANEL_TOGGLE_ID}"]`)
      .forEach((el) => el.remove());
    syncReaderPanels();
    const controller = controllers.get(tabID);
    if (controller) {
      ensureSidebarInsetObserver(controller);
      applyPanelInset(controller);
    }
    const open = controller?.open ?? getReaderPanelEnabledPref();
    // The button lives in the reader iframe document, which neither our
    // main-window stylesheet nor chrome:// icon URLs reach (content doc) —
    // so the icon is an inline SVG and everything else is inline styling.
    // The toolbar re-renders (and wipes custom sections) on every React
    // render, so build it fresh and read the open state from the
    // controller/pref, never from the element.
    const doc = event.doc;
    const button = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    button.id = READER_PANEL_TOGGLE_ID;
    button.className = "toolbar-button";
    button.title = "Chat with LLM";
    button.setAttribute("aria-pressed", open ? "true" : "false");
    button.style.cssText = [
      "width:28px",
      "height:28px",
      "flex:0 0 auto",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "box-sizing:border-box",
      "border-radius:5px",
      "cursor:pointer",
      open ? "background:var(--fill-quinary, rgba(128,128,128,0.25))" : "",
    ].join(";");
    const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "-85 -85 682 682");
    icon.setAttribute("width", "18");
    icon.setAttribute("height", "18");
    const iconBody = doc.createElementNS("http://www.w3.org/2000/svg", "g");
    iconBody.innerHTML = READER_PANEL_TOGGLE_ICON_PATHS;
    icon.append(iconBody);
    button.append(icon);
    button.addEventListener("click", () => {
      // Re-resolve at click time: a session-restored reader can render its
      // toolbar before its controller exists, so a tabID captured at button
      // creation may find nothing in the controllers map. Sync once, then
      // toggle whichever tab the reader reports now.
      let currentTabID = getReaderTabID(reader) || tabID;
      if (!controllers.get(currentTabID)) {
        syncReaderPanels();
        currentTabID = getReaderTabID(reader) || tabID;
      }
      toggleReaderPanel(currentTabID);
      const nowOpen = controllers.get(currentTabID)?.open ?? false;
      button.setAttribute("aria-pressed", nowOpen ? "true" : "false");
      button.style.background = nowOpen
        ? "var(--fill-quinary, rgba(128,128,128,0.25))"
        : "";
    });
    event.append(button);
  };
  return toolbarHandler;
}

// ── Tab lifecycle ──────────────────────────────────────────────────────────

function createController(
  reader: ReaderLike,
  tabID: string,
): ReaderPanelController {
  const tabContainer = reader._tabContainer as Element;
  const win = tabContainer.ownerDocument
    ?.defaultView as unknown as _ZoteroTypes.MainWindow;
  const controller: ReaderPanelController = {
    win,
    doc: win.document,
    tabID,
    reader,
    container: null,
    body: null,
    mounted: false,
    cancelled: false,
    open: false,
    sidebarResizeObserver: null,
    sidebarResizeTarget: null,
    sidebarMutationObserver: null,
    sidebarMutationBody: null,
    readerLoadTarget: null,
    readerLoadListener: null,
    dispose: () => {
      controller.cancelled = true;
      disconnectSidebarObserver(controller.sidebarResizeObserver);
      controller.sidebarResizeObserver = null;
      controller.sidebarResizeTarget = null;
      disconnectSidebarObserver(controller.sidebarMutationObserver);
      controller.sidebarMutationObserver = null;
      controller.sidebarMutationBody = null;
      if (controller.readerLoadTarget && controller.readerLoadListener) {
        controller.readerLoadTarget.removeEventListener(
          "load",
          controller.readerLoadListener,
          true,
        );
      }
      controller.readerLoadTarget = null;
      controller.readerLoadListener = null;
      // A drag interrupted by tab teardown must not leave the reader
      // browser with pointer events disabled.
      (controller.reader._iframe as HTMLElement | null)?.style.removeProperty(
        "pointer-events",
      );
      if (controller.body) {
        disposeSetupHandlers(controller.body);
        void releaseClaudeRuntimeForBody(controller.body);
        activeContextPanels.delete(controller.body);
        activeContextPanelRawItems.delete(controller.body);
        activeContextPanelStateSync.delete(controller.body);
      }
      controller.mounted = false;
      const tabContainer = controller.reader
        ?._tabContainer as HTMLElement | null;
      controller.container?.remove();
      controller.container = null;
      controller.body = null;
      // Only drop the host class when no sibling panel remains, so closing
      // one reader panel does not disturb another tab's layout class.
      if (
        tabContainer &&
        !tabContainer.querySelector(`.${READER_PANEL_CONTAINER_CLASS}`)
      ) {
        tabContainer.classList.remove(READER_HOST_CLASS);
      }
      controllers.delete(controller.tabID);
    },
  };
  controllers.set(tabID, controller);
  return controller;
}

function syncReaderPanels(): void {
  const readerAPI = Zotero.Reader as unknown as
    | { _readers?: ReaderLike[] }
    | undefined;
  const readers = readerAPI?._readers || [];
  const seen = new Set<string>();
  for (const reader of readers) {
    const tabID = getReaderTabID(reader);
    const tabContainer = reader?._tabContainer;
    if (!tabID || !tabContainer || !(tabContainer as Element).isConnected) {
      continue;
    }
    seen.add(tabID);
    if (!controllers.has(tabID)) {
      const controller = createController(reader, tabID);
      if (!ensurePanelContainer(controller)) {
        controller.dispose();
        continue;
      }
      if (controller.open) {
        remountReaderPanel(controller);
      }
    }
  }
  for (const tabID of [...controllers.keys()]) {
    if (!seen.has(tabID)) {
      controllers.get(tabID)?.dispose();
    }
  }
}

function getSelectedReaderItemForNotifier(): Zotero.Item | null {
  try {
    const tabs = (Zotero as unknown as { Tabs?: { selectedID?: unknown } })
      .Tabs;
    const selectedID =
      tabs?.selectedID === undefined || tabs?.selectedID === null
        ? ""
        : `${tabs.selectedID}`;
    if (selectedID) {
      const reader = (
        Zotero.Reader as unknown as {
          getByTabID?: (tabID: string) => ReaderLike | undefined;
        }
      ).getByTabID?.(selectedID);
      const readerItem = getReaderItem(reader || null);
      if (readerItem) return readerItem;
    }
  } catch (_err) {
    void _err;
  }
  // Non-reader (library) tab: fall back to the library selection so the
  // standalone window keeps following the highlighted paper, mirroring the
  // old item-pane onItemChange notifications.
  try {
    const pane = Zotero.getActiveZoteroPane?.() as
      | { getSelectedItems?: () => Zotero.Item[] }
      | undefined;
    return getFirstSelectedLibraryContextItem(pane) || null;
  } catch (_err) {
    void _err;
  }
  return null;
}

const tabObserver = {
  notify: (event: string, type: string) => {
    if (type !== "tab") return;
    // Reader tabs register with Zotero.Reader after the tab notifier fires,
    // so the sweep is deferred to the next tick.
    void Zotero.Promise.delay(0)
      .then(() => syncReaderPanels())
      .catch((err: unknown) => {
        ztoolkit.log("LLM: reader panel tab sync failed", err);
      });
    if (event === "select") {
      try {
        notifyEmbeddedItemChange(getSelectedReaderItemForNotifier());
      } catch (err) {
        ztoolkit.log("LLM: reader panel item notify failed", err);
      }
    }
  },
};

// ── Public API ─────────────────────────────────────────────────────────────

export function registerReaderChatPanel(win: _ZoteroTypes.MainWindow): void {
  const readerAPI = Zotero.Reader as
    | {
        registerEventListener?: (
          type: string,
          handler: ToolbarEventHandler,
          pluginID?: string,
        ) => void;
      }
    | undefined;
  if (!toolbarHandler && readerAPI?.registerEventListener) {
    readerAPI.registerEventListener(
      "renderToolbar",
      getToolbarHandler(),
      config.addonID,
    );
  }
  if (tabNotifierID === null) {
    tabNotifierID = Zotero.Notifier.registerObserver(
      tabObserver as unknown as { notify: _ZoteroTypes.Notifier.Notify },
      ["tab"],
      "llmForZoteroReaderPanel",
    );
  }
  syncReaderPanels();
  void win;
}

export function unregisterReaderChatPanelsForWindow(win: Window): void {
  for (const controller of [...controllers.values()]) {
    if (controller.win === (win as _ZoteroTypes.MainWindow)) {
      controller.dispose();
    }
  }
}

export function unregisterAllReaderChatPanels(): void {
  if (toolbarHandler) {
    const readerAPI = Zotero.Reader as
      | {
          unregisterEventListener?: (
            type: string,
            handler: ToolbarEventHandler,
          ) => void;
        }
      | undefined;
    try {
      readerAPI?.unregisterEventListener?.("renderToolbar", toolbarHandler);
    } catch (err) {
      ztoolkit.log("LLM: reader panel toolbar listener unregister failed", err);
    }
    toolbarHandler = null;
  }
  if (tabNotifierID !== null) {
    try {
      Zotero.Notifier.unregisterObserver(tabNotifierID);
    } catch (err) {
      ztoolkit.log("LLM: reader panel tab observer unregister failed", err);
    }
    tabNotifierID = null;
  }
  for (const controller of [...controllers.values()]) {
    controller.dispose();
  }
}

/** Re-mount the anchored paper conversation on a reader panel body. Used by
 *  the standalone-window restore path, which otherwise resolves the body
 *  against the raw selection. */
export function remountReaderPanelBody(body: Element): boolean {
  for (const controller of controllers.values()) {
    if (controller.body === body) {
      remountReaderPanel(controller);
      return true;
    }
  }
  return false;
}

/** Test/dev seam: run the tab synchronizer immediately instead of waiting for
 *  the next deferred tab-notifier sweep. */
export function syncReaderPanelsNow(): void {
  syncReaderPanels();
}
