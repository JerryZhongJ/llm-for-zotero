import { assert } from "chai";
import {
  getModelReasoningDefaultLevel,
  getRuntimeReasoningOptions as getRegistryReasoningOptions,
} from "../src/modelCapabilities";
import { buildReasoningPayload } from "../src/utils/llmClient";

describe("reasoningProfiles", function () {
  describe("OpenAI GPT-5 family profiles", function () {
    it("supports xhigh reasoning for gpt-5.4", function () {
      // The ladder lives in the registry; the level→effort contract is the
      // compiled wire payload, asserted per level.
      assert.deepEqual(
        getRegistryReasoningOptions({
          provider: "openai",
          model: "gpt-5.4",
        }).map((option) => option.level),
        ["default", "low", "medium", "high", "xhigh"],
      );
      assert.equal(
        getModelReasoningDefaultLevel({ provider: "openai", model: "gpt-5.4" }),
        "default",
      );
      for (const [level, effort] of [
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["xhigh", "xhigh"],
      ] as const) {
        assert.deepEqual(
          buildReasoningPayload(
            { provider: "openai", level },
            false,
            "gpt-5.4",
            undefined,
            "openai_chat_compat",
          ),
          { extra: { reasoning_effort: effort }, omitTemperature: true },
          level,
        );
      }
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "openai", level: "default" },
          false,
          "gpt-5.4",
          undefined,
          "openai_chat_compat",
        ),
        { extra: {}, omitTemperature: true },
        "the default level sends no effort field",
      );
    });

    it("supports xhigh reasoning for gpt-5.5", function () {
      assert.deepEqual(
        getRegistryReasoningOptions({
          provider: "openai",
          model: "gpt-5.5",
        }).map((option) => option.level),
        ["default", "low", "medium", "high", "xhigh"],
      );
      assert.equal(
        getModelReasoningDefaultLevel({ provider: "openai", model: "gpt-5.5" }),
        "default",
      );
    });

    it("limits gpt-5.4-pro to medium/high/xhigh reasoning", function () {
      const options = getRegistryReasoningOptions({
        provider: "openai",
        model: "gpt-5.4-pro",
      });
      assert.deepEqual(
        options.map((option) => option.level),
        ["medium", "high", "xhigh"],
      );
      assert.equal(
        getModelReasoningDefaultLevel({
          provider: "openai",
          model: "gpt-5.4-pro",
        }),
        "medium",
      );
    });

    it("limits gpt-5-pro to high reasoning only", function () {
      const options = getRegistryReasoningOptions({
        provider: "openai",
        model: "gpt-5-pro",
      });
      assert.deepEqual(
        options.map((option) => option.level),
        ["high"],
      );
      assert.equal(
        getModelReasoningDefaultLevel({
          provider: "openai",
          model: "gpt-5-pro",
        }),
        "high",
      );
    });

    it("supports codex-specific xhigh reasoning on gpt-5.2 and gpt-5.3 codex", function () {
      const gpt52Codex = getRegistryReasoningOptions({
        provider: "openai",
        model: "gpt-5.2-codex",
      });
      const gpt53Codex = getRegistryReasoningOptions({
        provider: "openai",
        model: "gpt-5.3-codex",
      });

      assert.deepEqual(
        gpt52Codex.map((option) => option.level),
        ["low", "medium", "high", "xhigh"],
      );
      assert.deepEqual(
        gpt53Codex.map((option) => option.level),
        ["low", "medium", "high", "xhigh"],
      );
    });
  });

  describe("OpenAI pre-reasoning families", function () {
    const NON_REASONING_MODELS = [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4o-2024-08-06",
      "gpt-4.1",
      "gpt-4-turbo",
      "gpt-4.5-preview",
      "chatgpt-4o-latest",
      "gpt-3.5-turbo",
      "gpt-35-turbo",
    ];

    it("offers no reasoning levels for the gpt-3 and gpt-4 families", function () {
      for (const model of NON_REASONING_MODELS) {
        assert.deepEqual(
          getRegistryReasoningOptions({ provider: "openai", model }),
          [],
          `${model} should offer no reasoning levels`,
        );
        assert.isNull(
          getModelReasoningDefaultLevel({ provider: "openai", model }),
          `${model} should have no default reasoning level`,
        );
      }
    });

    it("sends no reasoning payload for gpt-4o even when a level is selected", function () {
      // A level can still arrive from a cached selection made before the
      // model was switched. The payload builder must drop it rather than let
      // the request 400 on an unrecognized `reasoning_effort`.
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "openai", level: "low" },
          false,
          "gpt-4o",
          "https://api.openai.com/v1",
          "openai_chat_compat",
        ),
        { extra: {}, omitTemperature: false },
      );
    });

    it("keeps the optimistic level set for an unrecognized OpenAI model", function () {
      // Guard against anyone narrowing this into a fallback swap: a model
      // OpenAI has not shipped yet must still get a usable level set
      // without a code change — now via the registry's familyFallbacks.
      assert.deepEqual(
        getRegistryReasoningOptions({ provider: "openai", model: "gpt-6" }).map(
          (option) => option.level,
        ),
        ["default", "low", "medium", "high"],
      );
    });
  });

  describe("DeepSeek V4 profiles", function () {
    it("supports disabled, high, and max thinking modes", function () {
      // The V4 ladder lives in the registry; the mode semantics below are
      // pinned by the wire assertions in the next test.
      assert.deepEqual(
        getRegistryReasoningOptions({
          provider: "deepseek",
          model: "deepseek-v4-pro",
        }).map((option) => option.level),
        ["default", "minimal", "high", "xhigh"],
      );
      assert.equal(
        getModelReasoningDefaultLevel({
          provider: "deepseek",
          model: "deepseek-v4-pro",
        }),
        "default",
      );
    });

    it("builds documented DeepSeek V4 thinking payloads", function () {
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "deepseek", level: "minimal" },
          false,
          "deepseek-v4-pro",
        ),
        {
          extra: { thinking: { type: "disabled" } },
          omitTemperature: false,
        },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "deepseek", level: "high" },
          false,
          "deepseek-v4-pro",
        ),
        {
          extra: {
            thinking: { type: "enabled" },
            reasoning_effort: "high",
          },
          omitTemperature: true,
        },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "deepseek", level: "xhigh" },
          false,
          "deepseek-v4-pro",
        ),
        {
          extra: {
            thinking: { type: "enabled" },
            reasoning_effort: "max",
          },
          omitTemperature: true,
        },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "deepseek", level: "xhigh" },
          false,
          "deepseek-v4-pro",
          "https://api.deepseek.com/anthropic",
          "anthropic_messages",
        ),
        {
          extra: {
            thinking: { type: "enabled" },
            output_config: { effort: "max" },
          },
          omitTemperature: true,
        },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "deepseek", level: "default" },
          false,
          "deepseek-reasoner",
        ),
        {
          extra: { thinking: { type: "enabled" } },
          omitTemperature: false,
        },
      );
    });
  });

  describe("Xiaomi MiMo profiles", function () {
    it("exposes opt-in thinking for documented MiMo models", function () {
      for (const modelName of [
        "mimo-v2.5-pro",
        "mimo-v2.5",
        "mimo-v2-pro",
        "mimo-v2-omni",
        "mimo-v2-flash",
      ]) {
        const options = getRegistryReasoningOptions({
          provider: "mimo",
          model: modelName,
        });
        assert.deepEqual(
          options.map((option) => option.level),
          ["default", "high"],
          modelName,
        );
        assert.deepEqual(
          options.map((option) => option.label),
          ["default", "enabled"],
          modelName,
        );
      }

      // mimo-v2's default level sends no thinking body and "high" opts in;
      // both are pinned on the wire here, unknown mimo stays silent.
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "mimo", level: "default" },
          false,
          "mimo-v2.5-pro",
        ),
        { extra: {}, omitTemperature: false },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "mimo", level: "high" },
          false,
          "mimo-v2.5-pro",
        ),
        { extra: { thinking: { type: "enabled" } }, omitTemperature: false },
      );
      assert.deepEqual(
        getRegistryReasoningOptions({
          provider: "mimo",
          model: "mimo-unknown",
        }),
        [],
      );
    });

    it("builds conservative MiMo thinking payloads", function () {
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "mimo", level: "default" },
          false,
          "mimo-v2.5-pro",
          "https://api.xiaomimimo.com/v1",
          "openai_chat_compat",
        ),
        { extra: {}, omitTemperature: false },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "mimo", level: "high" },
          false,
          "mimo-v2.5-pro",
          "https://api.xiaomimimo.com/v1",
          "openai_chat_compat",
        ),
        {
          extra: { thinking: { type: "enabled" } },
          omitTemperature: false,
        },
      );
    });
  });

  describe("Anthropic profiles", function () {
    it("classifies current Opus, Sonnet, and Haiku thinking modes", function () {
      // The ladders live in the registry's claude entries; the mode
      // semantics (adaptive vs manual, budgets) are pinned on the wire
      // below and in the registry-miss snapshots.
      assert.deepEqual(
        getRegistryReasoningOptions({
          provider: "anthropic",
          model: "claude-opus-4-7",
        }).map((option) => option.label),
        ["low", "medium", "high", "xhigh"],
      );

      assert.deepEqual(
        getRegistryReasoningOptions({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        }).map((option) => option.label),
        ["low", "medium", "high", "max"],
      );

      assert.deepEqual(
        getRegistryReasoningOptions({
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
        }).map((option) => option.label),
        ["1024", "2000", "10000", "32000"],
      );
      assert.equal(
        getModelReasoningDefaultLevel({
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
        }),
        "low",
      );
    });

    it("does not expose reasoning options for unknown Claude models", function () {
      assert.deepEqual(
        getRegistryReasoningOptions({
          provider: "anthropic",
          model: "claude-unknown-3",
        }),
        [],
      );
    });

    it("builds Anthropic payloads only for Anthropic Messages protocol", function () {
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "anthropic", level: "high" },
          false,
          "claude-sonnet-4-6",
          "https://api.anthropic.com/v1",
          "openai_chat_compat",
          { maxTokens: 4096 },
        ),
        { extra: {}, omitTemperature: false },
      );

      assert.deepEqual(
        buildReasoningPayload(
          { provider: "anthropic", level: "xhigh" },
          false,
          "claude-sonnet-4-6",
          "https://api.anthropic.com/v1",
          "anthropic_messages",
          { maxTokens: 4096 },
        ),
        {
          extra: {
            thinking: { type: "adaptive" },
            output_config: { effort: "max" },
          },
          omitTemperature: true,
        },
      );

      assert.deepEqual(
        buildReasoningPayload(
          { provider: "anthropic", level: "xhigh" },
          false,
          "claude-opus-4-7",
          "https://api.anthropic.com/v1",
          "anthropic_messages",
          { maxTokens: 4096 },
        ),
        {
          extra: {
            thinking: { type: "adaptive" },
            output_config: { effort: "xhigh" },
          },
          omitTemperature: true,
        },
      );

      assert.deepEqual(
        buildReasoningPayload(
          { provider: "anthropic", level: "high" },
          false,
          "claude-haiku-4-5",
          "https://api.anthropic.com/v1",
          "anthropic_messages",
          { maxTokens: 4096 },
        ),
        {
          extra: {
            thinking: { type: "enabled", budget_tokens: 3072 },
          },
          omitTemperature: true,
        },
      );
    });
  });
});
