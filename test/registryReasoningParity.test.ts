import { assert } from "chai";
import { buildReasoningPayload } from "../src/utils/llmClient";
import { getRuntimeReasoningOptions as getRegistryReasoningOptions } from "../src/modelCapabilities";
import { LLM_FAMILIES } from "../src/utils/llmFamilies";
import { ALL_REASONING_PROVIDERS } from "../src/utils/provider";
import { buildGeminiNativePayload } from "../src/utils/llmPayloads";
import { resolveUtilityReasoningPlan } from "../src/utils/utilityLLM";
import type { ProviderProtocol } from "../src/utils/providerProtocol";

/**
 * The named reasoning ladders live in the capability registry (schema 2).
 * This matrix pins the compiled request payload for every migrated family,
 * level, and wire protocol — the equivalence proof for the migration that
 * moved these encodings out of the per-family adapters.
 */

const CHAT: ProviderProtocol = "openai_chat_compat";
const RESPONSES: ProviderProtocol = "responses_api";
const ANTHROPIC: ProviderProtocol = "anthropic_messages";

function payload(
  provider: "openai" | "grok" | "deepseek",
  level: string,
  model: string,
  protocol: ProviderProtocol,
  useResponses = false,
  apiBase?: string,
) {
  return buildReasoningPayload(
    { provider, level } as never,
    useResponses,
    model,
    apiBase,
    protocol,
  );
}

