import type { ReasoningProvider } from "../provider";
import { anthropicAdapter } from "./anthropic";
import { deepseekAdapter } from "./deepseek";
import { geminiAdapter } from "./gemini";
import { kimiAdapter } from "./kimi";
import { mimoAdapter } from "./mimo";
import { openaiAdapter, grokAdapter } from "./openai";
import { qwenAdapter } from "./qwen";
import type { ReasoningAdapter } from "./types";

/**
 * The imperative reasoning encoders, keyed by provider family. A family with
 * no entry (glm, local) relies entirely on declarative registry controls or
 * the server's own defaults. Adding a family means adding an adapter module
 * and one line here — llmClient's dispatcher stays closed for modification.
 */
export const REASONING_ADAPTERS: Partial<
  Record<ReasoningProvider, ReasoningAdapter>
> = {
  openai: openaiAdapter,
  grok: grokAdapter,
  gemini: geminiAdapter,
  qwen: qwenAdapter,
  deepseek: deepseekAdapter,
  kimi: kimiAdapter,
  mimo: mimoAdapter,
  anthropic: anthropicAdapter,
};
