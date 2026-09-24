// Runs against Zotero's real reader binary, outside the regular workflow suite.
import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

const PREF_PREFIX = "extensions.zotero.llmforzotero";

describe("workflow: reader UI document verification", function () {
  this.timeout(60000);

  it("keeps the button and panel aligned through sidebar changes", async function () {
    const api = (Zotero as any).LLMForZotero?.api
      ?.workflowTest as WorkflowTestApi;
    assert.isOk(api, "workflow test API should be installed");
    Zotero.Prefs.set(`${PREF_PREFIX}.readerPanelEnabled`, true, true);
    Zotero.Prefs.set(`${PREF_PREFIX}.readerPanelHeight`, 260, true);

    const fixture = await api.createPaperWithPdfFixture({
      title: "Reader UI Probe Paper",
      pdfTitle: "Reader UI Probe PDF",
      pages: ["Page one", "Page two"],
    });
    const reader = await (Zotero.Reader as any).open(fixture.pdfAttachmentId, {
      pageIndex: 0,
    });
    assert.isOk(reader, "reader should open");
    await reader._initPromise;
    const uiDoc = reader._iframe.contentDocument;
    const container = reader._tabContainer.querySelector(".llm-reader-panel");
    assert.isOk(container, "panel should be docked");

    for (let attempt = 0; attempt < 10; attempt++) {
      if (uiDoc.getElementById("llmforzotero-reader-chat-toggle")) break;
      await Zotero.Promise.delay(500);
    }
    assert.isOk(
      uiDoc.getElementById("llmforzotero-reader-chat-toggle"),
      "chat button should exist in the reader UI document",
    );

    const panelLeft = (): number =>
      container.getBoundingClientRect().left -
      reader._tabContainer.getBoundingClientRect().left;
    const sidebarWidth = (): number =>
      uiDoc.getElementById("sidebarContainer")?.getBoundingClientRect().width ??
      0;
    const internal = reader._internalReader;
    for (let cycle = 0; cycle < 5; cycle++) {
      internal.toggleSidebar(true);
      await Zotero.Promise.delay(500);
      assert.isTrue(uiDoc.body.classList.contains("sidebar-open"));
      const width = sidebarWidth();
      assert.isAbove(width, 100, `cycle ${cycle}: sidebar should be visible`);
      assert.closeTo(
        panelLeft(),
        width,
        4,
        `cycle ${cycle}: panel should align with the open sidebar`,
      );

      internal.toggleSidebar(false);
      await Zotero.Promise.delay(500);
      assert.isFalse(uiDoc.body.classList.contains("sidebar-open"));
      assert.closeTo(
        panelLeft(),
        0,
        1,
        `cycle ${cycle}: panel inset should collapse on close`,
      );
    }

    internal.toggleSidebar(true);
    await Zotero.Promise.delay(500);
    internal.setSidebarWidth(300);
    await Zotero.Promise.delay(500);
    assert.closeTo(panelLeft(), 300, 4, "panel should follow sidebar resize");
    assert.isOk(
      uiDoc.getElementById("llmforzotero-reader-chat-toggle"),
      "chat button should remain after sidebar changes",
    );

    const tabID = reader.tabID ?? reader._tabID;
    (Zotero.getMainWindow().Zotero_Tabs as any).close(tabID);
  });
});