describe("registry reasoning parity", function () {
  describe("openai effort families", function () {
    const XHIGH_MODELS = ["gpt-5.4", "gpt-5.5", "gpt-5.2"];
    const LADDER: Array<[string, string | null]> = [
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["default", null],
    ];

    for (const model of XHIGH_MODELS) {
      for (const [level, effort] of LADDER) {
        it(`sends ${model} ${level} over chat as ${effort ?? "no field"}`, function () {
          assert.deepEqual(payload("openai", level, model, CHAT), {
            extra: effort ? { reasoning_effort: effort } : {},
            omitTemperature: true,
          });
        });
        it(`sends ${model} ${level} over responses as ${effort ?? "summary only"}`, function () {
          assert.deepEqual(payload("openai", level, model, RESPONSES, true), {
            extra: {
              reasoning: {
                ...(effort ? { effort } : {}),
                summary: "detailed",
              },
            },
            omitTemperature: true,
          });
        });
      }
    }

    it("limits gpt-5-pro to high and omits temperature", function () {
      assert.deepEqual(payload("openai", "high", "gpt-5-pro", CHAT), {
        extra: { reasoning_effort: "high" },
        omitTemperature: true,
      });
    });

    it("derives the responses shape when the protocol is absent but useResponses is set", function () {
      // Legacy call sites pass only the flag; the dispatcher must derive
      // responses_api so the registry's protocol key applies.
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "openai", level: "high" },
          true,
          "gpt-5.4",
        ),
        {
          extra: { reasoning: { effort: "high", summary: "detailed" } },
          omitTemperature: true,
        },
      );
    });
  });

  describe("grok-3-mini", function () {
    it("sends the chat shape without omitting temperature", function () {
      assert.deepEqual(payload("grok", "low", "grok-3-mini", CHAT), {
        extra: { reasoning_effort: "low" },
        omitTemperature: false,
      });
    });
    it("sends the responses shape on the responses protocol", function () {
      assert.deepEqual(
        payload("grok", "high", "grok-3-mini", RESPONSES, true),
        {
          extra: { reasoning: { effort: "high", summary: "detailed" } },
          omitTemperature: false,
        },
      );
    });
    it("sends summary-only reasoning for the default level over responses", function () {
      assert.deepEqual(
        payload("grok", "default", "grok-3-mini", RESPONSES, true),
        {
          extra: { reasoning: { summary: "detailed" } },
          omitTemperature: false,
        },
      );
    });
  });

  describe("gemini thinking families", function () {
    function geminiPayload(level: string, model: string) {
      return buildReasoningPayload(
        { provider: "gemini", level } as never,
        false,
        model,
        undefined,
        CHAT,
      );
    }

    it("sends snake_case thinking_config over the chat protocol", function () {
      assert.deepEqual(geminiPayload("minimal", "gemini-3.6-flash"), {
        extra: {
          extra_body: {
            google: {
              thinking_config: {
                include_thoughts: true,
                thinking_level: "minimal",
              },
            },
          },
        },
        omitTemperature: false,
      });
    });

    it("keeps the 2.5 budget sentinels exact", function () {
      assert.deepEqual(
        geminiPayload("default", "gemini-2.5-pro").extra.extra_body!.google!
          .thinking_config,
        { include_thoughts: true, thinking_budget: -1 },
      );
      assert.deepEqual(
        geminiPayload("low", "gemini-2.5-pro").extra.extra_body!.google!
          .thinking_config,
        { include_thoughts: true, thinking_budget: 128 },
      );
      assert.deepEqual(
        geminiPayload("minimal", "gemini-2.5-flash").extra.extra_body!.google!
          .thinking_config,
        { include_thoughts: true, thinking_budget: 0 },
      );
      assert.deepEqual(
        geminiPayload("low", "gemini-2.5-flash").extra.extra_body!.google!
          .thinking_config,
        { include_thoughts: true, thinking_budget: 1 },
      );
      assert.deepEqual(
        geminiPayload("default", "gemini-2.5-flash-lite").extra.extra_body!
          .google!.thinking_config,
        { include_thoughts: true, thinking_budget: 0 },
      );
    });

    it("sends a budget for 2.5 and a level word for 3.x", function () {
      assert.property(
        geminiPayload("high", "gemini-2.5-flash").extra.extra_body!.google!
          .thinking_config,
        "thinking_budget",
      );
      assert.property(
        geminiPayload("high", "gemini-3-flash").extra.extra_body!.google!
          .thinking_config,
        "thinking_level",
      );
    });
  });

  describe("deepseek protocol fork", function () {
    it("sends reasoning_effort over the openai protocol", function () {
      assert.deepEqual(payload("deepseek", "xhigh", "deepseek-v4-pro", CHAT), {
        extra: {
          thinking: { type: "enabled" },
          reasoning_effort: "max",
        },
        omitTemperature: true,
      });
    });
    it("sends output_config.effort over the anthropic protocol", function () {
      assert.deepEqual(
        payload("deepseek", "xhigh", "deepseek-v4-pro", ANTHROPIC),
        {
          extra: {
            thinking: { type: "enabled" },
            output_config: { effort: "max" },
          },
          omitTemperature: true,
        },
      );
    });
    it("disables thinking without omitting temperature on minimal", function () {
      for (const protocol of [CHAT, ANTHROPIC]) {
        assert.deepEqual(
          payload("deepseek", "minimal", "deepseek-v4-pro", protocol),
          { extra: { thinking: { type: "disabled" } }, omitTemperature: false },
          protocol,
        );
      }
    });
    it("keeps the reasoner's always-on thinking for any level", function () {
      assert.deepEqual(payload("deepseek", "high", "deepseek-reasoner", CHAT), {
        extra: { thinking: { type: "enabled" } },
        omitTemperature: false,
      });
    });
  });

  describe("mimo and kimi toggles", function () {
    it("opts into mimo thinking only on high", function () {
      assert.deepEqual(
        payload("mimo" as never, "high", "mimo-v2.5-pro", CHAT),
        {
          extra: { thinking: { type: "enabled" } },
          omitTemperature: false,
        },
      );
      assert.deepEqual(
        payload("mimo" as never, "default", "mimo-v2.5-pro", CHAT),
        { extra: {}, omitTemperature: false },
      );
    });
    it("toggles kimi-k2.5 thinking with thinking.type", function () {
      assert.deepEqual(payload("kimi" as never, "default", "kimi-k2.5", CHAT), {
        extra: { thinking: { type: "enabled" } },
        omitTemperature: false,
      });
      assert.deepEqual(payload("kimi" as never, "minimal", "kimi-k2.5", CHAT), {
        extra: { thinking: { type: "disabled" } },
        omitTemperature: false,
      });
    });
  });

  /**
   * Snapshots of the registry-miss paths — the optimistic family fallbacks
   * that today live in the code-side profile table and are migrating into
   * the registry's familyFallbacks section. Every payload below must stay
   * byte-identical across that migration (values recorded from the running
   * dispatch, not hand-derived).
   */
  describe("registry-miss family fallbacks (migration snapshot)", function () {
    it("openai: optimistic effort ladder for an unregistered model", function () {
      assert.deepEqual(payload("openai", "default", "gpt-5.9-turbo", CHAT), {
        extra: {},
        omitTemperature: true,
      });
      assert.deepEqual(payload("openai", "low", "gpt-5.9-turbo", CHAT), {
        extra: { reasoning_effort: "low" },
        omitTemperature: true,
      });
      assert.deepEqual(
        payload("openai", "low", "gpt-5.9-turbo", RESPONSES, true),
        {
          extra: { reasoning: { summary: "detailed", effort: "low" } },
          omitTemperature: true,
        },
      );
      assert.deepEqual(
        payload("openai", "default", "gpt-5.9-turbo", RESPONSES, true),
        {
          extra: { reasoning: { summary: "detailed" } },
          omitTemperature: true,
        },
      );
    });

    it("grok: single enabled level, temperature kept", function () {
      assert.deepEqual(payload("grok", "default", "grok-9", CHAT), {
        extra: {},
        omitTemperature: false,
      });
      assert.deepEqual(payload("grok", "default", "grok-9", RESPONSES, true), {
        extra: { reasoning: { summary: "detailed" } },
        omitTemperature: false,
      });
    });

    it("gemini: generic thinking_level ladder over the chat protocol", function () {
      assert.deepEqual(
        payload("gemini" as never, "low", "gemini-4-flash", CHAT),
        {
          extra: {
            extra_body: {
              google: {
                thinking_config: {
                  include_thoughts: true,
                  thinking_level: "low",
                },
              },
            },
          },
          omitTemperature: false,
        },
      );
      assert.deepEqual(
        payload("gemini" as never, "medium", "gemini-4-flash", CHAT),
        {
          extra: {
            extra_body: {
              google: {
                thinking_config: {
                  include_thoughts: true,
                  thinking_level: "medium",
                },
              },
            },
          },
          omitTemperature: false,
        },
      );
    });

    it("gemini: the native path's profile-derived thinkingConfig", function () {
      const native = buildGeminiNativePayload({
        model: "gemini-4-flash",
        messages: [{ role: "user", content: "hi" }],
        effectiveMaxTokens: undefined,
        temperature: undefined,
        reasoning: { provider: "gemini", level: "low" },
      });
      assert.deepEqual(
        (native.generationConfig as Record<string, unknown>).thinkingConfig,
        { includeThoughts: true, thinkingLevel: "low" },
      );
    });

    it("qwen: host fork and the null tri-state for an unregistered model", function () {
      const dashscope = "https://dashscope.aliyuncs.com/compatible-mode/v1";
      const other = "https://api.other.com/v1";
      // default carries no payload on either host (the null tri-state)
      assert.deepEqual(
        payload("qwen" as never, "default", "qwen-99-max", CHAT, false, other),
        { extra: {}, omitTemperature: false },
      );
      assert.deepEqual(
        payload(
          "qwen" as never,
          "default",
          "qwen-99-max",
          CHAT,
          false,
          dashscope,
        ),
        { extra: {}, omitTemperature: false },
      );
      // non-DashScope hosts get chat_template_kwargs
      assert.deepEqual(
        payload("qwen" as never, "high", "qwen-99-max", CHAT, false, other),
        {
          extra: { chat_template_kwargs: { enable_thinking: true } },
          omitTemperature: false,
        },
      );
      // DashScope gets the top-level flag
      assert.deepEqual(
        payload("qwen" as never, "high", "qwen-99-max", CHAT, false, dashscope),
        { extra: { enable_thinking: true }, omitTemperature: false },
      );
      assert.deepEqual(
        payload("qwen" as never, "low", "qwen-99-max", CHAT, false, dashscope),
        { extra: { enable_thinking: false }, omitTemperature: false },
      );
    });

    it("anthropic: unknown claude encodes nothing; known ones keep their modes", function () {
      assert.deepEqual(
        payload("anthropic" as never, "high", "claude-opus-9", ANTHROPIC),
        { extra: {}, omitTemperature: false },
      );
      assert.deepEqual(
        payload("anthropic" as never, "high", "claude-opus-4-7", ANTHROPIC),
        {
          extra: {
            thinking: { type: "adaptive" },
            output_config: { effort: "high" },
          },
          omitTemperature: true,
        },
      );
      assert.deepEqual(
        payload("anthropic" as never, "xhigh", "claude-opus-4-7", ANTHROPIC),
        {
          extra: {
            thinking: { type: "adaptive" },
            output_config: { effort: "xhigh" },
          },
          omitTemperature: true,
        },
      );
      assert.deepEqual(
        payload("anthropic" as never, "high", "claude-haiku-4-5", ANTHROPIC),
        {
          extra: { thinking: { type: "enabled", budget_tokens: 10000 } },
          omitTemperature: true,
        },
      );
    });

    it("qwen variant entries serve the menu the module ladder used to", function () {
      const options = (model: string) =>
        getRegistryReasoningOptions({ provider: "qwen", model });
      assert.deepEqual(
        options("qwen3-32b-instruct-2507").map((option) => option.level),
        [],
      );
      assert.deepEqual(
        options("qwen3-8b-thinking-2507").map((option) => option.level),
        ["default"],
      );
      assert.deepEqual(
        options("qwq-32b").map((option) => option.level),
        ["default"],
      );
      assert.deepEqual(
        options("qwen-99-max").map((option) => option.level),
        ["default", "high", "low"],
      );
    });

    it("qwen thinking-only variants still encode enable_thinking on both hosts", function () {
      const dashscope = "https://dashscope.aliyuncs.com/compatible-mode/v1";
      const other = "https://api.other.com/v1";
      assert.deepEqual(
        payload("qwen" as never, "default", "qwq-32b", CHAT, false, dashscope),
        { extra: { enable_thinking: true }, omitTemperature: false },
      );
      assert.deepEqual(
        payload("qwen" as never, "default", "qwq-32b", CHAT, false, other),
        {
          extra: { chat_template_kwargs: { enable_thinking: true } },
          omitTemperature: false,
        },
      );
    });

    it("entries hit without a reasoning key encode nothing (familyFallbacks guard)", function () {
      // gpt-4o / grok-4 match registry entries that carry no `reasoning`;
      // once the openai/grok family fallbacks exist, only an explicit
      // kind:"none" on these entries keeps this payload empty.
      assert.deepEqual(payload("openai", "high", "gpt-4o", CHAT), {
        extra: {},
        omitTemperature: false,
      });
      assert.deepEqual(payload("grok", "low", "grok-4", CHAT), {
        extra: {},
        omitTemperature: false,
      });
    });

    it("utility planner reserve falls back to the level table for an unregistered gemini", function () {
      assert.deepEqual(
        resolveUtilityReasoningPlan({
          provider: "gemini",
          model: "gemini-4-flash",
          level: "high",
        } as never),
        {
          reasoning: { provider: "gemini", level: "low" },
          reserveTokens: 1024,
        },
      );
    });
  });
});

