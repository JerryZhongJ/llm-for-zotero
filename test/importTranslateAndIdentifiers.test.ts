import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import {
  resetPdfResolverThrottlesForTests,
} from "../src/agent/services/publisherPdfResolver";
import { setBuiltinPdfLookupTimeoutForTests } from "../src/agent/services/zoteroGateway";

/**
 * Handing `library_import kind:'files'` a `.ris` called
 * `Zotero.Attachments.importFromFile`, so the library gained **one dead
 * attachment row named refs.ris** and the tool reported "Imported 1 file".
 * Not a single reference arrived. Metadata retrieval never ran for any file
 * either, PDFs included, though four places promised it.
 *
 * Identifier parsing was hand-rolled into four branches with an
 * assume-DOI fallback, so a bare arXiv ID — the form a literature search most
 * often produces — became a DOI and failed.
 */
describe("import translation and identifier parsing", function () {
  let translated: Array<{ location: unknown; options: unknown }>;
  let attached: string[];
  let recognized: unknown[][];
  let translatorsAvailable: boolean;

  function install(overrides: Record<string, unknown> = {}) {
    translated = [];
    attached = [];
    recognized = [];
    translatorsAvailable = true;

    class FakeImport {
      private location: unknown;
      setLocation(file: unknown) {
        this.location = file;
      }
      async getTranslators() {
        return translatorsAvailable ? [{ label: "RIS" }] : [];
      }
      setTranslator() {}
      async translate(options: unknown) {
        translated.push({ location: this.location, options });
        return [{ id: 11 }, { id: 12 }];
      }
    }

    (globalThis as Record<string, unknown>).Zotero = {
      Translate: { Import: FakeImport },
      Attachments: {
        importFromFile: async ({ file }: { file: unknown }) => {
          attached.push(String(file));
          return {
            id: 77,
            parentID: false,
            getField: () => "",
            attachmentFilename: "paper.pdf",
            isPDFAttachment: () => true,
            addToCollection: () => undefined,
            saveTx: async () => undefined,
          };
        },
      },
      RecognizeDocument: {
        recognizeItems: async (items: unknown[]) => {
          recognized.push(items);
        },
      },
      Items: { get: () => null },
      Collections: { get: () => null },
      Libraries: { userLibraryID: 1 },
      Utilities: {
        extractIdentifiers: (text: string) => {
          // Zotero's real parser handles all of these.
          if (/^\d{4}\.\d{4,5}$/.test(text)) return [{ arXiv: text }];
          if (/^\d{8,9}$/.test(text)) return [{ PMID: text }];
          if (/^\d{4}[A-Za-z].{14}$/.test(text)) return [{ adsBibcode: text }];
          if (/10\.\d{4,}\//.test(text)) {
            const m = text.match(/10\.\d{4,}\/\S+/);
            return m ? [{ DOI: m[0] }] : [];
          }
          return [];
        },
      },
      debug: () => undefined,
      ...overrides,
    };
  }

  afterEach(function () {
    delete (globalThis as Record<string, unknown>).Zotero;
  });

  function gateway() {
    const g = new ZoteroGateway();
    (g as unknown as { getItem: () => unknown }).getItem = () => null;
    (g as unknown as { getCollection: () => unknown }).getCollection = () =>
      null;
    return g;
  }

  describe("bibliography files", function () {
    it("reads a .ris through the translators instead of attaching it", async function () {
      install();
      const result = await gateway().importOneLocalFile({
        filePath: "/Users/me/Downloads/refs.ris",
        libraryID: 1,
      });

      assert.equal(result.status, "imported");
      // One .ris carrying two references: one outcome, two produced items.
      assert.lengthOf(result.items, 2);
      assert.lengthOf(translated, 1, "the file must be translated");
      assert.deepEqual(attached, [], "and never attached");
      assert.include(result.items[0].title || "", "2 references");
    });

    it("files the imported references into the target collection", async function () {
      install();
      const g = gateway();
      (
        g as unknown as { getCollection: (id: number) => unknown }
      ).getCollection = (id: number) => ({ id, libraryID: 1, name: "Refs" });

      await g.importOneLocalFile({
        filePath: "/tmp/refs.bib",
        libraryID: 1,
        targetCollectionId: 42,
      });
      assert.deepEqual(
        (translated[0].options as { collections: number[] }).collections,
        [42],
      );
    });

    it("falls back to attaching when no translator recognises the file", async function () {
      install();
      translatorsAvailable = false;
      const result = await gateway().importOneLocalFile({
        filePath: "/tmp/notes.txt",
        libraryID: 1,
      });
      assert.equal(result.status, "imported");
      assert.lengthOf(result.items, 1);
      assert.lengthOf(attached, 1);
    });

    it("fails rather than attaching when translation was demanded", async function () {
      install();
      translatorsAvailable = false;
      const result = await gateway().importOneLocalFile({
        filePath: "/tmp/notes.txt",
        libraryID: 1,
        mode: "translate",
      });
      // Silently attaching would answer a different question than the one
      // asked.
      assert.equal(result.status, "error");
      assert.deepEqual(attached, []);
    });

    it("attaches a bibliography file when explicitly told to", async function () {
      install();
      await gateway().importOneLocalFile({
        filePath: "/tmp/refs.ris",
        libraryID: 1,
        mode: "attach",
      });
      assert.lengthOf(attached, 1);
      assert.deepEqual(translated, []);
    });
  });

  describe("PDF metadata recognition", function () {
    it("runs the lookup that four descriptions promised", async function () {
      install();
      await gateway().importOneLocalFile({
        filePath: "/tmp/paper.pdf",
        libraryID: 1,
      });
      assert.lengthOf(recognized, 1);
    });

    it("can be turned off", async function () {
      install();
      await gateway().importOneLocalFile({
        filePath: "/tmp/paper.pdf",
        libraryID: 1,
        recognize: false,
      });
      assert.deepEqual(recognized, []);
    });

    it("still imports when the lookup fails", async function () {
      install({
        RecognizeDocument: {
          recognizeItems: async () => {
            throw new Error("offline");
          },
        },
      });
      const result = await gateway().importOneLocalFile({
        filePath: "/tmp/paper.pdf",
        libraryID: 1,
      });
      assert.equal(result.status, "imported");
      assert.lengthOf(result.items, 1);
    });
  });

  describe("identifiers", function () {
    function parse(gw: ZoteroGateway, raw: string) {
      return (
        gw as unknown as {
          parseImportIdentifier: (raw: string) => Record<string, string>;
        }
      ).parseImportIdentifier(raw);
    }

    it("recognises a bare arXiv ID, which used to become a DOI", function () {
      install();
      // The form a literature search most often produces.
      assert.deepEqual(parse(gateway(), "2301.00001"), { arXiv: "2301.00001" });
    });

    it("recognises a bare PMID, which used to become a DOI", function () {
      install();
      assert.deepEqual(parse(gateway(), "12345678"), { PMID: "12345678" });
    });

    it("still handles a DOI embedded in a URL", function () {
      install();
      assert.deepEqual(
        parse(
          gateway(),
          "https://link.springer.com/article/10.1007/s00221-021-06062-3",
        ),
        { DOI: "10.1007/s00221-021-06062-3" },
      );
    });

    it("explains that a page URL is not importable", function () {
      install();
      const reason = (
        gateway() as unknown as {
          describeUnresolvableIdentifier: (raw: string) => string | null;
        }
      ).describeUnresolvableIdentifier("https://arxiv.org/abs/2301.00001");
      // "No translator could resolve this identifier" told the user nothing
      // they could act on.
      assert.include(reason || "", "page URL");
      assert.include(reason || "", "arXiv ID");
    });

    it("says nothing for a URL that does carry a DOI", function () {
      install();
      const reason = (
        gateway() as unknown as {
          describeUnresolvableIdentifier: (raw: string) => string | null;
        }
      ).describeUnresolvableIdentifier(
        "https://link.springer.com/article/10.1007/s00221-021-06062-3",
      );
      assert.isNull(reason);
    });
  });
});

