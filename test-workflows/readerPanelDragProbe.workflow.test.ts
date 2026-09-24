// Temporary diagnostic: simulates a real upward drag on the reader chat
// panel resizer and watches for the reported symptoms — toolbar custom
// sections rebuilding (flicker) and the chat button disappearing. Not part
// of the regression suite — delete after the docking fix lands.
import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

const PREF_PREFIX = "extensions.zotero.llmforzotero";

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

describe("workflow: reader panel drag probe", function () {
  this.timeout(30000);

  it("survives an upward resizer drag without flicker or button loss", async function () {
    const api = getWorkflowTestApi();
    Zotero.Prefs.set(`${PREF_PREFIX}.readerPanelEnabled`, true, true);
    Zotero.Prefs.set(`${PREF_PREFIX}.readerPanelHeight`, 260, true);

    const fixture = await api.createPaperWithPdfFixture({
      title: "Drag Probe Paper ln",
      pdfTitle: "Drag Probe PDF ln",
      pages: ["Page one drag probe", "Page two drag probe"],
    });

    const reader = await (Zotero.Reader as any).open(fixture.pdfAttachmentId, {
      pageIndex: 0,
    });
    assert.isOk(reader, "reader should open");
    await reader._initPromise;
    await Zotero.Promise.delay(2000);

    const mainDoc = reader._tabContainer.ownerDocument;
    const mainView = mainDoc.defaultView;
    const d = reader._iframe.contentDocument;
    const container = reader._tabContainer.querySelector(".llm-reader-panel");
    assert.isOk(container, "panel should be docked");
    const resizer = container.querySelector(".llm-reader-panel-resizer");
    assert.isOk(resizer, "resizer should exist");

    const buttonExists = (): boolean =>
      d.getElementById("llmforzotero-reader-chat-toggle") !== null;
    assert.isTrue(buttonExists(), "button should exist before the drag");

    // Watch toolbar rebuilds across the whole drag.
    const sectionsEl = d.querySelector(".toolbar .custom-sections");
    let sectionMutations = 0;
    const mo = new d.defaultView.MutationObserver((list) => {
      sectionMutations += list.length;
    });
    mo.observe(sectionsEl, { childList: true });

    // Also track our renderToolbar listener registration across the drag:
    // Zotero 9.0.6's unregisterEventListener has an inverted filter that
    // wipes OTHER plugins' listeners when anyone calls it.
    const listenerCount = (): number =>
      (Zotero.Reader as any)._registeredListeners.filter(
        (l: any) => l.type === "renderToolbar",
      ).length;

    // Simulate the drag: mousedown on the resizer, then a burst of upward
    // mousemoves (each crossing into the iframe area, like a fast real drag),
    // then mouseup.
    const rect = container.getBoundingClientRect();
    const startX = Math.round(rect.left + rect.width / 2);
    const startY = Math.round(rect.top) + 2;
    const fire = (target: any, type: string, x: number, y: number): void => {
      target.dispatchEvent(
        new mainView.MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 0,
        }),
      );
    };
    fire(resizer, "mousedown", startX, startY);
    // Real upward drags put the cursor over the reader browser, which the
    // resizer disables pointer events on for the duration of the drag so the
    // events keep landing in the main window. Assert that shield is up
    // mid-drag and released afterwards.
    const frame = reader._iframe as any;
    const steps = 20;
    let shieldUpAtLeastOnce = false;
    for (let i = 1; i <= steps; i++) {
      const y = startY - i * 15;
      fire(mainDoc, "mousemove", startX, y);
      if (frame.style.pointerEvents === "none") shieldUpAtLeastOnce = true;
      await Zotero.Promise.delay(16);
    }
    fire(mainDoc, "mouseup", startX, startY - steps * 15);
    await Zotero.Promise.delay(800);
    assert.isTrue(
      shieldUpAtLeastOnce,
      "reader browser should ignore pointer events during the drag",
    );
    assert.notEqual(
      frame.style.pointerEvents,
      "none",
      "reader browser pointer events should be restored after the drag",
    );

    const after = {
      buttonAfterDrag: buttonExists(),
      sectionMutations,
      listenerCountBefore: listenerCount(),
      panelHeight: Math.round(container.getBoundingClientRect().height),
      heightPref: Zotero.Prefs.get(`${PREF_PREFIX}.readerPanelHeight`, true),
    };
    mo.disconnect();
    const tempDir = await (Zotero as any).getTempDirectory();
    await (Zotero.File as any).putContentsAsync(
      PathUtils.join(tempDir, "llm-drag-probe.json"),
      JSON.stringify(
        {
          listenerCountBeforeDrag: listenerCount(),
          ...after,
        },
        null,
        1,
      ),
    );
    assert.isTrue(after.buttonAfterDrag, "button should survive the drag");
    assert.isAtMost(
      after.sectionMutations,
      1,
      "toolbar should not churn during the drag",
    );

    // Close the probe tab so later probes start clean.
    const tabID = reader.tabID ?? reader._tabID;
    try {
      (Zotero.getMainWindow().Zotero_Tabs as any).close(tabID);
    } catch {
      // Best-effort in a disposable profile.
    }
  });
});
