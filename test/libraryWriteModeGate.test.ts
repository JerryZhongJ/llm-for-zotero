import { assert } from "chai";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * The mode is enforced at `prepareExecution` — the one point the in-plugin
 * runtime, MCP and the external bridge all pass through — rather than in the
 * tool listing. A gate that only hides a tool is decoration: `exposure` is
 * checked when listing and deliberately not when executing, because
 * seventeen internal tools are called by name through this same method.
 */
describe("library write mode gate", function () {
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  async function installMode(mode: string) {
    const db = new ChangeJournalTestDb();
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DB: db,
      Prefs: { get: () => mode },
      debug: () => undefined,
    };
    await initAgentChangeJournal();
  }

  const context: AgentToolContext = {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "go",
      libraryID: 1,
      // These tests target the write-mode gate, not classification; a
      // classified turn keeps the intent-unresolved refusal out of the way.
      classifiedIntent: {
        retrievalIntent: "none",
        wantedSections: [],
        actionInterpretationSource: "classifier",
        actionIntents: [],
      },
    },
    item: null,
    currentAnswerText: "",
    modelName: "test",
  };

  function makeRegistry() {
    const registry = new AgentToolRegistry();
    let ran = false;
    registry.register({
      spec: {
        name: "library_batch",
        description: "batch",
        inputSchema: { type: "object" },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args as never }),
      planMutation: async () => ({
        effect: "write",
        reversibility: "full",
      }),
      createPendingAction: () => ({
        toolName: "library_batch",
        title: "Review batch",
        description: "Review this library batch",
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: [],
      }),
      async execute() {
        ran = true;
        return { content: { ok: true }, effect: "applied" };
      },
    } as never);
    return { registry, didRun: () => ran };
  }

  const call = { id: "c1", name: "library_batch", arguments: {} };

  it("refuses an auto-only tool in manual mode, at execution", async function () {
    await installMode("manual");
    const { registry, didRun } = makeRegistry();
    const prepared = await registry.prepareExecution(call, context);
    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") return;
    assert.isFalse(prepared.execution.result.ok);
    assert.isFalse(didRun(), "the tool must not have run");
    assert.include(
      String((prepared.execution.result.content as { error?: string })?.error),
      "auto",
    );
  });

  it("allows it in auto", async function () {
    await installMode("auto");
    const { registry, didRun } = makeRegistry();
    const prepared = await registry.prepareExecution(call, context);
    assert.equal(prepared.kind, "result");
    assert.isTrue(didRun());
  });

  it("bypasses the auto-only gate for a slash command but still reviews the plan", async function () {
    await installMode("manual");
    const { registry, didRun } = makeRegistry();
    const prepared = await registry.prepareExecution(call, context, {
      callerKind: "action",
    });
    assert.equal(prepared.kind, "confirmation");
    assert.isFalse(didRun());
    if (prepared.kind !== "confirmation") return;
    const execution = await prepared.execute();
    assert.isTrue(execution.result.ok);
    assert.isTrue(didRun());
  });

  it("defaults an undeclared caller to the stricter treatment", async function () {
    await installMode("manual");
    const { registry, didRun } = makeRegistry();
    await registry.prepareExecution(call, context, {});
    assert.isFalse(didRun());
  });

  it("reviews ordinary writes in manual mode from the same mutation plan", async function () {
    await installMode("manual");
    const registry = new AgentToolRegistry();
    let ran = false;
    registry.register({
      spec: {
        name: "library_update",
        description: "update",
        inputSchema: { type: "object" },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args as never }),
      planMutation: async () => ({
        effect: "write",
        reversibility: "full",
      }),
      createPendingAction: () => ({
        toolName: "library_update",
        title: "Review update",
        description: "Review this library update",
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: [],
      }),
      async execute() {
        ran = true;
        return { content: { ok: true }, effect: "applied" };
      },
    } as never);
    const prepared = await registry.prepareExecution(
      { id: "c2", name: "library_update", arguments: {} },
      context,
    );
    assert.equal(prepared.kind, "confirmation");
    assert.isFalse(ran);
  });

  describe("mode confirmation matrix", function () {
    function makeWriteTool(
      name: string,
      reversibility: "full" | "none" = "full",
    ) {
      const tool = {
        ran: false,
        registration: {
          spec: {
            name,
            description: "write",
            inputSchema: { type: "object" },
            mutability: "write",
            requiresConfirmation: false,
          },
          validate: (args: unknown) => ({ ok: true, value: args as never }),
          planMutation: async () => ({
            effect: "write",
            reversibility,
          }),
          createPendingAction: () => ({
            toolName: name,
            title: "Review write",
            description: "Review this write",
            confirmLabel: "Apply",
            cancelLabel: "Cancel",
            fields: [],
          }),
          async execute() {
            tool.ran = true;
            return { content: { ok: true }, effect: "applied" };
          },
        } as never,
      };
      return tool;
    }

    function makeRegistryWithContractVerifier() {
      return new AgentToolRegistry();
    }

    it("semi_auto runs a reversible write without asking", async function () {
      await installMode("semi_auto");
      const tool = makeWriteTool("library_update");
      const registry = makeRegistryWithContractVerifier();
      registry.register(tool.registration);
      const prepared = await registry.prepareExecution(
        { id: "c3", name: "library_update", arguments: {} },
        context,
      );
      assert.equal(prepared.kind, "result");
      assert.isTrue(tool.ran);
    });

    it("semi_auto confirms an irreversible write", async function () {
      await installMode("semi_auto");
      const tool = makeWriteTool("library_delete", "none");
      const registry = makeRegistryWithContractVerifier();
      registry.register(tool.registration);
      const prepared = await registry.prepareExecution(
        { id: "c4", name: "library_delete", arguments: {} },
        context,
      );
      assert.equal(prepared.kind, "confirmation");
      assert.isFalse(tool.ran);
    });

    it("auto runs a reversible write unattended", async function () {
      await installMode("auto");
      const tool = makeWriteTool("library_update");
      const registry = makeRegistryWithContractVerifier();
      registry.register(tool.registration);
      const prepared = await registry.prepareExecution(
        { id: "c5", name: "library_update", arguments: {} },
        context,
      );
      assert.equal(prepared.kind, "result");
      assert.isTrue(tool.ran);
    });

    it("auto refuses an irreversible write when the gate model is unavailable", async function () {
      // The test context has no apiBase, so the gate cannot run and must
      // fail closed.
      await installMode("auto");
      const tool = makeWriteTool("library_delete", "none");
      const registry = makeRegistryWithContractVerifier();
      registry.register(tool.registration);
      const prepared = await registry.prepareExecution(
        { id: "c6", name: "library_delete", arguments: {} },
        context,
      );
      assert.equal(prepared.kind, "result");
      if (prepared.kind === "result") {
        assert.isFalse(prepared.execution.result.ok);
        assert.include(
          String(
            (prepared.execution.result.content as { error?: string })?.error,
          ),
          "auto-mode gate",
        );
      }
      assert.isFalse(
        tool.ran,
        "an irreversible write must not run without the gate",
      );
    });

    it("auto has no tool-level escape hatch: an irreversible write goes to the gate even when the tool spec asks for confirmation", async function () {
      // L4 is gone: `requiresConfirmation` on the spec cannot override the
      // mode. Auto + irreversible still routes through the write gate,
      // which is unavailable here (no apiBase) and must fail closed.
      await installMode("auto");
      const tool = makeWriteTool("library_delete", "none");
      tool.registration.spec = {
        ...tool.registration.spec,
        requiresConfirmation: true,
      };
      const registry = makeRegistryWithContractVerifier();
      registry.register(tool.registration);
      const prepared = await registry.prepareExecution(
        { id: "c7", name: "library_delete", arguments: {} },
        context,
      );
      assert.equal(prepared.kind, "result");
      if (prepared.kind === "result") {
        assert.isFalse(prepared.execution.result.ok);
        assert.include(
          String(
            (prepared.execution.result.content as { error?: string })?.error,
          ),
          "auto-mode gate",
        );
      }
      assert.isFalse(tool.ran);
    });
  });
});