describe("PDF fetch after identifier import", function () {
  function installSearchTranslate(
    itemsByZoteroId: Record<number, Record<string, unknown>>,
    overrides: Record<string, unknown> = {},
  ) {
    class FakeSearch {
      setIdentifier() {}
      async getTranslators() {
        return [{}];
      }
      setTranslator() {}
      async translate() {
        return [{ id: 11 }];
      }
    }
    (globalThis as Record<string, unknown>).Zotero = {
      Translate: { Search: FakeSearch },
      Items: {
        get: (id: number) => itemsByZoteroId[id] ?? null,
      },
      Collections: { get: () => null },
      Libraries: { userLibraryID: 1 },
      debug: () => undefined,
      ...overrides,
    };
  }

  afterEach(function () {
    delete (globalThis as Record<string, unknown>).Zotero;
  });

  it("asks Zotero's find-PDF machinery for imported items without a PDF", async function () {
    const findCalls: number[] = [];
    installSearchTranslate(
      {
        11: {
          id: 11,
          isRegularItem: () => true,
          isAttachment: () => false,
          getAttachments: () => [],
        },
      },
      {
        Attachments: {
          addAvailableFile: async (item: { id: number }) => {
            findCalls.push(item.id);
            return { id: 500 };
          },
        },
      },
    );

    const gateway = new ZoteroGateway();
    const result = await gateway.importOnePaperByIdentifier("10.1000/example");
    await gateway.waitForPdfFetches();

    assert.equal(result.status, "imported");
    assert.lengthOf(result.items, 1);
    assert.deepEqual(findCalls, [11]);
  });

  it("skips items that already have a PDF attachment", async function () {
    const findCalls: number[] = [];
    installSearchTranslate(
      {
        11: {
          id: 11,
          isRegularItem: () => true,
          isAttachment: () => false,
          getAttachments: () => [21],
        },
        21: {
          id: 21,
          isRegularItem: () => false,
          isAttachment: () => true,
          attachmentContentType: "application/pdf",
          attachmentFilename: "paper.pdf",
        },
      },
      {
        Attachments: {
          addAvailableFile: async (item: { id: number }) => {
            findCalls.push(item.id);
            return { id: 500 };
          },
        },
      },
    );

    const gateway = new ZoteroGateway();
    const result = await gateway.importOnePaperByIdentifier("10.1000/example");
    await gateway.waitForPdfFetches();

    assert.equal(result.status, "imported");
    assert.lengthOf(result.items, 1);
    assert.deepEqual(findCalls, []);
  });

  it("survives a failed PDF lookup without failing the import", async function () {
    installSearchTranslate(
      {
        11: {
          id: 11,
          isRegularItem: () => true,
          isAttachment: () => false,
          getAttachments: () => [],
        },
      },
      {
        Attachments: {
          addAvailableFile: async () => {
            throw new Error("offline");
          },
        },
      },
    );

    const gateway = new ZoteroGateway();
    const result = await gateway.importOnePaperByIdentifier("10.1000/example");
    await gateway.waitForPdfFetches();

    assert.equal(result.status, "imported");
    assert.lengthOf(result.items, 1);
  });

  it("falls back to the publisher resolvers when the built-in lookup finds nothing", async function () {
    const imported: Array<Record<string, unknown>> = [];
    installSearchTranslate(
      {
        11: {
          id: 11,
          isRegularItem: () => true,
          isAttachment: () => false,
          getAttachments: () => [],
          getField: (name: string) =>
            name === "DOI" ? "10.1145/3442188.3445922" : "",
        },
      },
      {
        Attachments: {
          addAvailableFile: async () => false,
          importFromFile: async (options: Record<string, unknown>) => {
            imported.push(options);
            return { id: 900 };
          },
        },
        File: { pathToFile: (path: string) => ({ path }) },
        getTempDirectory: () => ({ path: "/tmp" }),
        HTTP: {
          request: async () => ({
            status: 200,
            response: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1]).buffer,
          }),
        },
      },
    );
    resetPdfResolverThrottlesForTests();

    const gateway = new ZoteroGateway();
    const result = await gateway.importOnePaperByIdentifier(
      "10.1145/3442188.3445922",
    );
    await gateway.waitForPdfFetches();

    assert.equal(result.status, "imported");
    assert.lengthOf(imported, 1, "publisher chain must attach the PDF");
    assert.equal(imported[0].parentItemID, 11);
    assert.equal(imported[0].contentType, "application/pdf");
  });

  it("gives up on a hung built-in lookup and falls through to the publisher chain", async function () {
    const imported: Array<Record<string, unknown>> = [];
    installSearchTranslate(
      {
        11: {
          id: 11,
          isRegularItem: () => true,
          isAttachment: () => false,
          getAttachments: () => [],
          getField: (name: string) =>
            name === "DOI" ? "10.1145/3442188.3445922" : "",
        },
      },
      {
        Attachments: {
          // Never settles — mirrors the IEEE/F5 anti-bot hang.
          addAvailableFile: () => new Promise(() => undefined),
          importFromFile: async (options: Record<string, unknown>) => {
            imported.push(options);
            return { id: 900 };
          },
        },
        File: { pathToFile: (path: string) => ({ path }) },
        getTempDirectory: () => ({ path: "/tmp" }),
        HTTP: {
          request: async () => ({
            status: 200,
            response: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1]).buffer,
          }),
        },
      },
    );
    resetPdfResolverThrottlesForTests();
    setBuiltinPdfLookupTimeoutForTests(10);

    const gateway = new ZoteroGateway();
    const result = await gateway.importOnePaperByIdentifier(
      "10.1145/3442188.3445922",
    );
    await gateway.waitForPdfFetches();
    setBuiltinPdfLookupTimeoutForTests(60_000);

    assert.equal(result.status, "imported");
    assert.lengthOf(imported, 1, "publisher chain must get its turn");
  });

  it("does not touch the publisher chain when the built-in lookup already attached a PDF", async function () {
    const httpRequestUrls: string[] = [];
    installSearchTranslate(
      {
        11: {
          id: 11,
          isRegularItem: () => true,
          isAttachment: () => false,
          getAttachments: () => [],
          getField: (name: string) =>
            name === "DOI" ? "10.1145/3442188.3445922" : "",
        },
      },
      {
        Attachments: {
          addAvailableFile: async () => ({ id: 500 }),
        },
        HTTP: {
          request: async (_method: string, url: string) => {
            httpRequestUrls.push(url);
            throw new Error("no download expected");
          },
        },
      },
    );
    resetPdfResolverThrottlesForTests();

    const gateway = new ZoteroGateway();
    const result = await gateway.importOnePaperByIdentifier(
      "10.1145/3442188.3445922",
    );
    await gateway.waitForPdfFetches();

    assert.equal(result.status, "imported");
    assert.deepEqual(
      httpRequestUrls,
      [],
      "built-in success must short-circuit the publisher chain",
    );
  });
});

