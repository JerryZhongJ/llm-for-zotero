import { callUtilityLLM, logUtilityLLMFailure } from "../utils/utilityLLM";
import type { AgentRuntimeRequest } from "./types";

/**
 * The auto-mode gate for model-originated irreversible writes, positioned
 * exactly like Claude Code's auto-mode permission classifier: nothing asks
 * the user, but a write that cannot be undone is checked against the user's
 * request by a model before it runs. A gate that cannot run fails closed.
 */

export type WriteGateVerdict =
  | { kind: "allow"; reason?: string }
  | { kind: "refuse"; reason: string }
  | { kind: "unavailable"; reason: string };

type WriteGateRequest = Pick<
  AgentRuntimeRequest,
  "userText" | "model" | "apiBase" | "apiKey" | "authMode" | "providerProtocol"
> & {
  advanced?: AgentRuntimeRequest["advanced"];
};

export function canUseWriteGateModel(
  request: Pick<AgentRuntimeRequest, "model" | "apiBase" | "authMode">,
): boolean {
  if (!request.model) return false;
  if (request.authMode === "codex_app_server") return false;
  return Boolean(request.apiBase);
}

function interpretAllow(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function verdictFromObject(value: unknown): WriteGateVerdict | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as { allow?: unknown; reason?: unknown };
  const allow = interpretAllow(record.allow);
  if (allow === undefined) return undefined;
  const reason =
    typeof record.reason === "string" && record.reason.trim()
      ? record.reason.trim()
      : undefined;
  return allow
    ? { kind: "allow", reason }
    : { kind: "refuse", reason: reason || "not covered by the user's request" };
}

/**
 * Every balanced top-level `{...}` span, in order of appearance.
 *
 * A single greedy `\{[\s\S]*\}` spans from the first brace to the last, so a
 * reply that quotes any brace-bearing text around the verdict JSON — and the
 * gate summary for `zotero_script` is 2400 chars of script source, which the
 * judging model routinely quotes back — parsed as one invalid blob and every
 * verdict became "could not interpret". Trying each span separately, latest
 * first (the verdict is the reply's payload, not its preamble), recovers the
 * object even when it is surrounded by prose.
 */
function balancedObjectSpans(raw: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) spans.push(raw.slice(start, index + 1));
    }
  }
  return spans;
}

function logUnparsableVerdict(raw: string): void {
  // Parse failures used to be silent, so a model that never produced strict
  // JSON was indistinguishable from one that was never asked. The log is the
  // only place the raw reply ever surfaces.
  (
    globalThis as typeof globalThis & {
      Zotero?: { debug?: (message: string) => void };
    }
  ).Zotero?.debug?.(
    `[llm-for-zotero] write gate could not parse verdict: ${raw.slice(0, 300)}`,
  );
}

function parseVerdict(raw: string): WriteGateVerdict {
  const spans = balancedObjectSpans(raw);
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    try {
      const verdict = verdictFromObject(JSON.parse(spans[index]));
      if (verdict) return verdict;
    } catch {
      // Not this span; try the next candidate.
    }
  }
  logUnparsableVerdict(raw);
  return {
    kind: "refuse",
    reason: "the gate could not interpret its verdict",
  };
}

export async function judgeIrreversibleWrite(params: {
  request: WriteGateRequest;
  toolName: string;
  operationSummary: string;
  llmCall?: Parameters<typeof callUtilityLLM>[0]["llmCall"];
}): Promise<WriteGateVerdict> {
  const { request } = params;
  if (!canUseWriteGateModel(request)) {
    return {
      kind: "unavailable",
      reason:
        "the write gate needs a model with a direct API base, and none is configured",
    };
  }
  const prompt = [
    "You are the permission gate for an AI agent working inside the user's Zotero library.",
    "The agent wants to perform an IRREVERSIBLE write — one that cannot be undone afterwards.",
    "Decide whether the user's request for this turn justifies this exact operation.",
    "",
    `User request: """${(request.userText || "").slice(0, 2000)}"""`,
    "",
    `Operation: ${params.toolName}`,
    params.operationSummary,
    "",
    'Rules: allow=true only when the operation is clearly part of what the user asked for. When the user did not ask for it, or it is broader than the request, reply allow=false. Reply with ONLY JSON: {"allow": true|false, "reason": "one short sentence"}',
  ].join("\n");

  const result = await callUtilityLLM({
    prompt,
    model: request.model,
    apiBase: request.apiBase,
    apiKey: request.apiKey,
    authMode: request.authMode,
    providerProtocol: request.providerProtocol,
    profileOverride: request.advanced?.profileOverride,
    // Generous on purpose: a reply that hits the cap mid-JSON loses its
    // closing brace and no parser can recover a verdict from it.
    jsonBudget: 256,
    temperature: 0,
    timeoutMs: 15000,
    llmCall: params.llmCall,
  });
  if (!result.ok) {
    logUtilityLLMFailure("Write gate LLM call failed", result);
    return {
      kind: "unavailable",
      reason: `the write gate model call failed (${result.reason})`,
    };
  }
  return parseVerdict(result.text);
}
