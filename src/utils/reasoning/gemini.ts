/**
 * The gemini family's one remaining code-side concern: decoding the
 * thinkingConfig a declarative compile produced, whichever spelling the
 * registry entry used. Its ladders (named entries and the registry-miss
 * family fallback) are declarative, so there is no encoder here anymore.
 */

/**
 * The thinkingConfig a declarative compile produced, whichever spelling the
 * entry used. The camel/snake duality is Gemini-entry knowledge and belongs
 * to this module alone — consumers (the chat payload builder and the agent's
 * native adapter) must not each carry it.
 */
export function extractGeminiThinkingConfig(
  declarative:
    | {
        extra?: Record<string, unknown>;
      }
    | null
    | undefined,
): Record<string, unknown> | undefined {
  const config =
    declarative?.extra?.thinkingConfig ?? declarative?.extra?.thinking_config;
  return isRecordLike(config) ? config : undefined;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