/**
 * `note_write mode:'edit'` resolved only the note the user happened to have
 * open, and `validate()` stripped `targetNoteId` for every mode except
 * append — so "fix the typo in the note on paper X" was unreachable unless
 * they opened it first, even though the parameter already existed.
 */
describe("editing a note by id", function () {
  afterEach(function () {
    delete (globalThis as Record<string, unknown>).Zotero;
  });

  function install(notes: Record<number, string>) {
    (globalThis as Record<string, unknown>).Zotero = {
      Items: {
        get: (id: number) =>
          notes[id] !== undefined
            ? {
                id,
                isNote: () => true,
                getNote: () => notes[id],
                getNoteTitle: () => "Note",
                getDisplayTitle: () => "Note",
              }
            : null,
      },
      debug: () => undefined,
    };
  }

  it("resolves the named note rather than the open one", function () {
    install({ 5: "<p>open note</p>", 9: "<p>other note</p>" });
    const g = new ZoteroGateway();
    const resolved = g.resolveActiveNoteItem({
      request: { activeNoteContext: { noteId: 5 } } as never,
      noteId: 9,
    });
    assert.equal(resolved?.id, 9);
  });

  it("falls back to the open note when no id is given", function () {
    install({ 5: "<p>open note</p>" });
    const g = new ZoteroGateway();
    const resolved = g.resolveActiveNoteItem({
      request: { activeNoteContext: { noteId: 5 } } as never,
    });
    assert.equal(resolved?.id, 5);
  });

  it("returns nothing for a bad id instead of editing the open note", function () {
    install({ 5: "<p>open note</p>" });
    const g = new ZoteroGateway();
    // Silently editing whatever was open would rewrite the wrong note.
    const resolved = g.resolveActiveNoteItem({
      request: { activeNoteContext: { noteId: 5 } } as never,
      noteId: 404,
    });
    assert.isNull(resolved);
  });
});
