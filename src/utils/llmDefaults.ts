import {
  CORE_RESEARCH_CONTRACT,
  PAPER_CITATION_CONTRACT,
  RESEARCH_RESPONSE_FORMAT_GUIDANCE,
} from "../shared/instructionContracts";

// The plugin sets no sampling or output defaults: an unset temperature or
// max-tokens is omitted from the request so the provider's own default
// applies, and an unknown model's input budget is left uncapped rather than
// replaced with a made-up number. Only corruption guards remain here.
export const MAX_ALLOWED_TOKENS = 100000000;
// Provider context windows are discovered at runtime.  Keep a high sanity
// ceiling for malformed values without imposing a product-level 2M limit.
export const MAX_ALLOWED_INPUT_TOKEN_CAP = 100000000;

// ---------------------------------------------------------------------------
// Default system prompt for non-agent (direct chat) mode.
// Editing this single location updates the prompt everywhere it is used.
// ---------------------------------------------------------------------------
export const DEFAULT_SYSTEM_PROMPT = [
  CORE_RESEARCH_CONTRACT,
  PAPER_CITATION_CONTRACT,
  RESEARCH_RESPONSE_FORMAT_GUIDANCE,
].join("\n\n");
