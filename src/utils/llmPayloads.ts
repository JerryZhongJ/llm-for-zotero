/**
 * Request-body assembly for the wire protocols, split out of llmClient so
 * the transport layer (streams, retries, fallback chains) and the payload
 * layer can evolve separately. This module must never import llmClient —
 * llmClient imports it — or the import-cycle gate trips.
 */

import type { ChatMessage, ReasoningConfig } from "../shared/llm";
import { parseDataUrl } from "../shared/dataUrl";
import type { ProviderProtocol } from "./providerProtocol";
import {
  compileReasoningControls,
  getModelCapabilities,
  isReservedRequestKey,
  profileOverrideAppliesTo,
  type ModelProfileOverride,
} from "../modelCapabilities";
import { withGeminiThoughtSummaries } from "./reasoningProfiles";
import { extractGeminiThinkingConfig } from "./reasoning/gemini";
import { dispatchReasoningEncoding } from "./llmFamilies";
import {
  emptyReasoningPayload,
  type AnthropicReasoningModeOverride,
  type ReasoningPayload,
} from "./reasoning/types";
import { resolveAnthropicRequiredMaxTokens } from "./normalization";
import type { ContextCachePlan } from "../contextCache/manager";
import { isRecord } from "../modelCapabilities";

export type NativePdfPart = {
  base64: string;
};

export type ReasoningPayloadOptions = {
  maxTokens?: number;
  anthropicModeOverride?: AnthropicReasoningModeOverride;
  /** User-authored capability overrides, including extra body parameters. */
  profileOverride?: ModelProfileOverride;
};

export type ReasoningSelection = ReasoningConfig & {
  anthropicModeOverride?: AnthropicReasoningModeOverride;
};

/**
 * Reasoning controls plus any user-authored extra request parameters.
 *
 * `extraBody` is not reasoning-specific, but this function's result is already
 * spread into every payload builder, so it is the one hook that reaches all
 * protocols. Reasoning controls are layered on top: the reasoning selector is
 * a live per-message control, and static configuration must not silently
 * override what the user just picked.
 */
export function buildReasoningPayload(
  reasoning: ReasoningConfig | undefined,
  useResponses: boolean,
  modelName?: string,
  apiBase?: string,
  providerProtocol?: ProviderProtocol,
  options?: ReasoningPayloadOptions,
): { extra: Record<string, unknown>; omitTemperature: boolean } {
  const base = dispatchReasoningEncoding({
    model: modelName || "",
    apiBase,
    protocol: providerProtocol,
    profileOverride: options?.profileOverride,
    reasoning,
    useResponses,
    maxTokens: options?.maxTokens,
    anthropicModeOverride: options?.anthropicModeOverride,
  });
  const extraBody = resolveUserExtraBody(options?.profileOverride, modelName);
  if (!extraBody) return base;
  return {
    extra: { ...extraBody, ...base.extra },
    omitTemperature: base.omitTemperature,
  };
}

/**
 * The extra request parameters an override contributes to a request — after
 * the reserved-key strip, and only when the override was authored for the
 * model being called (a dormant override from a renamed entry contributes
 * nothing; see `forModel`).
 */
export function resolveUserExtraBody(
  profileOverride: ModelProfileOverride | undefined,
  modelName: string | undefined,
): Record<string, unknown> | undefined {
  if (!profileOverrideAppliesTo(profileOverride, modelName || "")) {
    return undefined;
  }
  return stripReservedRequestKeys(profileOverride?.extraBody);
}

/**
 * Last line of defence against a user parameter occupying an envelope key.
 *
 * The editor rejects these at input time with a visible message, so reaching
 * here means a hand-edited or imported config. Silent by design: every payload
 * builder spreads the reasoning extras into the body, most of them after the
 * envelope, so an unfiltered `messages` or `tools` key would replace the
 * conversation or drop every tool definition.
 */
export function stripReservedRequestKeys(
  extraBody: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!extraBody) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extraBody)) {
    if (isReservedRequestKey(key)) continue;
    kept[key] = value;
  }
  return Object.keys(kept).length ? kept : undefined;
}

