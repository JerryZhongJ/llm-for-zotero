import type { ProviderProtocol } from "./providerProtocol";
import {
  PROVIDER_HOSTS,
  PROVIDER_IDS,
  isLocalHostname,
  isLocalModelApiBase,
  normalizeApiBase,
  parseApiBase,
  type ProviderId,
} from "./provider";

// Hosted preset ids derive from the provider identity list; the three
// special-surface ids (device-login Copilot, Ollama's native protocol, and
// the generic local OpenAI-compatible server) are preset concepts, not model
// families, and stay here.
export type SupportedProviderPresetId =
  | ProviderId
  | "copilot"
  | "ollama"
  | "local_openai";

export type ProviderPresetId = SupportedProviderPresetId | "customized";

export type ProviderPreset = {
  id: SupportedProviderPresetId;
  label: string;
  defaultApiBase: string;
  defaultProtocol: ProviderProtocol;
  supportedProtocols: ProviderProtocol[];
  helperText: string;
  matches: (apiBase: string) => boolean;
  /** When true, prefer /v1/responses over /v1/chat/completions when calling the API. */
  supportsResponsesEndpoint?: boolean;
  /** Whether this provider exposes an OpenAI-compatible /v1/embeddings endpoint. */
  supportsEmbeddings?: boolean;
  /** Default embedding model name for providers that support embeddings. */
  defaultEmbeddingModel?: string;
  /**
   * Whether an API key is mandatory. Absent means required. Local runtimes
   * (Ollama, LM Studio, llama.cpp, vLLM) serve unauthenticated by default, so
   * the key field, the connection test and the model catalog must all work
   * with it left blank.
   */
  requiresApiKey?: boolean;
};

const GENERAL_API_KEY_PROTOCOL_OPTIONS: ProviderProtocol[] = [
  "responses_api",
  "openai_chat_compat",
  "anthropic_messages",
];

const CUSTOMIZED_API_KEY_PROTOCOL_OPTIONS: ProviderProtocol[] = [
  ...GENERAL_API_KEY_PROTOCOL_OPTIONS,
  "gemini_native",
];

// URL parsing and local-host detection live in src/utils/provider.ts; the
// re-export keeps every existing consumer's import path working.
export { isLocalModelApiBase };

function matchesPaths(pathname: string, paths: string[]): boolean {
  return paths.includes(pathname);
}

function isHost(
  parsed: ReturnType<typeof parseApiBase>,
  hosts: readonly string[],
): boolean {
  if (!parsed) return false;
  return hosts.includes(parsed.hostname);
}

function makeHostAndPathMatcher(hosts: readonly string[], paths: string[]) {
  return (apiBase: string) => {
    const parsed = parseApiBase(apiBase);
    if (!parsed) return false;
    return isHost(parsed, hosts) && matchesPaths(parsed.pathname, paths);
  };
}

const OPENAI_PATHS = [
  "/",
  "/v1",
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/files",
  "/v1/embeddings",
];

const GEMINI_PATHS = [
  "/",
  "/v1",
  "/v1/models",
  "/v1alpha",
  "/v1alpha/models",
  "/v1beta",
  "/v1beta/models",
  "/v1beta/openai",
  "/v1beta/openai/chat/completions",
  "/v1beta/openai/responses",
  "/v1beta/openai/files",
];

const ANTHROPIC_PATHS = ["/", "/v1", "/v1/messages", "/v1/chat/completions"];
const MINIMAX_PATHS = [
  "/",
  "/v1",
  "/v1/chat/completions",
  "/anthropic",
  "/anthropic/v1",
  "/anthropic/v1/messages",
];
const GLM_PATHS = [
  "/",
  "/api/paas/v4",
  "/api/paas/v4/chat/completions",
  "/api/coding/paas/v4",
  "/api/coding/paas/v4/chat/completions",
  "/api/anthropic",
  "/api/anthropic/v1",
  "/api/anthropic/v1/messages",
];
const DEEPSEEK_PATHS = [
  "/",
  "/v1",
  "/v1/chat/completions",
  "/anthropic",
  "/anthropic/v1",
  "/anthropic/v1/messages",
];
const GROK_PATHS = ["/", "/v1", "/v1/chat/completions", "/v1/responses"];
const QWEN_PATHS = [
  "/",
  "/compatible-mode/v1",
  "/compatible-mode/v1/chat/completions",
  "/compatible-mode/v1/responses",
  "/api/v2/apps/protocols/compatible-mode/v1",
  "/api/v2/apps/protocols/compatible-mode/v1/responses",
];
const KIMI_PATHS = [
  "/",
  "/v1",
  "/v1/chat/completions",
  // Kimi-for-Coding subscription endpoint (api.kimi.com).
  "/coding",
  "/coding/v1",
  "/coding/v1/chat/completions",
];
const MIMO_PATHS = ["/", "/v1", "/v1/chat/completions"];
const COPILOT_PATHS = ["/", "/chat/completions", "/models"];

const OLLAMA_DEFAULT_PORT = "11434";

