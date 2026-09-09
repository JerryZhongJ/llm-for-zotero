import type { LibraryMutationOperation } from "../services/libraryMutation/contracts";

export type AgentActionCapability =
  | "zotero.read"
  | "zotero.tags"
  | "zotero.metadata"
  | "zotero.collections"
  | "zotero.notes"
  | "zotero.import"
  | "zotero.trash"
  | "zotero.attachments"
  | "zotero.annotations"
  | "zotero.settings"
  | "zotero.undo"
  | "file.write"
  | "command.execute"
  | "zotero.script";

export type AgentActionProofDomain =
  | "zotero_state"
  | "file_state"
  | "execution";

export type AgentActionOperation =
  | LibraryMutationOperation["type"]
  | "note_create"
  | "note_edit"
  | "note_append"
  | "annotation_write"
  | "settings_update"
  | "undo"
  | "revert"
  | "file_write"
  | "command_execute"
  | "zotero_script_execute"
  | "read_full";

/** Meaning-changing values shared by intent, proposal, and receipt. */
export type AgentActionParameters = {
  semanticAction?:
    | "add"
    | "remove"
    | "rename"
    | "merge"
    | "delete"
    | "setColor";
  tags?: string[];
  metadataFields?: string[];
  tag?: string;
  newTag?: string;
  collectionName?: string;
  collectionId?: number;
  collectionIds?: number[];
  savedSearchId?: number;
  savedSearchName?: string;
  sourceCollectionId?: number | "all";
  destinationCollectionId?: number;
  parentCollectionId?: number | null;
  noteMode?: "create" | "edit" | "append";
  targetNoteId?: number;
  targetItemId?: number;
  pageIndex?: number;
  revertCount?: number;
  expectedText?: string;
  newName?: string;
  newPath?: string;
  identifiers?: string[];
  filePaths?: string[];
  parentItemIds?: Array<number | null>;
  deleteItems?: boolean;
  permanent?: boolean;
  filePath?: string;
  contentHash?: string;
  commandFingerprint?: string;
  settingsKey?: string;
  settingsValue?: string;
};

export type AgentActionIntent = {
  capability: AgentActionCapability;
  operation: AgentActionOperation;
  proofDomain: AgentActionProofDomain;
  coverage: "one" | "some" | "all";
  targetKind: "papers" | "items";
  parameters?: AgentActionParameters;
  scope?: {
    kind: "collection";
    path?: string;
    includeDescendants: boolean;
  };
  scopeRole?: "source" | "destination";
  constraints?: {
    tagPrefix?: string;
    readMode?: "full";
    collectionMode?: "move";
  };
};