export function buildAnthropicMessagesPayload(params: {
  model: string;
  messages: ChatMessage[];
  effectiveMaxTokens: number | undefined;
  effectiveTemperature: number | undefined;
  stream: boolean;
  reasoning?: ReasoningConfig;
  apiBase?: string;
  anthropicModeOverride?: AnthropicReasoningModeOverride;
  pdfParts?: NativePdfPart[];
  contextCache?: ContextCachePlan;
  profileOverride?: ModelProfileOverride;
}): Record<string, unknown> {
  const systemParts = params.messages
    .filter((m) => m.role === "system")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((c) => ("text" in c ? c.text : "")).join(""),
    )
    .filter(Boolean);
  const nonSystemSourceMessages = params.messages.filter(
    (m) => m.role !== "system",
  );
  let lastUserMessageIndex = -1;
  for (let index = nonSystemSourceMessages.length - 1; index >= 0; index--) {
    if (nonSystemSourceMessages[index].role === "user") {
      lastUserMessageIndex = index;
      break;
    }
  }
  const documentBlocks = (params.pdfParts || []).map((part) => ({
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: part.base64,
    },
  }));
  const nonSystemMessages = nonSystemSourceMessages.map((m, index) => {
    const content =
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : m.content.map((c) => {
            if (c.type !== "image_url") {
              return { type: "text", text: (c as { text: string }).text };
            }
            const parsed = parseDataUrl(
              (c as { image_url: { url: string } }).image_url.url,
            );
            if (parsed?.mimeType === "application/pdf") {
              return {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: parsed.data,
                },
              };
            }
            return {
              type: "image",
              source: {
                type: "base64",
                media_type: parsed?.mimeType || "image/jpeg",
                data: parsed?.data || "",
              },
            };
          });
    if (index === lastUserMessageIndex && documentBlocks.length) {
      content.push(...documentBlocks);
    }
    return {
      role: m.role as "user" | "assistant",
      content,
    };
  });
  // Anthropic's Messages API requires max_tokens; when unset, use the
  // catalogued model limit, and only omit it when even that is unknown.
  const anthropicMaxTokens = resolveAnthropicRequiredMaxTokens(
    params.effectiveMaxTokens,
    params.model,
    {
      apiBase: params.apiBase,
      profileOverride: params.profileOverride,
    },
  );
  const payload: Record<string, unknown> = {
    model: params.model,
    ...(anthropicMaxTokens !== undefined
      ? { max_tokens: anthropicMaxTokens }
      : {}),
    messages: nonSystemMessages,
  };
  const reasoningPayload = buildReasoningPayload(
    params.reasoning,
    false,
    params.model,
    params.apiBase,
    "anthropic_messages",
    {
      maxTokens: anthropicMaxTokens,
      anthropicModeOverride: params.anthropicModeOverride,
      profileOverride: params.profileOverride,
    },
  );
  Object.assign(payload, reasoningPayload.extra);
  if (systemParts.length > 0) {
    const systemText = systemParts.join("\n\n");
    const cacheControl =
      params.contextCache?.enabled &&
      params.contextCache.requestHints?.anthropicBlockCacheControl
        ? params.contextCache.requestHints.anthropicBlockCacheControl
        : undefined;
    payload.system = cacheControl
      ? [{ type: "text", text: systemText, cache_control: cacheControl }]
      : systemText;
  }
  if (
    !reasoningPayload.omitTemperature &&
    params.effectiveTemperature !== undefined
  ) {
    payload.temperature = params.effectiveTemperature;
  }
  if (params.stream) {
    payload.stream = true;
  }
  return payload;
}

export function buildGeminiNativePayload(params: {
  model: string;
  apiBase?: string;
  messages: ChatMessage[];
  effectiveMaxTokens: number | undefined;
  /** Omitted from the payload when undefined (Gemini 3 server default). */
  temperature: number | undefined;
  reasoning?: ReasoningConfig;
  pdfParts?: Array<{ base64: string }>;
  profileOverride?: ModelProfileOverride;
}): Record<string, unknown> {
  const systemParts = params.messages
    .filter((m) => m.role === "system")
    .map((m) => ({
      text:
        typeof m.content === "string"
          ? m.content
          : m.content.map((c) => ("text" in c ? c.text : "")).join(""),
    }))
    .filter((p) => p.text);
  const contents: Array<{ role: string; parts: unknown[] }> = params.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts:
        typeof m.content === "string"
          ? [{ text: m.content }]
          : m.content.map((c) =>
              c.type === "image_url"
                ? (() => {
                    const parsed = parseDataUrl(
                      (c as { image_url: { url: string } }).image_url.url,
                    );
                    return {
                      inline_data: {
                        mime_type: parsed?.mimeType || "image/jpeg",
                        data: parsed?.data || "",
                      },
                    };
                  })()
                : { text: (c as { text: string }).text },
            ),
    }));
  if (params.pdfParts?.length) {
    let lastUserIdx = -1;
    for (let i = contents.length - 1; i >= 0; i--) {
      if (contents[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx >= 0) {
      for (const p of params.pdfParts) {
        contents[lastUserIdx].parts.push({
          inlineData: { mimeType: "application/pdf", data: p.base64 },
        });
      }
    }
  }
  // User extra parameters ride along here the same as on every other
  // protocol; a user generationConfig is merged under the envelope so the
  // dedicated temperature/max-token fields keep the last word on a collision.
  const extraBody = resolveUserExtraBody(params.profileOverride, params.model);
  const { generationConfig: extraGenerationConfig, ...extraTop } = (extraBody ||
    {}) as { generationConfig?: unknown } & Record<string, unknown>;
  const payload: Record<string, unknown> = {
    ...extraTop,
    contents,
    generationConfig: {
      ...(isRecord(extraGenerationConfig) ? extraGenerationConfig : {}),
      ...(params.effectiveMaxTokens !== undefined
        ? { maxOutputTokens: params.effectiveMaxTokens }
        : {}),
      ...(params.temperature !== undefined
        ? { temperature: params.temperature }
        : {}),
    },
  };
  if (params.reasoning?.provider === "gemini") {
    const declarative = compileReasoningControls(
      getModelCapabilities({
        provider: "gemini",
        model: params.model,
        apiBase: params.apiBase,
        protocol: "gemini_native",
        profileOverride: params.profileOverride,
      }),
      params.reasoning,
    );
    const generationConfig = payload.generationConfig as Record<
      string,
      unknown
    >;
    const declaredGenerationConfig =
      declarative?.extra.generationConfig ||
      declarative?.extra.generation_config;
    if (
      declaredGenerationConfig &&
      typeof declaredGenerationConfig === "object" &&
      !Array.isArray(declaredGenerationConfig)
    ) {
      Object.assign(generationConfig, declaredGenerationConfig);
    }
    const declarativeConfig =
      extractGeminiThinkingConfig(declarative) ||
      generationConfig.thinkingConfig;
    if (isRecord(declarativeConfig)) {
      generationConfig.thinkingConfig =
        withGeminiThoughtSummaries(declarativeConfig);
    }
    if (declarative?.omitTemperature) delete generationConfig.temperature;
  }
  if (systemParts.length > 0) {
    payload.systemInstruction = { parts: systemParts };
  }
  return payload;
}