/**
 * Ollama is claimed when the base is local and either sits on its default port
 * or already names an /api path. Anything else local falls through to the
 * generic OpenAI-compatible preset below, so LM Studio (1234), llama.cpp (8080)
 * and vLLM (8000) are not mislabelled.
 */
function matchesOllamaBase(apiBase: string): boolean {
  const parsed = parseApiBase(apiBase);
  if (!parsed || !isLocalHostname(parsed.hostname)) return false;
  if (parsed.port === OLLAMA_DEFAULT_PORT) return true;
  return parsed.pathname === "/api" || parsed.pathname.startsWith("/api/");
}

function matchesLocalOpenAIBase(apiBase: string): boolean {
  return isLocalModelApiBase(apiBase);
}

// One preset per hosted family, keyed so the compiler enforces full coverage
// when a family is added. Matcher hostnames come from PROVIDER_HOSTS so the
// preset matcher and the family inference cannot drift apart.
const PROVIDER_PRESETS_BY_ID: Record<ProviderId, ProviderPreset> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    defaultApiBase: "https://api.openai.com/v1/responses",
    defaultProtocol: "responses_api",
    supportedProtocols: ["responses_api", "openai_chat_compat"],
    helperText: "Preset uses OpenAI's official Responses endpoint.",
    matches: makeHostAndPathMatcher(PROVIDER_HOSTS.openai.hosts, OPENAI_PATHS),
    supportsResponsesEndpoint: true,
    supportsEmbeddings: true,
    defaultEmbeddingModel: "text-embedding-3-small",
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    defaultApiBase: "https://generativelanguage.googleapis.com/v1beta",
    defaultProtocol: "gemini_native",
    supportedProtocols: ["gemini_native", "openai_chat_compat"],
    helperText: "Preset uses Gemini's native generateContent endpoint.",
    matches: makeHostAndPathMatcher(PROVIDER_HOSTS.gemini.hosts, GEMINI_PATHS),
    supportsEmbeddings: true,
    defaultEmbeddingModel: "gemini-embedding-001",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    defaultApiBase: "https://api.anthropic.com/v1",
    defaultProtocol: "anthropic_messages",
    supportedProtocols: ["anthropic_messages", "openai_chat_compat"],
    helperText: "Preset uses Anthropic's native Messages API.",
    matches: makeHostAndPathMatcher(
      PROVIDER_HOSTS.anthropic.hosts,
      ANTHROPIC_PATHS,
    ),
    supportsEmbeddings: false,
  },
  minimax: {
    id: "minimax",
    label: "MiniMax",
    defaultApiBase: "https://api.minimax.io/anthropic",
    defaultProtocol: "anthropic_messages",
    supportedProtocols: ["anthropic_messages", "openai_chat_compat"],
    helperText:
      "Preset uses MiniMax's recommended Anthropic-compatible endpoint.",
    matches: makeHostAndPathMatcher(
      PROVIDER_HOSTS.minimax.hosts,
      MINIMAX_PATHS,
    ),
    supportsEmbeddings: false,
  },
  glm: {
    id: "glm",
    label: "GLM",
    defaultApiBase: "https://open.bigmodel.cn/api/anthropic",
    defaultProtocol: "anthropic_messages",
    supportedProtocols: ["anthropic_messages", "openai_chat_compat"],
    helperText:
      "Preset uses GLM's Claude-compatible endpoint for agent tool use.",
    matches: makeHostAndPathMatcher(PROVIDER_HOSTS.glm.hosts, GLM_PATHS),
    supportsEmbeddings: false,
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    defaultApiBase: "https://api.deepseek.com/anthropic",
    defaultProtocol: "anthropic_messages",
    supportedProtocols: ["anthropic_messages", "openai_chat_compat"],
    helperText:
      "Preset uses DeepSeek's Anthropic-compatible endpoint for reliable agent tool use.",
    matches: makeHostAndPathMatcher(
      PROVIDER_HOSTS.deepseek.hosts,
      DEEPSEEK_PATHS,
    ),
    supportsEmbeddings: true,
    defaultEmbeddingModel: "deepseek-embedding",
  },
  grok: {
    id: "grok",
    label: "Grok",
    defaultApiBase: "https://api.x.ai/v1/responses",
    defaultProtocol: "responses_api",
    supportedProtocols: ["responses_api", "openai_chat_compat"],
    helperText: "Preset uses xAI's official Responses endpoint.",
    matches: makeHostAndPathMatcher(PROVIDER_HOSTS.grok.hosts, GROK_PATHS),
    supportsResponsesEndpoint: true,
    supportsEmbeddings: false,
  },
  qwen: {
    id: "qwen",
    label: "Qwen",
    defaultApiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat", "responses_api"],
    helperText: "Preset uses DashScope's compatible-mode API base (v1).",
    matches: makeHostAndPathMatcher(PROVIDER_HOSTS.qwen.hosts, QWEN_PATHS),
    supportsResponsesEndpoint: true,
    supportsEmbeddings: true,
    defaultEmbeddingModel: "text-embedding-v4",
  },
  kimi: {
    id: "kimi",
    label: "Kimi",
    defaultApiBase: "https://api.moonshot.ai/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText:
      "Moonshot platform keys use api.moonshot.ai (api.moonshot.cn for China). " +
      "Kimi coding-plan keys only work with https://api.kimi.com/coding/v1.",
    matches: makeHostAndPathMatcher(PROVIDER_HOSTS.kimi.hosts, KIMI_PATHS),
    supportsEmbeddings: false,
  },
  mimo: {
    id: "mimo",
    label: "Xiaomi MiMo",
    defaultApiBase: "https://api.xiaomimimo.com/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses Xiaomi MiMo's OpenAI-compatible API base (v1).",
    matches: makeHostAndPathMatcher(PROVIDER_HOSTS.mimo.hosts, MIMO_PATHS),
    supportsEmbeddings: false,
  },
};

