import { assert } from "chai";
import {
  getReaderPanelContainerForTab,
  isPanelInReaderContextForTab,
  resolveReaderPopupPanelTarget,
  resolveStandalonePopupPanelTarget,
} from "../src/modules/contextPanel/readerPopupPanelRouting";

class FakeElement {
  readonly nodeType = 1;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  isConnected = true;
  ownerDocument!: FakeDocument;
  parentElement: FakeElement | null = null;
  selectedPanel?: FakeElement | null;
  selectedIndex?: number;

  append(...children: FakeElement[]) {
    for (const child of children) {
      child.parentElement = this;
      child.ownerDocument = this.ownerDocument;
      this.children.push(child);
    }
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  private selectorMatches(selector: string): boolean {
    if (selector.startsWith("#")) {
      return this.getAttribute("id") === selector.slice(1);
    }
    if (selector.startsWith(".")) {
      const token = selector.slice(1);
      return (this.getAttribute("class") || "")
        .split(/\s+/)
        .includes(token);
    }
    return false;
  }

  matches(selector: string): boolean {
    return this.selectorMatches(selector);
  }

  querySelector(selector: string): FakeElement | null {
    if (this.selectorMatches(selector)) return this;
    for (const child of this.children) {
      const match = child.querySelector(selector);
      if (match) return match;
    }
    return null;
  }

  contains(candidate: unknown): boolean {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }
}

class FakeDocument {
  private readonly byID = new Map<string, FakeElement>();

  register(element: FakeElement, id: string) {
    element.setAttribute("id", id);
    this.byID.set(id, element);
  }

