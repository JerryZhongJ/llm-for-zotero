/**
 * Single source of truth for LLM provider identity.
 *
 * Every list, set, type, or switch that needs to know "which provider
 * families exist" derives from the constants here (see issue #360 and the
 * glm-5.3-flash reasoning regression, where hand-copied member lists drifted
 * apart). This module is a zero-dependency leaf: anything may import it, and
 * it must never import project code back — including type-only imports, which
 * the import-cycle checker rejects just like runtime ones.
 */

/** Hosted provider families, in provider-preset declaration order. */
export const PROVIDER_IDS = [
  "openai",
  "gemini",
  "anthropic",
  "minimax",
  "glm",
  "deepseek",
  "grok",
  "qwen",
  "kimi",
  "mimo",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Families with a hand-maintained reasoning profile or adapter. MiniMax is
 * excluded: it has no profile today, and `detectReasoningProvider` returning
 * "unsupported" for minimax models is current behavior, not an oversight.
 */
export const REASONING_PROVIDER_IDS = [
  "openai",
  "gemini",
  "deepseek",
  "kimi",
  "mimo",
  "qwen",
  "grok",
  "anthropic",
  "glm",
] as const satisfies readonly ProviderId[];
export type ReasoningProviderId = (typeof REASONING_PROVIDER_IDS)[number];

/** Reasoning-profile providers, `local` included (locally served weights). */
export type ReasoningProvider = ReasoningProviderId | "local";
export const ALL_REASONING_PROVIDERS: readonly ReasoningProvider[] = [
  ...REASONING_PROVIDER_IDS,
  "local",
];

export function isReasoningProvider(
  value: string,
): value is ReasoningProviderId {
  return (REASONING_PROVIDER_IDS as readonly string[]).includes(value);
}

export type ProviderHostRule = {
  /**
   * Exact hostnames this provider is served on. The provider presets derive
   * their host matchers from this list.
   */
  hosts: readonly string[];
  /**
   * Loose substring tokens; `inferProviderFromApiBase` keeps its historical
   * `base.includes(token)` semantics so relays and regional mirrors still
   * resolve to the right family.
   */
  hostTokens: readonly string[];
};

export const PROVIDER_HOSTS: Record<ProviderId, ProviderHostRule> = {
  openai: { hosts: ["api.openai.com"], hostTokens: ["openai.com"] },
  gemini: {
    hosts: ["generativelanguage.googleapis.com"],
    hostTokens: ["generativelanguage.googleapis.com"],
  },
  anthropic: { hosts: ["api.anthropic.com"], hostTokens: ["anthropic.com"] },
  minimax: {
    hosts: ["api.minimax.io", "api.minimaxi.com"],
    hostTokens: ["minimax"],
  },
  glm: { hosts: ["open.bigmodel.cn"], hostTokens: ["bigmodel.cn"] },
  deepseek: { hosts: ["api.deepseek.com"], hostTokens: ["deepseek.com"] },
  grok: { hosts: ["api.x.ai"], hostTokens: ["x.ai"] },
  qwen: {
    hosts: [
      "dashscope.aliyuncs.com",
      "dashscope-intl.aliyuncs.com",
      "dashscope-us.aliyuncs.com",
    ],
    hostTokens: ["dashscope", "aliyuncs.com"],
  },
  kimi: {
    hosts: ["api.moonshot.cn", "api.moonshot.ai", "api.kimi.com"],
    hostTokens: ["moonshot", "api.kimi.com"],
  },
  mimo: {
    hosts: ["api.xiaomimimo.com"],
    hostTokens: ["xiaomimimo.com"],
  },
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI",
  gemini: "Gemini",
  anthropic: "Anthropic",
  minimax: "MiniMax",
  glm: "GLM",
  deepseek: "DeepSeek",
  grok: "Grok",
  qwen: "Qwen",
  kimi: "Kimi",
  mimo: "Xiaomi MiMo",
};

const MODEL_NAME_RULES: Array<{
  provider: ProviderId;
  pattern: RegExp;
}> = [
  { provider: "deepseek", pattern: /^deepseek/ },
  { provider: "kimi", pattern: /(^|[/:])kimi(?:\b|[.-])/ },
  // Kimi-for-Coding (api.kimi.com/coding/v1) serves the K3 family under bare
  // ids: k3, k3-256k. The boundary check keeps k30/k3x out.
  { provider: "kimi", pattern: /(^|[/:])k3(?:\b|[.-])/ },
  {
    provider: "mimo",
    pattern: /(^|[/:])mimo-v2(?:\.5)?(?:-(?:pro|omni|flash))?(?:\b|[.-])/,
  },
  { provider: "qwen", pattern: /(^|[/:])(?:qwen(?:\d+)?|qwq|qvq)(?:\b|[.-])/ },
  { provider: "grok", pattern: /(^|[/:])grok(?:\b|[.-])/ },
  { provider: "anthropic", pattern: /(^|[/:.])claude(?:\b|[.-])/ },
  { provider: "gemini", pattern: /gemini/ },
  { provider: "openai", pattern: /^(gpt-5|o\d)(\b|[.-])/ },
  { provider: "glm", pattern: /(^|[/:])glm(?:\b|[.-])/ },
  { provider: "minimax", pattern: /(^|[/:])minimax(?:\b|[.-])/ },
];

/** Infer the provider family from a model id, or null when unrecognized. */
export function inferProviderFromModelName(
  modelName: string,
): ProviderId | null {
  const name = modelName.trim().toLowerCase();
  if (!name) return null;
  for (const rule of MODEL_NAME_RULES) {
    if (rule.pattern.test(name)) return rule.provider;
  }
  return null;
}

/**
 * Token-check precedence, preserved from the original hand-written chain so a
 * base somehow containing two families' tokens keeps resolving as it always
 * has.
 */
const HOST_TOKEN_PRECEDENCE: readonly ProviderId[] = [
  "kimi",
  "gemini",
  "anthropic",
  "deepseek",
  "openai",
  "grok",
  "qwen",
  "glm",
  "minimax",
  "mimo",
];

/** Infer the provider family from an API base URL, or null when unrecognized. */
export function inferProviderFromApiBase(apiBase: string): ProviderId | null {
  const base = apiBase.trim().toLowerCase();
  if (!base) return null;
  for (const provider of HOST_TOKEN_PRECEDENCE) {
    const tokens = PROVIDER_HOSTS[provider].hostTokens;
    if (tokens.some((token) => base.includes(token))) return provider;
  }
  return null;
}

type ParsedApiBase = {
  hostname: string;
  pathname: string;
  port: string;
};

export function normalizeApiBase(apiBase: string): string {
  return typeof apiBase === "string" ? apiBase.trim().replace(/\/+$/, "") : "";
}

export function parseApiBase(apiBase: string): ParsedApiBase | null {
  const normalized = normalizeApiBase(apiBase);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    return {
      hostname: parsed.hostname.trim().toLowerCase(),
      pathname: parsed.pathname.replace(/\/+$/, "") || "/",
      port: parsed.port,
    };
  } catch (_err) {
    return null;
  }
}

