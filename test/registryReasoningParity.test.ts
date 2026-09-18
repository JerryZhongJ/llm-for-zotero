import { assert } from "chai";
import { buildReasoningPayload } from "../src/utils/llmClient";
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
) {
  return buildReasoningPayload(
    { provider, level } as never,
    useResponses,
    model,
    undefined,
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
});
