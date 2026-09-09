import { assert } from "chai";
import { normalizeAgentLibraryWriteMode } from "../src/shared/agentLibraryWriteMode";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import {
  AgentToolRegistry,
  writePlanRequiresConfirmation,
} from "../src/agent/tools/registry";
import { createLibrarySettingsTool } from "../src/agent/tools/write/librarySettings";
import { createImportIdentifiersTool } from "../src/agent/tools/write/importIdentifiers";
import type {
  AgentMutationPlan,
  AgentToolContext,
  AgentToolDefinition,
} from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

describe("mutation-plan confirmation policy", function () {
  const originalZotero = globalThis.Zotero;
  const context = {
    request: {
      conversationKey: 1,
      libraryID: 1,
      // These tests target the confirmation policy, not classification.
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
  } as AgentToolContext;

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  function tool(
    plan?: AgentMutationPlan,
  ): AgentToolDefinition<Record<string, never>, unknown> {
    return {
      spec: {
        name: "future_write",
        description: "test write",
        inputSchema: { type: "object" },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      ...(plan ? { planMutation: async () => plan } : {}),
      createPendingAction: () => ({
        toolName: "future_write",
        title: "Review write",
        description: "Review this mutation",
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: [],
      }),
      execute: async () => ({
        content: { status: "ran" },
        effect: "applied",
      }),
    };
  }

  async function prepare(params: {
    mode: "manual" | "semi_auto" | "auto";
    plan?: AgentMutationPlan;
    journal: boolean;
  }) {
    const db = params.journal ? new ChangeJournalTestDb() : undefined;
    globalThis.Zotero = {
      ...(db ? { DB: db } : {}),
      Prefs: { get: () => params.mode },
      debug: () => undefined,
    } as never;
    if (db) await initAgentChangeJournal();
    const registry = new AgentToolRegistry();
    registry.register(tool(params.plan));
    return registry.prepareExecution(
      { id: "call-1", name: "future_write", arguments: {} },
      context,
    );
  }

  it("manual reviews every concrete write plan", async function () {
    const prepared = await prepare({
      mode: "manual",
      journal: true,
      plan: { effect: "write", reversibility: "full" },
    });
    assert.equal(prepared.kind, "confirmation");
  });

  it("semi_auto runs a fully reversible initialized-journal plan directly", async function () {
    const prepared = await prepare({
      mode: "semi_auto",
      journal: true,
      plan: { effect: "write", reversibility: "full" },
    });
    assert.equal(prepared.kind, "result");
    if (prepared.kind === "result") {
      assert.isTrue(prepared.execution.result.ok);
    }
  });

  it("semi_auto reviews partial and irreversible plans", async function () {
    for (const reversibility of ["partial", "none"] as const) {
      const prepared = await prepare({
        mode: "semi_auto",
        journal: true,
        plan: { effect: "write", reversibility },
      });
      assert.equal(prepared.kind, "confirmation", reversibility);
    }
  });

  it("semi_auto imports a paper without a card — the undo is deferred, not absent", async function () {
    // Import creates items, so its inverse (deleting them) can only be frozen
    // after Zotero assigns the IDs. That makes it reversible-in-principle:
    // semi_auto must run it directly and rely on the trace's undo button,
    // not demand a confirmation card for every paper. Assert on the plan and
    // the shared gate formula — executing would need a working gateway.
    const tool = createImportIdentifiersTool({
      getItem: () => null,
      getCollection: () => null,
    } as never);
    const validated = tool.validate({ identifier: "10.1/abc" });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const plan = await tool.planMutation?.(validated.value, context);
    assert.isOk(plan);
    if (!plan) return;
    assert.equal(plan.reversibility, "full");
    assert.isFalse(writePlanRequiresConfirmation(plan, "semi_auto", false));
    assert.isTrue(writePlanRequiresConfirmation(plan, "manual", false));
  });

  it("defaults a future write without a planner to irreversible", async function () {
    const prepared = await prepare({ mode: "semi_auto", journal: true });
    assert.equal(prepared.kind, "confirmation");
  });

  it("applies the global write mode to library settings", async function () {
    for (const [mode, expectedKind] of [
      ["manual", "confirmation"],
      ["semi_auto", "result"],
      ["auto", "result"],
    ] as const) {
      const db = new ChangeJournalTestDb();
      globalThis.Zotero = {
        DB: db,
        Prefs: { get: () => mode },
        Items: { get: () => null },
        debug: () => undefined,
      } as never;
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry();
      registry.register(
        createLibrarySettingsTool({
          listSettings: () => [
            {
              key: "automaticTags",
              value: true,
              description: "Automatically save tags",
            },
          ],
          updateSetting: async () => ({
            status: "updated",
            key: "automaticTags",
            previousValue: true,
            value: false,
          }),
        } as never),
      );

      const prepared = await registry.prepareExecution(
        {
          id: `settings-${mode}`,
          name: "library_settings",
          arguments: {
            action: "set",
            key: "automaticTags",
            value: false,
          },
        },
        context,
      );

      assert.equal(prepared.kind, expectedKind, mode);
      if (prepared.kind === "result") {
        assert.isTrue(prepared.execution.result.ok, mode);
      }
    }
  });

  it("does not confirm a library setting that already has the requested value", async function () {
    const db = new ChangeJournalTestDb();
    globalThis.Zotero = {
      DB: db,
      Prefs: { get: () => "manual" },
      Items: { get: () => null },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry();
    registry.register(
      createLibrarySettingsTool({
        listSettings: () => [
          {
            key: "automaticTags",
            value: false,
            description: "Automatically save tags",
          },
        ],
        updateSetting: async () => ({
          status: "unchanged",
          key: "automaticTags",
          value: false,
        }),
      } as never),
    );

    const prepared = await registry.prepareExecution(
      {
        id: "settings-no-op",
        name: "library_settings",
        arguments: {
          action: "set",
          key: "automaticTags",
          value: false,
        },
      },
      context,
    );

    assert.equal(prepared.kind, "result");
    const read = await registry.prepareExecution(
      {
        id: "settings-read",
        name: "library_settings",
        arguments: { action: "list" },
      },
      context,
    );
    assert.equal(read.kind, "result");
  });

  it("refuses auto-mode writes when the durable journal is unavailable", async function () {
    const prepared = await prepare({
      mode: "auto",
      journal: false,
      plan: { effect: "write", reversibility: "full" },
    });
    assert.equal(prepared.kind, "result");
    if (prepared.kind === "result") {
      assert.isFalse(prepared.execution.result.ok);
      assert.include(
        JSON.stringify(prepared.execution.result.content),
        "durable change journal is unavailable",
      );
    }
  });

  it("semi_auto falls back to explicit confirmation with a recovery warning", async function () {
    const prepared = await prepare({
      mode: "semi_auto",
      journal: false,
      plan: { effect: "write", reversibility: "full" },
    });
    assert.equal(prepared.kind, "confirmation");
    if (prepared.kind === "confirmation") {
      assert.include(prepared.action.description, "Recovery warning");
      const execution = await prepared.execute();
      assert.isTrue(execution.result.ok);
    }
  });

  describe("stored preference normalization", function () {
    it("defaults to auto", function () {
      assert.equal(normalizeAgentLibraryWriteMode(undefined), "semi_auto");
      assert.equal(normalizeAgentLibraryWriteMode("nonsense"), "semi_auto");
    });

    it("migrates legacy safe/yolo values; legacy auto is migrated at read time", function () {
      assert.equal(normalizeAgentLibraryWriteMode("safe"), "manual");
      assert.equal(normalizeAgentLibraryWriteMode("yolo"), "auto");
      // "auto" is now a valid mode of its own; the read-level migration in
      // getAgentLibraryWriteMode disambiguates the legacy value.
      assert.equal(normalizeAgentLibraryWriteMode("auto"), "auto");
    });
  });
});