/** Private IPv4 ranges (RFC1918) plus link-local, for LAN-hosted runtimes. */
function isPrivateIPv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
  const parts = octets.map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 169.254.0.0/16 link-local, e.g. a directly attached inference box.
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateOrLoopbackIPv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
  return octets.every((part) => {
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

export function isLocalHostname(hostname: string): boolean {
  if (!hostname) return false;
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname === "host.docker.internal"
  ) {
    return true;
  }
  // 127.0.0.0/8 loopback and *.localhost both resolve to the local machine.
  if (hostname.startsWith("127.")) return isPrivateOrLoopbackIPv4(hostname);
  if (hostname.endsWith(".localhost")) return true;
  // mDNS names published by a machine on the same LAN.
  if (hostname.endsWith(".local")) return true;
  return isPrivateIPv4(hostname);
}

/**
 * True when an API base points at a model server on this machine or the local
 * network. Used to decide that an API key is optional and that requests may go
 * over plain HTTP — never to override which provider family a model belongs
 * to, since `deepseek-r1:8b` served by Ollama is still DeepSeek's weights.
 */
export function isLocalModelApiBase(apiBase: string): boolean {
  const parsed = parseApiBase(apiBase);
  return parsed ? isLocalHostname(parsed.hostname) : false;
}

/**
 * The shared tail of provider resolution: a recognizable model name keeps its
 * family even when served from a relay or local runtime; only a name that
 * matches nothing falls back to "local" when the base says so. Both
 * `providerFromIdentity` (which tries the API base first) and
 * `detectReasoningProvider` (which never does) must end with this exact
 * sequence — previously the two were kept in sync by a comment asking them to
 * mirror each other.
 */
export function resolveProviderOrLocal(
  modelName: string,
  apiBase?: string,
): ProviderId | "local" | null {
  return (
    inferProviderFromModelName(modelName) ??
    (apiBase && isLocalModelApiBase(apiBase) ? "local" : null)
  );
}
