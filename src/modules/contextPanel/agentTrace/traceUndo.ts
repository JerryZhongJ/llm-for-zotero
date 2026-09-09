import { config } from "../../../../package.json";
import { listJournalActions } from "../../../agent/store/changeJournal";
import { revertActions } from "../../../agent/services/changeReverter";
import type { AgentToolContext } from "../../../agent/types";

/**
 * Inline undo for a journalled write shown in the conversation trace. The
 * button lives on the tool-activity row; this module performs the actual
 * rollback through the same reverter the revert_changes tool uses.
 */

export type TraceUndoOutcome = {
  ok: boolean;
  message: string;
};

/** Shared trace-side gateway resolver (panel document scope). */
export function resolveZoteroGatewayForTrace(): unknown {
  // `addon` lives on the main window's global; the panel document may have
  // its own scope, so also try the documented Zotero[addonInstance] path.
  // The getter throws while the agent subsystem is still initializing.
  const holders: unknown[] = [
    (globalThis as { addon?: unknown }).addon,
    (globalThis as { Zotero?: Record<string, unknown> }).Zotero?.[
      config.addonInstance
    ] ?? {},
  ];
  for (const holder of holders) {
    try {
      const gateway = (
        holder as {
          api?: { agent?: { getZoteroGateway?: () => unknown } };
        }
      )?.api?.agent?.getZoteroGateway?.();
      if (gateway) return gateway;
    } catch {
      // subsystem not ready on this holder; try the next one
    }
  }
  return null;
}

export async function undoTraceAction(
  actionId: string,
): Promise<TraceUndoOutcome> {
  const debug = (
    globalThis as typeof globalThis & {
      Zotero?: { debug?: (message: string) => void };
    }
  ).Zotero?.debug;
  debug?.(`[llm-for-zotero] trace undo requested: ${actionId}`);
  const gateway = resolveZoteroGatewayForTrace();
  if (!gateway) {
    debug?.("[llm-for-zotero] trace undo: no Zotero gateway resolved");
    return { ok: false, message: "Undo is unavailable (no Zotero gateway)." };
  }
  let actions: Awaited<ReturnType<typeof listJournalActions>> = [];
  try {
    actions = await listJournalActions({ actionId });
  } catch (error) {
    debug?.(
      `[llm-for-zotero] trace undo: journal lookup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: false, message: "The change journal is unavailable." };
  }
  const action = actions[0];
  if (!action) {
    return { ok: false, message: "This change is no longer in the journal." };
  }
  if (action.status === "reverted" || action.status === "no_effect") {
    return { ok: true, message: "Already undone." };
  }
  if (action.reversibility === "none") {
    return {
      ok: false,
      message: action.recovery || "This change cannot be undone.",
    };
  }
  const context = {
    request: {
      conversationKey: action.conversationKey,
    },
    item: null,
    currentAnswerText: "",
    modelName: "ui",
  } as unknown as AgentToolContext;
  const outcome = await revertActions({
    actions: [action],
    zoteroGateway: gateway as never,
    context,
  });
  if (
    outcome.skipped.length &&
    !outcome.reverted &&
    !outcome.partiallyReverted
  ) {
    return {
      ok: false,
      message: outcome.skipped[0]?.reason || "This change cannot be undone.",
    };
  }
  return {
    ok: true,
    message:
      outcome.partiallyReverted > 0 || outcome.residuals.length
        ? "Undone with residuals — some effects may remain."
        : "Undone.",
  };
}
