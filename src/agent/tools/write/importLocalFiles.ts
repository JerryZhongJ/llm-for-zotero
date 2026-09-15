/**
 * Tool for importing local files (PDFs, etc.) into the Zotero library.
 * PDFs go through Zotero's metadata recognition; bibliography files (.ris,
 * .bib, .enw, .nbib, RDF) are read through Zotero's translators rather than
 * attached, which is what "import my references" means.
 */
import type { AgentWriteToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type ImportLocalFilesOperation,
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
  planLibraryMutations,
} from "./mutateLibraryShared";

type ImportLocalFilesInput = {
  operation: ImportLocalFilesOperation;
};

export function createImportLocalFilesTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<ImportLocalFilesInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "import_local_files",
      description:
        "Import ONE local file from the filesystem into Zotero per call — each import is its own journalled action with its own undo. To import several files, make one call per file in the same reply; they share a single batch confirmation. A bibliography file (.ris, .bib, .enw, .nbib, RDF) is read through Zotero's translators, so its references become real items; other files are attached, and PDFs go through Zotero's metadata recognition so they arrive with a title, authors and DOI rather than as a bare file.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["filePath"],
        properties: {
          filePath: {
            type: "string",
            description:
              "Absolute path of the ONE file to import (e.g. '/Users/me/Desktop/paper.pdf' or 'C:\\\\Users\\\\me\\\\Desktop\\\\paper.pdf').",
          },
          mode: {
            type: "string",
            enum: ["auto", "translate", "attach"],
            default: "auto",
            description:
              "'auto' (default) reads bibliography files as references and attaches everything else. 'translate' insists on reading the file as a bibliography and fails if Zotero has no translator for it. 'attach' stores the file as an attachment even if it is a bibliography.",
          },
          recognize: {
            type: "boolean",
            default: true,
            description:
              "Run Zotero's metadata lookup on imported PDFs, so they arrive as a proper item rather than a bare file. Set false to skip it.",
          },
          targetCollectionId: {
            type: "number",
            description: "Optional collection ID to add imported items to.",
          },
          libraryID: {
            type: "number",
            description:
              "Target library ID. Defaults to the user's personal library.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    guidance: {
      matches: (request) =>
        /\b(import.*file|import.*pdf|import.*from.*(desktop|download|folder|directory|disk)|local.*file|add.*file.*library)\b/i.test(
          request.userText || "",
        ),
      instruction:
        "Use import_local_files to import local files (PDFs, etc.) from the user's filesystem into Zotero. " +
        "First use run_command to list files (for example `dir %USERPROFILE%\\\\Desktop\\\\*.pdf` on Windows or `ls ~/Desktop/*.pdf` on macOS/Linux) to discover file paths, then call import_local_files once per file — each call is its own journalled action with its own undo, and multiple calls in one reply share a single batch confirmation. " +
        "A bibliography file (.ris, .bib, .enw, .nbib, RDF) has its references imported as items; other files are attached. PDFs go through metadata recognition. " +
        "Optionally specify a targetCollectionId to organize imported items into a collection.",
    },

    presentation: {
      label: "Import Local Files",
      summaries: {
        onCall: ({ args }) => {
          const a =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};
          const path =
            typeof a.filePath === "string"
              ? a.filePath
              : Array.isArray(a.filePaths) && typeof a.filePaths[0] === "string"
                ? a.filePaths[0]
                : "";
          const name = path.split(/[\\/]/).pop() || path;
          return name ? `Preparing to import ${name}` : "Preparing to import";
        },
        onPending: "Waiting for confirmation to import files",
        onApproved: "Importing files",
        onDenied: "Import cancelled",
        // The singular outcome object: one status, the produced items as a
        // list (a bibliography file can legitimately contain several
        // references).
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
              ? "Imported 1 item"
              : `Imported ${produced} items`;
          }
          if (outcome?.status === "not_found") {
            return "Not imported — file not found";
          }
          if (outcome?.status) {
            return `Not imported — ${
              typeof outcome.reason === "string" && outcome.reason.trim()
                ? outcome.reason.trim()
                : "file failed to import"
            }`;
          }
          return "Import finished";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with filePath");
      }
      // Legacy plural input still resolves to its first entry so an old
      // transcript or hand-written call keeps working.
      const filePath =
        typeof args.filePath === "string" && args.filePath.trim()
          ? args.filePath.trim()
          : normalizeStringArray(args.filePaths)?.[0];
      if (!filePath) {
        return fail(
          "filePath must be the absolute path of the ONE file to import, e.g. '/Users/me/Desktop/paper.pdf' or 'C:\\Users\\me\\Desktop\\paper.pdf'",
        );
      }
      const operation: ImportLocalFilesOperation = {
        type: "import_local_files",
        filePath,
        targetCollectionId: normalizePositiveInt(args.targetCollectionId),
        libraryID: normalizePositiveInt(args.libraryID),
        mode:
          args.mode === "translate" || args.mode === "attach"
            ? args.mode
            : undefined,
        recognize: args.recognize === false ? false : undefined,
      };
      return ok<ImportLocalFilesInput>({ operation });
    },

    createPendingAction(input) {
      const { operation } = input;
      const path = operation.filePath || "";
      const fileName = path.split(/[\\/]/).pop() || path;

      return {
        toolName: "import_local_files",
        title: `Import ${fileName || "file"}`,
        description:
          "Import this local file into your Zotero library. Bibliography files (.ris, .bib, .enw, .nbib, RDF) have their references imported as items; other files are attached, and Zotero looks up metadata for PDFs.",
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
        "import_local_files",
      );
    },
  };
}
