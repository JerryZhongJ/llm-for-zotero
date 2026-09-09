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

function parseVerdict(raw: string): WriteGateVerdict {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as {
        allow?: unknown;
        reason?: unknown;
      };
      const reason =
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim()
          : undefined;
      if (parsed.allow === true) return { kind: "allow", reason };
      if (parsed.allow === false)
        return {
          kind: "refuse",
          reason: reason || "not covered by the user's request",
        };
    } catch {
      // fall through to the conservative refusal below
    }
  }
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
    jsonBudget: 120,
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
