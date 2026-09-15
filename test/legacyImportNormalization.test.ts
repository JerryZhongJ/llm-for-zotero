import { assert } from "chai";
import { describe, it } from "mocha";

import {
  normalizeLegacyImportOperation,
  type LibraryMutationOperation,
} from "../src/agent/services/libraryMutation/contracts";
import {
  atomizeMutationOperationFromHandler,
  mutationTargetCountFromHandler,
} from "../src/agent/services/libraryMutation/handlerOperations";

describe("legacy import operation normalization (journal history)", function () {
  it("converts array-form journal operations to the singular contract", function () {
    const legacyIdentifiers = {
      type: "import_identifiers",
      identifiers: ["10.1/a", "10.1/b"],
    } as unknown as LibraryMutationOperation;
    const normalizedIdentifiers =
      normalizeLegacyImportOperation(legacyIdentifiers);
    assert.equal(normalizedIdentifiers.type, "import_identifiers");
    assert.equal(
      (normalizedIdentifiers as { identifier?: string }).identifier,
      "10.1/a",
    );

    const legacyFiles = {
      type: "import_local_files",
      filePaths: ["/tmp/a.pdf", "/tmp/b.pdf"],
    } as unknown as LibraryMutationOperation;
    const normalizedFiles = normalizeLegacyImportOperation(legacyFiles);
    assert.equal(normalizedFiles.type, "import_local_files");
    assert.equal(
      (normalizedFiles as { filePath?: string }).filePath,
      "/tmp/a.pdf",
    );
  });

  it("passes singular operations through unchanged", function () {
    const singular = {
      type: "import_identifiers",
      identifier: "10.1/a",
    } as LibraryMutationOperation;
    assert.deepEqual(normalizeLegacyImportOperation(singular), singular);
  });

  it("lets the handler chain consume legacy journal operations", function () {
    // The dispatch entry points normalize before any handler sees the
    // operation, so an undo journal persisted before the refactor still
    // replays: atomize yields one operation and the target count is 1.
    const legacy = {
      type: "import_local_files",
      filePaths: ["/tmp/a.pdf"],
    } as unknown as LibraryMutationOperation;
    const atomized = atomizeMutationOperationFromHandler(legacy);
    assert.lengthOf(atomized, 1);
    assert.equal((atomized[0] as { filePath?: string }).filePath, "/tmp/a.pdf");
    assert.equal(mutationTargetCountFromHandler(legacy), 1);
  });
});
