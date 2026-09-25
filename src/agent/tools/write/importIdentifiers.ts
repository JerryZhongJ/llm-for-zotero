/**
 * Focused facade tool for importing papers into Zotero by DOI, ISBN, arXiv ID, or URL.
 * Provides a self-describing schema for importing papers by identifier.
 */
import type { AgentWriteToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type ImportIdentifiersOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import {
  executeAndRecordUndo,
  planLibraryMutations,
} from "./mutateLibraryShared";

type ImportIdentifiersInput = {
  operation: ImportIdentifiersOperation;
};

export function createImportIdentifiersTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<ImportIdentifiersInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "import_identifiers",
      description:
        "Import ONE paper into Zotero by DOI, ISBN, arXiv ID, or URL. One call per paper: each import is its own journalled action with its own undo. After the import returns, a background pass automatically tries to fetch the PDF (open-access sources, then publisher resolvers) — it lands as an attachment later, and a popup reports the outcome; do not wait for it or report PDF status in your answer.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["identifier", "targetCollectionId"],
        properties: {
          identifier: {
            type: "string",
            description: "DOI, ISBN, arXiv ID, or URL of the paper to import.",
          },
          targetCollectionId: {
            type: "number",
            description:
              "Required. Destination collection for the imported item — every import names its destination explicitly. The collection currently open in the Zotero pane is listed in the turn context as 'ambient context (current collection)'; use its collectionId unless the user asks for another destination.",
          },
          libraryID: {
            type: "number",
            description: "Library ID (for group libraries).",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Import Papers",
      summaries: {
        onCall: "Preparing paper import",
        onPending: "Waiting for confirmation to import papers",
        onApproved: "Importing papers",
        onDenied: "Paper import cancelled",
        // The singular outcome object: one status, the produced items as a
        // list (a URL identifier can legitimately resolve to several).
        onSuccess: ({ content }) => {
          const outer =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const outcome =
            outer.result && typeof outer.result === "object"
              ? (outer.result as {
                  status?: unknown;
                  items?: unknown;
                  reason?: unknown;
                })
              : null;
          const produced = Array.isArray(outcome?.items)
            ? outcome.items.length
            : 0;
          if (outcome?.status === "imported") {
            return produced === 1
              ? "Imported 1 paper · PDF fetch runs in background"
              : `Imported ${produced} papers · PDF fetch runs in background`;
          }
          if (outcome?.status === "not_found") {
            return `Not imported — identifier not found${
              typeof outcome.reason === "string" && outcome.reason.trim()
                ? ` (${outcome.reason.trim()})`
                : ""
            }`;
          }
          if (outcome?.status) {
            return `Not imported — ${
              typeof outcome.reason === "string" && outcome.reason.trim()
                ? outcome.reason.trim()
                : "import failed"
            }`;
          }
          return "Import finished";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object with identifier. Example: { identifier: "10.1234/example" }',
        );
      }

      // Legacy plural input (from old transcripts) still resolves to its
      // first entry so a hand-written call keeps working.
      const identifier =
        typeof args.identifier === "string" && args.identifier.trim()
          ? args.identifier.trim()
          : Array.isArray(args.identifiers) &&
              typeof args.identifiers[0] === "string"
            ? args.identifiers[0].trim()
            : "";
      if (!identifier) {
        return fail(
          'identifier is required. Example: { identifier: "10.1234/example", targetCollectionId: 5 }',
        );
      }

      // Destination is deliberately never defaulted: an import that silently
      // lands in the library root is almost never what the user meant. The
      // model must name the collection — the one currently open is in the
      // turn context — so the confirmation card states a real destination.
      if (
        !normalizePositiveInt(args.targetCollectionId) &&
        !normalizePositiveInt(args.collectionId)
      ) {
        return fail(
          "targetCollectionId is required: every import names its destination collection. The collection currently open in the Zotero pane appears in the turn context as 'ambient context (current collection)' — use its collectionId unless the user asks for another destination; ask the user when no collection is open.",
        );
      }

      const operation: ImportIdentifiersOperation = {
        type: "import_identifiers",
        identifier,
        targetCollectionId:
          normalizePositiveInt(args.targetCollectionId) ||
          normalizePositiveInt(args.collectionId),
        libraryID: normalizePositiveInt(args.libraryID),
      };

      return ok({ operation });
    },

    createPendingAction(input) {
      const operation = input.operation;
      const collection = operation.targetCollectionId
        ? zoteroGateway.getCollectionSummary(operation.targetCollectionId)
        : null;
      const collectionLabel = collection
        ? collection.path || collection.name
        : null;
      const description = collectionLabel
        ? `Import into "${collectionLabel}".`
        : `Import into the library.`;

      // One paper per call — a plain confirmation card; the checklist this
      // tool used to show existed only to filter a batch that can no longer
      // arrive.
      return {
        toolName: "import_identifiers",
        title: "Import paper",
        description: `${description} Identifier: ${operation.identifier}`,
        confirmLabel: "Import",
        cancelLabel: "Cancel",
        fields: [],
      };
    },

    planMutation: (input, context) =>
      planLibraryMutations(mutationService, [input.operation], context),

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "import_identifiers",
      );
    },
  };
}