describe("llm families", function () {
  it("covers every reasoning provider id", function () {
    assert.deepEqual(
      Object.keys(LLM_FAMILIES).sort(),
      [...ALL_REASONING_PROVIDERS].sort(),
    );
  });

  it("encodes identically to the payload builder", function () {
    const cases: Array<[string, string, string, string | undefined, string]> = [
      ["openai", "high", "gpt-5.2", undefined, "openai_chat_compat"],
      ["openai", "low", "gpt-5.9-turbo", undefined, "openai_chat_compat"],
      ["gemini", "medium", "gemini-4-flash", undefined, "openai_chat_compat"],
      [
        "qwen",
        "high",
        "qwen-99-max",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "openai_chat_compat",
      ],
      [
        "anthropic",
        "high",
        "claude-haiku-4-5",
        undefined,
        "anthropic_messages",
      ],
    ];
    for (const [provider, level, model, apiBase, protocol] of cases) {
      assert.deepEqual(
        LLM_FAMILIES[provider as keyof typeof LLM_FAMILIES].encodeReasoning({
          model,
          apiBase,
          protocol: protocol as never,
          reasoning: { provider, level } as never,
          useResponses: false,
        }),
        buildReasoningPayload(
          { provider, level } as never,
          false,
          model,
          apiBase,
          protocol as never,
        ),
        `${provider} ${model} ${level}`,
      );
    }
  });

  it("serves limits and options through the family surface", function () {
    const gemini = LLM_FAMILIES.gemini;
    assert.equal(
      gemini.limitsFor({ model: "gemini-2.5-pro" })?.contextWindowTokens,
      1_048_576,
    );
    assert.deepEqual(
      gemini
        .reasoningOptionsFor({ model: "gemini-4-flash" })
        .map((option) => option.level),
      ["medium", "low", "high"],
    );
    assert.isNull(
      LLM_FAMILIES.gpt?.defaultReasoningLevelFor?.({ model: "gpt-4o" }) ?? null,
    );
  });
});
