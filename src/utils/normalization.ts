/**
 * Shared normalization helpers for temperature and max-tokens values.
 *
 * Accepts both `number` and `string` inputs so the same function can be used
 * by the LLM client (numbers), the preferences UI (strings), and the context
 * panel (strings).
 *
 * Unset values stay unset: the plugin imposes no sampling or output defaults,
 * so an unset temperature/max-tokens is omitted from the request and the
 * provider's own default applies.
 */

import { MAX_ALLOWED_TOKENS, MAX_ALLOWED_INPUT_TOKEN_CAP } from "./llmDefaults";
import {
  getModelOutputTokenLimit as getCatalogOutputTokenLimit,
  type ModelCapabilityIdentity,
  type ModelProfileOverride,
} from "../modelCapabilities";

export function getModelOutputTokenLimit(
  modelName?: string,
  identity?: Omit<ModelCapabilityIdentity, "model">,
): number {
  return getCatalogOutputTokenLimit(modelName || "", identity);
}

/**
 * The catalog returns MAX_ALLOWED_TOKENS as its "unknown" sentinel; treat that
 * as no known limit rather than a usable number.
 */
export function isKnownOutputTokenLimit(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < MAX_ALLOWED_TOKENS;
}

/** Clamp a temperature value to [0, 2], preserving an unset value. */
export function normalizeTemperature(
  value?: number | string | null,
): number | undefined {
  // Number(null) === 0, so null must be treated as unset, not as zero.
  if (value === null || value === undefined) return undefined;
  const parsed =
    typeof value === "string" ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(2, Math.max(0, parsed));
}

/**
 * Resolve the temperature to send to a Gemini model, or undefined to omit it.
 *
 * An unset temperature is always omitted so Google's server-side default
 * applies (Gemini 3 guidance: lower values cause looping and degraded
 * reasoning). Explicit user values are always respected.
 */
export function resolveGeminiTemperature(
  _model: string | undefined,
  value?: number | string,
): number | undefined {
  return normalizeTemperature(value);
}

/** Clamp a max-tokens value to [1, MAX_ALLOWED_TOKENS], preserving an unset value. */
export function normalizeMaxTokens(
  value?: number | string | null,
): number | undefined {
  const parsed =
    typeof value === "string"
      ? Number.parseInt(value, 10)
      : Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.min(parsed, MAX_ALLOWED_TOKENS);
}

/** Clamp max-tokens using a model-specific output limit when known. */
export function normalizeMaxTokensForModel(
  value?: number | string | null,
  modelName?: string,
  identity?: Omit<ModelCapabilityIdentity, "model">,
): number | undefined {
  const parsed = normalizeMaxTokens(value);
  if (parsed === undefined) return undefined;
  return Math.min(
    parsed,
    getCatalogOutputTokenLimit(modelName || "", identity),
  );
}

/**
 * Anthropic's Messages API requires max_tokens. When the user has not set
 * one, use the model's catalogued output limit; if the catalog does not know
 * the model either, the field is omitted and the provider's own default
 * applies — no silent plugin default. Shared by the direct-chat client and
 * the agent-mode Anthropic adapter so neither can leak the catalog's
 * "unknown" sentinel as a request value.
 */
export function resolveAnthropicRequiredMaxTokens(
  maxTokens: number | undefined,
  model: string | undefined,
  identity?: {
    apiBase?: string;
    profileOverride?: ModelProfileOverride;
  },
): number | undefined {
  if (maxTokens !== undefined) return maxTokens;
  const catalogLimit = normalizeMaxTokensForModel(
    Number.MAX_SAFE_INTEGER,
    model,
    {
      apiBase: identity?.apiBase,
      protocol: "anthropic_messages",
      profileOverride: identity?.profileOverride,
    },
  );
  return catalogLimit !== undefined && isKnownOutputTokenLimit(catalogLimit)
    ? catalogLimit
    : undefined;
}

/** Clamp an input-token-cap value to [1, MAX_ALLOWED_INPUT_TOKEN_CAP], with configurable fallback. */
export function normalizeInputTokenCap(
  value?: number | string,
  fallback?: number,
): number | undefined {
  const parsed =
    typeof value === "string"
      ? Number.parseInt(value, 10)
      : Math.floor(Number(value));
  const fallbackFloor = Math.floor(Number(fallback));
  if (!Number.isFinite(parsed) || parsed < 1) {
    return Number.isFinite(fallbackFloor) && fallbackFloor >= 1
      ? Math.min(fallbackFloor, MAX_ALLOWED_INPUT_TOKEN_CAP)
      : undefined;
  }
  return Math.min(parsed, MAX_ALLOWED_INPUT_TOKEN_CAP);
}

/** Clamp an optional input-token-cap value to [1, MAX_ALLOWED_INPUT_TOKEN_CAP], returning undefined when blank/invalid. */
export function normalizeOptionalInputTokenCap(
  value?: number | string | null,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed =
    typeof value === "string"
      ? Number.parseInt(value, 10)
      : Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.min(parsed, MAX_ALLOWED_INPUT_TOKEN_CAP);
}
