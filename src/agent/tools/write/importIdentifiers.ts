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
import {
  ok,
  fail,
  validateObject,
  normalizePositiveInt,
  normalizeStringArray,
} from "../shared";
import {
  executeAndRecordUndo,
  normalizeChecklistSelectionFromResolution,
  planLibraryMutations,
} from "./mutateLibraryShared";

const IDENTIFIERS_CHECKLIST_FIELD_ID = "identifiersChecklist";

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
        "Import ONE paper into Zotero by DOI, ISBN, arXiv ID, or URL. One call per paper: each import is its own journalled action with its own undo.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["identifier"],
        properties: {
          identifier: {
            type: "string",
            description: "DOI, ISBN, arXiv ID, or URL of the paper to import.",
          },
          targetCollectionId: {
            type: "number",
            description: "Collection to add imported items to.",
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
        onSuccess: ({ content }) => {
          const result =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const resultInner =
            result.result && typeof result.result === "object"
              ? (result.result as Record<string, unknown>)
              : {};
          const count = Number(
            resultInner.importedCount || result.importedCount || 0,
          );
          return count > 0
            ? `Imported ${count} paper${count === 1 ? "" : "s"}`
            : "Papers imported";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object with identifiers. Example: { identifiers: ["10.1234/example"] }',
        );
      }

      const identifier =
        typeof args.identifier === "string" && args.identifier.trim()
          ? args.identifier.trim()
          : Array.isArray(args.identifiers) &&
              typeof args.identifiers[0] === "string"
            ? args.identifiers[0].trim()
            : "";
      if (!identifier) {
        return fail(
          'identifier is required. Example: { identifier: "10.1234/example" }',
        );
      }

      const operation: ImportIdentifiersOperation = {
        type: "import_identifiers",
        identifiers: [identifier],
        targetCollectionId:
          normalizePositiveInt(args.targetCollectionId) ||
          normalizePositiveInt(args.collectionId),
        libraryID: normalizePositiveInt(args.libraryID),
      };

      return ok({ operation });
    },

    createPendingAction(input) {
      const operation = input.operation;
      const identifier = operation.identifiers[0] || "";
      const collection = operation.targetCollectionId
        ? zoteroGateway.getCollectionSummary(operation.targetCollectionId)
        : null;
      const collectionLabel = collection
        ? collection.path || collection.name
        : null;
      const description = collectionLabel
        ? `Import into "${collectionLabel}".`
        : `Import into the library.`;

      return {
        toolName: "import_identifiers",
        title: "Import papers",
        description,
        confirmLabel: "Import",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "checklist" as const,
            id: IDENTIFIERS_CHECKLIST_FIELD_ID,
            label: "Identifier to import",
            items: [{ id: "0", label: identifier, checked: true }],
          },
        ],
      };
    },

    applyConfirmation(input, resolutionData) {
      const selected = normalizeChecklistSelectionFromResolution(
        resolutionData,
        IDENTIFIERS_CHECKLIST_FIELD_ID,
      );
      // No resolution — auto_approve / non-HITL path.
      if (selected === undefined) {
        return ok(input);
      }
      if (!selected.length) {
        return fail(
          "No identifiers were left checked, so nothing was imported. Check the identifiers you want to import, or cancel the operation.",
        );
      }
      // Row ids are indices into operation.identifiers, so "0" is a valid id.
      const chosen = new Set(selected);
      const identifiers = input.operation.identifiers.filter((_, index) =>
        chosen.has(String(index)),
      );
      if (!identifiers.length) {
        return fail(
          "The confirmed selection did not match any of the identifiers in this request. Nothing was imported.",
        );
      }
      return ok({
        ...input,
        operation: { ...input.operation, identifiers },
      });
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