  getElementById(id: string): FakeElement | null {
    return this.byID.get(id) ?? null;
  }
}

function buildReaderTabs() {
  const doc = new FakeDocument();
  const deck = new FakeElement();
  deck.ownerDocument = doc;
  doc.register(deck, "tabs-deck");

  const buildTab = (tabID: string) => {
    const tabContent = new FakeElement();
    tabContent.ownerDocument = doc;
    const panel = new FakeElement();
    panel.ownerDocument = doc;
    panel.setAttribute("class", "llm-reader-panel");
    doc.register(panel, `llmforzotero-reader-panel-${tabID}`);
    const root = new FakeElement();
    root.ownerDocument = doc;
    root.setAttribute("id", "llm-main");
    panel.append(root);
    tabContent.append(panel);
    deck.append(tabContent);
    return { tabContent, panel, root };
  };

  const stale = buildTab("tab-stale");
  const active = buildTab("tab-active");
  deck.selectedPanel = active.tabContent;
  return {
    doc: doc as unknown as Document,
    stalePanel: stale.panel as unknown as Element,
    staleRoot: stale.root as unknown as Element,
    activePanel: active.panel as unknown as Element,
    activeRoot: active.root as unknown as Element,
  };
}

function buildStandalonePanel() {
  const doc = new FakeDocument();
  const deck = new FakeElement();
  deck.ownerDocument = doc;
  doc.register(deck, "tabs-deck");
  const body = new FakeElement();
  const root = new FakeElement();
  body.ownerDocument = doc;
  root.ownerDocument = doc;
  root.setAttribute("id", "llm-main");
  root.setAttribute("data-standalone", "true");
  body.append(root);
  return {
    body: body as unknown as Element,
    root: root as unknown as Element,
  };
}

describe("reader popup panel routing", function () {
  it("selects the reader panel owned by the reader tab", function () {
    const { doc, activePanel, activeRoot, staleRoot } = buildReaderTabs();

    assert.strictEqual(
      getReaderPanelContainerForTab(doc, "tab-active"),
      activePanel,
    );
    assert.isTrue(isPanelInReaderContextForTab(activeRoot, "tab-active"));
    assert.isFalse(isPanelInReaderContextForTab(staleRoot, "tab-active"));
  });

  it("uses the selected tab's panel when the reader tab ID is unavailable", function () {
    const { doc, activePanel } = buildReaderTabs();

    assert.strictEqual(getReaderPanelContainerForTab(doc, null), activePanel);
  });

  it("does not fall back to another window's panel for a known tab ID", function () {
    const { doc } = buildReaderTabs();

    assert.isNull(getReaderPanelContainerForTab(doc, "tab-in-another-window"));
  });

  it("does not mistake a connected panel outside the reader tabs for active", function () {
    const { doc } = buildReaderTabs();
    const libraryPanelRoot = new FakeElement();
    libraryPanelRoot.ownerDocument = doc as unknown as FakeDocument;

    assert.isFalse(
      isPanelInReaderContextForTab(
        libraryPanelRoot as unknown as Element,
        "tab-active",
      ),
    );
  });

  it("returns the exact panel target for a known reader tab", function () {
    const { doc, activePanel, activeRoot } = buildReaderTabs();

    const target = resolveReaderPopupPanelTarget({
      preferredDocument: doc,
      documents: [doc],
      tabID: "tab-active",
    });

    assert.strictEqual(target?.body, activePanel);
    assert.strictEqual(target?.root, activeRoot);
  });

  it("uses only the preferred window's selected panel without a tab ID", function () {
    const preferred = buildReaderTabs();
    const other = buildReaderTabs();

    const target = resolveReaderPopupPanelTarget({
      preferredDocument: preferred.doc,
      documents: [preferred.doc, other.doc],
      tabID: null,
    });

    assert.strictEqual(target?.root, preferred.activeRoot);
  });

  it("finds a known tab in another Zotero window", function () {
    const preferred = buildReaderTabs();
    const other = buildReaderTabs();
    const otherDoc = other.doc as unknown as FakeDocument;
    const otherPanel = new FakeElement();
    otherPanel.ownerDocument = otherDoc;
    otherPanel.setAttribute("class", "llm-reader-panel");
    otherDoc.register(otherPanel, "llmforzotero-reader-panel-tab-other-window");
    const otherRoot = new FakeElement();
    otherRoot.ownerDocument = otherDoc;
    otherRoot.setAttribute("id", "llm-main");
    otherPanel.append(otherRoot);

    const target = resolveReaderPopupPanelTarget({
      preferredDocument: preferred.doc,
      documents: [preferred.doc, other.doc],
      tabID: "tab-other-window",
    });

    assert.strictEqual(target?.root, otherRoot as unknown as Element);
  });

  it("refuses an ambiguous known tab across multiple windows", function () {
    const first = buildReaderTabs();
    const second = buildReaderTabs();

    assert.isNull(
      resolveReaderPopupPanelTarget({
        documents: [first.doc, second.doc],
        tabID: "tab-active",
      }),
    );
  });

  it("refuses multiple selected panels when no preferred window exists", function () {
    const first = buildReaderTabs();
    const second = buildReaderTabs();

    assert.isNull(
      resolveReaderPopupPanelTarget({
        documents: [first.doc, second.doc],
        tabID: null,
      }),
    );
  });

  it("returns the standalone chat target outside the reader tabs", function () {
    const reader = buildReaderTabs();
    const standalone = buildStandalonePanel();

    const target = resolveStandalonePopupPanelTarget([
      reader.activePanel,
      standalone.body,
    ]);

    assert.strictEqual(target?.body, standalone.body);
    assert.strictEqual(target?.root, standalone.root);
  });

  it("ignores a disconnected standalone chat target", function () {
    const standalone = buildStandalonePanel();
    (standalone.body as unknown as FakeElement).isConnected = false;

    assert.isNull(resolveStandalonePopupPanelTarget([standalone.body]));
  });

  it("refuses multiple live standalone chat targets", function () {
    const first = buildStandalonePanel();
    const second = buildStandalonePanel();

    assert.isNull(resolveStandalonePopupPanelTarget([first.body, second.body]));
  });
});