// Local runtimes go last: their matchers accept broad local hosts, so a
// hosted preset must get the chance to claim the base first. Within the pair,
// ollama must precede local_openai — detectProviderPreset returns the first
// match and local_openai accepts every local host.
const COPILOT_PRESET: ProviderPreset = {
  id: "copilot",
  label: "GitHub Copilot",
  defaultApiBase: "https://api.githubcopilot.com",
  defaultProtocol: "openai_chat_compat",
  supportedProtocols: ["openai_chat_compat", "responses_api"],
  helperText:
    "Uses GitHub Copilot via device login. Requires an active Copilot subscription.",
  matches: makeHostAndPathMatcher(["api.githubcopilot.com"], COPILOT_PATHS),
  supportsEmbeddings: false,
};

const OLLAMA_PRESET: ProviderPreset = {
  id: "ollama",
  label: "Ollama (local)",
  defaultApiBase: "http://localhost:11434",
  defaultProtocol: "ollama_native",
  supportedProtocols: ["ollama_native", "openai_chat_compat"],
  helperText:
    "Preset uses Ollama's native /api/chat endpoint, which separates thinking " +
    "from the answer and honours the think parameter. No API key required.",
  matches: matchesOllamaBase,
  supportsEmbeddings: true,
  defaultEmbeddingModel: "nomic-embed-text",
  requiresApiKey: false,
};

const LOCAL_OPENAI_PRESET: ProviderPreset = {
  id: "local_openai",
  label: "Local (OpenAI-compatible)",
  defaultApiBase: "http://localhost:1234/v1",
  defaultProtocol: "openai_chat_compat",
  supportedProtocols: ["openai_chat_compat", "responses_api"],
  helperText:
    "For LM Studio, llama.cpp, vLLM, Jan and other local OpenAI-compatible " +
    "servers. No API key required.",
  matches: matchesLocalOpenAIBase,
  supportsEmbeddings: true,
  requiresApiKey: false,
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  ...PROVIDER_IDS.map((id) => PROVIDER_PRESETS_BY_ID[id]),
  COPILOT_PRESET,
  OLLAMA_PRESET,
  LOCAL_OPENAI_PRESET,
];

/** True when the preset serves unauthenticated, so a blank API key is valid. */
export function providerPresetRequiresApiKey(id: ProviderPresetId): boolean {
  if (id === "customized") return true;
  return getProviderPreset(id).requiresApiKey !== false;
}

export function getProviderPreset(
  id: SupportedProviderPresetId,
): ProviderPreset {
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === id);
  if (!preset) {
    throw new Error(`Unknown provider preset: ${id}`);
  }
  return preset;
}

function dedupeProtocols(protocols: ProviderProtocol[]): ProviderProtocol[] {
  return protocols.filter(
    (protocol, index) => protocols.indexOf(protocol) === index,
  );
}

export function getProviderPresetProtocolOptions(
  id: ProviderPresetId,
): ProviderProtocol[] {
  if (id === "customized") {
    return [...CUSTOMIZED_API_KEY_PROTOCOL_OPTIONS];
  }
  const preset = getProviderPreset(id);
  // Local runtimes speak exactly what they declare. Appending the general
  // hosted options would offer anthropic_messages against an Ollama or
  // llama.cpp server, which never serves it.
  if (preset.requiresApiKey === false) {
    return dedupeProtocols([...preset.supportedProtocols]);
  }
  return dedupeProtocols([
    ...preset.supportedProtocols,
    ...GENERAL_API_KEY_PROTOCOL_OPTIONS,
  ]);
}

export function detectProviderPreset(apiBase: string): ProviderPresetId {
  const normalized = normalizeApiBase(apiBase);
  if (!normalized) return "customized";
  for (const preset of PROVIDER_PRESETS) {
    if (preset.matches(normalized)) return preset.id;
  }
  return "customized";
}

export function isGrokApiBase(apiBase: string): boolean {
  return getProviderPreset("grok").matches(apiBase);
}

/** True if the given apiBase is for a known provider that supports the /v1/responses endpoint. */
export function providerSupportsResponsesEndpoint(apiBase: string): boolean {
  const id = detectProviderPreset(apiBase);
  if (id === "customized") return false;
  const preset = getProviderPreset(id);
  return Boolean(preset.supportsResponsesEndpoint);
}
