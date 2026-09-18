import { assert } from "chai";
import {
  getModelCapabilities,
  resetModelCapabilityStateForTests,
} from "../src/modelCapabilities";
import { detectReasoningProvider } from "../src/modules/contextPanel/chat";
import { inferProviderFromApiBase } from "../src/modelCapabilities";

describe("provider inference from model names", function () {
  afterEach(function () {
    resetModelCapabilityStateForTests();
  });

  it("resolves Kimi-for-Coding bare ids on an unrecognized host", function () {
    for (const model of ["k3", "k3-256k", "kimi-for-coding"]) {
      const capabilities = getModelCapabilities({
        model,
        apiBase: "https://api.kimi.com/coding/v1",
        protocol: "openai_chat_compat",
      });
      assert.equal(capabilities.provider, "kimi", model);
      assert.equal(capabilities.reasoning.kind, "select", model);
    }
  });

  it("falls back to model-name inference on relay hosts", function () {
    const relay = "https://relay.example.com/v1";
    assert.equal(
      getModelCapabilities({ model: "kimi-k3", apiBase: relay }).provider,
      "kimi",
    );
    assert.equal(
      getModelCapabilities({ model: "gemini-3.6-flash", apiBase: relay })
        .provider,
      "gemini",
    );
    assert.equal(
      getModelCapabilities({ model: "claude-opus-5", apiBase: relay }).provider,
      "anthropic",
    );
    assert.equal(
      getModelCapabilities({ model: "deepseek-v4-flash", apiBase: relay })
        .provider,
      "deepseek",
    );
  });

  it("keeps explicit provider identities authoritative", function () {
    assert.equal(
      getModelCapabilities({
        provider: "qwen",
        model: "kimi-k3",
        apiBase: "https://relay.example.com/v1",
      }).provider,
      "qwen",
    );
  });

  it("detects the kimi reasoning provider for coding-endpoint model names", function () {
    assert.equal(detectReasoningProvider("k3"), "kimi");
    assert.equal(detectReasoningProvider("k3-256k"), "kimi");
    assert.equal(detectReasoningProvider("kimi-for-coding"), "kimi");
    assert.equal(detectReasoningProvider("kimi-for-coding-highspeed"), "kimi");
  });

  it("does not mistake unrelated ids for the k3 alias", function () {
    assert.equal(detectReasoningProvider("k30"), "unsupported");
    assert.equal(detectReasoningProvider("k3x"), "unsupported");
    assert.equal(detectReasoningProvider("mock3"), "unsupported");
  });

  it("detects the glm reasoning provider so registry levels reach the request", function () {
    // The selector's send path drops the reasoning config when the provider
    // resolves to "unsupported" — glm-5.3-flash must stay a real provider.
    assert.equal(detectReasoningProvider("glm-5.3-flash"), "glm");
    assert.equal(detectReasoningProvider("glm-5.3"), "glm");
    assert.equal(detectReasoningProvider("glm-4.6"), "glm");
  });

  it("infers providers from API base substring tokens", function () {
    // Substring semantics (not hostname equality): relays, regional mirrors
    // and path-bearing bases must keep resolving like the hand-written chain
    // this table replaced.
    const cases: Array<[string, string | null]> = [
      ["https://api.moonshot.cn/v1", "kimi"],
      ["https://api.kimi.com/coding/v1", "kimi"],
      ["https://kimi-relay.example.com/v1", null],
      ["https://generativelanguage.googleapis.com/v1beta", "gemini"],
      ["https://api.anthropic.com/v1", "anthropic"],
      ["https://eu.api.anthropic.com", "anthropic"],
      ["https://api.deepseek.com/anthropic", "deepseek"],
      ["https://api.openai.com/v1", "openai"],
      ["https://api.x.ai/v1", "grok"],
      ["https://x.ai", "grok"],
      ["https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen"],
      ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "qwen"],
      ["https://open.bigmodel.cn/api/anthropic", "glm"],
      ["https://api.minimax.io/anthropic", "minimax"],
      ["https://api.xiaomimimo.com/v1", "mimo"],
      ["https://relay.example.com/v1", null],
      ["", null],
    ];
    for (const [base, expected] of cases) {
      assert.equal(inferProviderFromApiBase(base), expected, base);
    }
  });
});
