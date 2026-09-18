import { assert } from "chai";
import {
  getModelCapabilities,
  getRuntimeReasoningOptions,
} from "../src/modelCapabilities";
import { callLLMStream } from "../src/utils/llmClient";
import { GeminiNativeAgentAdapter } from "../src/agent/model/geminiNative";
import type { AgentRuntimeRequest, ToolSpec } from "../src/agent/types";

describe("gemini 3.x reasoning profiles", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;

  beforeEach(function () {
    const prefStore = new Map<string, unknown>();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  // The named gemini ladders live in the capability registry now; the
  // helper resolves the registry entry and reports its option set, default,
  // and which thinking parameter the native protocol declares.
  function registryLadder(model: string) {
    const capabilities = getModelCapabilities({
      provider: "gemini",
      model,
      protocol: "gemini_native",
    });
    const options = getRuntimeReasoningOptions({
      provider: "gemini",
      model,
      protocol: "gemini_native",
    }).map((option) => option.level);
    return {
      defaultLevel: capabilities.reasoning.defaultOptionId,
      options,
      // The native patch's shape says budget-vs-level without trusting the
      // label spelling.
      takesBudget: capabilities.reasoning.options.some(
        (option) =>
          (
            option.controlsByProtocol?.gemini_native?.body?.thinkingConfig as
              | Record<string, unknown>
              | undefined
          )?.thinkingBudget !== undefined,
      ),
    };
  }

  it("gives gemini-3.6-flash a medium default with a minimal option", function () {
    const ladder = registryLadder("gemini-3.6-flash");
    assert.equal(ladder.defaultLevel, "medium");
    assert.isFalse(ladder.takesBudget);
    assert.include(ladder.options, "minimal");
  });

  it("gives gemini-3.x flash-lite models a minimal default", function () {
    for (const model of ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]) {
      const ladder = registryLadder(model);
      assert.isFalse(ladder.takesBudget, model);
      assert.equal(ladder.defaultLevel, "minimal", model);
    }
  });

  it("gives gemini-3.x flash models a high default with a minimal option", function () {
    for (const model of ["gemini-3-flash-preview", "gemini-3.5-flash"]) {
      const ladder = registryLadder(model);
      assert.equal(ladder.defaultLevel, "high", model);
      assert.include(ladder.options, "minimal", model);
    }
  });

  it("gives gemini-3.1-pro medium support without minimal", function () {
    const ladder = registryLadder("gemini-3.1-pro-preview");
    assert.equal(ladder.defaultLevel, "high");
    assert.include(ladder.options, "medium");
    assert.notInclude(ladder.options, "minimal");
  });

  it("keeps gemini-3-pro-preview on its low/high ladder", function () {
    const ladder = registryLadder("gemini-3-pro-preview");
    assert.equal(ladder.defaultLevel, "high");
    assert.deepEqual([...ladder.options].sort(), ["high", "low"]);
  });

  function mockFetchCapturingBody(): { bodies: Record<string, unknown>[] } {
    const captured: { bodies: Record<string, unknown>[] } = { bodies: [] };
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (url: string, init?: RequestInit) => {
          if (url.includes("GenerateContent")) {
            captured.bodies.push(
              JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
            );
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}\n\n',
                  ),
                );
                controller.close();
              },
            }),
            json: async () => ({
              candidates: [{ content: { parts: [{ text: "OK" }] } }],
            }),
            text: async () => "",
          };
        };
      },
      log: () => undefined,
    };
    return captured;
  }

  function thinkingConfigOf(
    body: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const generationConfig =
      (body?.generationConfig as Record<string, unknown>) || {};
    return (generationConfig.thinkingConfig as Record<string, unknown>) || {};
  }

  it("sends thinkingLevel minimal through the chat payload", async function () {
    const captured = mockFetchCapturingBody();
    await callLLMStream(
      {
        prompt: "Say hi.",
        model: "gemini-3.6-flash",
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-test",
        providerProtocol: "gemini_native",
        reasoning: { provider: "gemini", level: "minimal" },
      },
      () => undefined,
    );
    const thinkingConfig = thinkingConfigOf(captured.bodies[0]);
    assert.equal(thinkingConfig.thinkingLevel, "minimal");
    assert.equal(thinkingConfig.includeThoughts, true);
  });

  it("sends thinkingLevel minimal through the agent payload", async function () {
    const captured = mockFetchCapturingBody();
    const tools: ToolSpec[] = [
      {
        name: "query_library",
        description: "search",
        inputSchema: { type: "object" },
        mutability: "read",
        requiresConfirmation: false,
      },
    ];
    const request: AgentRuntimeRequest = {
      conversationKey: 1,
      mode: "agent",
      userText: "Inspect this",
      model: "gemini-3.6-flash",
      apiBase: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gemini-test",
      providerProtocol: "gemini_native",
      reasoning: { provider: "gemini", level: "minimal" },
    };
    const adapter = new GeminiNativeAgentAdapter();
    await adapter.runStep({
      request,
      messages: [{ role: "user", content: "Summarize it" }],
      tools,
    });
    const thinkingConfig = thinkingConfigOf(captured.bodies[0]);
    assert.equal(thinkingConfig.thinkingLevel, "minimal");
  });
});
