import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

function diagnosticsMessage(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

describe("workflow: library chat panel", function () {
  this.timeout(45000);

  let api: WorkflowTestApi;
  const fixtures: WorkflowTestFixture[] = [];

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    while (fixtures.length) {
      const fixture = fixtures.pop();
      if (fixture) await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  it("mounts a global conversation without requiring an item selection", async function () {
    const panel = await api.mountLibraryPanelForTest();
    const diagnostics = await api.getDiagnostics(panel.panelId);
    assert.equal(
      diagnostics.conversationKind,
      "global",
      diagnosticsMessage(diagnostics),
    );
    assert.isOk(diagnostics.conversationKey, diagnosticsMessage(diagnostics));
  });

  it("keeps the anchored conversation when the item selection changes", async function () {
    const paperA = await api.createPaperWithPdfFixture({
      title: "Workflow Library Anchor Paper A",
      pdfTitle: "Workflow Library Anchor PDF A",
    });
    const paperB = await api.createPaperWithPdfFixture({
      title: "Workflow Library Anchor Paper B",
      pdfTitle: "Workflow Library Anchor PDF B",
    });
    fixtures.push(paperA, paperB);

    const panel = await api.mountLibraryPanelForTest(paperA.parentItemId);
    const seeded = await api.seedPanelStoredUserMessage(
      panel.panelId,
      "workflow library anchor marker",
    );
    assert.equal(seeded.conversationKind, "global", diagnosticsMessage(seeded));

    const afterSelectionChange = await api.simulateLibraryPanelSelectionChange(
      panel.panelId,
      paperB.parentItemId,
    );
    assert.equal(
      afterSelectionChange.conversationKind,
      "global",
      diagnosticsMessage(afterSelectionChange),
    );
    assert.equal(
      afterSelectionChange.conversationKey,
      seeded.conversationKey,
      diagnosticsMessage(afterSelectionChange),
    );
    assert.include(
      afterSelectionChange.messageText || "",
      "workflow library anchor marker",
      diagnosticsMessage(afterSelectionChange),
    );
  });

  it("creates a global conversation from the new-chat action", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Library New Chat Paper",
      pdfTitle: "Workflow Library New Chat PDF",
    });
    fixtures.push(fixture);

    const panel = await api.mountLibraryPanelForTest(fixture.parentItemId);
    const seeded = await api.seedPanelStoredUserMessage(
      panel.panelId,
      "workflow library new chat before marker",
    );
    const newConversation = await api.startNewPanelConversation(panel.panelId, {
      allowReusedDraft: true,
    });
    assert.equal(
      newConversation.conversationKind,
      "global",
      diagnosticsMessage(newConversation),
    );
    assert.notEqual(
      newConversation.conversationKey,
      seeded.conversationKey,
      diagnosticsMessage(newConversation),
    );
  });
});
