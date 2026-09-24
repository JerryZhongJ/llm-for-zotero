import { assert } from "chai";
import { buildOutlineSectionIndex } from "../src/modules/contextPanel/pdfOutlineSections";

function buildSyntheticPaper(): {
  sourceText: string;
  pageChars: number[];
} {
  const pages = [
    "Title\nAuthors\nABSTRACT\nTo avoid the exposure of source code.\nMore abstract text.\n1 INTRODUCTION\nSource code minification is common.\nIntro continues.",
    "2 MOTIVATING EXAMPLE\nConsider the following snippet.\nExample discussion.",
    "3 APPROACH OVERVIEW\nThe pipeline has two stages.\nOverview continues.",
  ];
  const sourceText = pages.join("\n");
  // +1 accounts for the "\n" separator between joined pages.
  const pageChars = pages.map((page) => page.length + 1);
  return { sourceText, pageChars };
}

describe("buildOutlineSectionIndex", () => {
  it("places outline headings at their heading-line offsets", () => {
    const { sourceText, pageChars } = buildSyntheticPaper();
    const index = buildOutlineSectionIndex(sourceText, pageChars, [
      { title: "Abstract", pageIndex: 0 },
      { title: "1 Introduction", pageIndex: 0 },
      { title: "2 Motivating Example", pageIndex: 1 },
      { title: "3 Approach Overview", pageIndex: 2 },
    ]);
    assert.equal(index.length, 4);
    assert.deepEqual(
      index.map((entry) => entry.heading),
      [
        "Abstract",
        "1 Introduction",
        "2 Motivating Example",
        "3 Approach Overview",
      ],
    );
    // Same-page headings resolve to their own lines, not the page start.
    const abstractOffset = index[0].charStart;
    assert.equal(sourceText.slice(abstractOffset).startsWith("ABSTRACT"), true);
    assert.isAbove(index[1].charStart, index[0].charStart);
    assert.equal(
      sourceText.slice(index[1].charStart).startsWith("1 INTRODUCTION"),
      true,
    );
    // charEnd chains to the next section's start; the last runs to the end.
    for (let i = 0; i + 1 < index.length; i += 1) {
      assert.equal(index[i].charEnd, index[i + 1].charStart);
    }
    assert.equal(index.at(-1)?.charEnd, sourceText.length);
    // 1-based page numbers.
    assert.deepEqual(
      index.map((entry) => entry.page),
      [1, 1, 2, 3],
    );
  });

  it("falls back to the page start when the heading line is not found", () => {
    const { sourceText, pageChars } = buildSyntheticPaper();
    const pageTwoStart = pageChars[0];
    const index = buildOutlineSectionIndex(sourceText, pageChars, [
      { title: "Unnamed Section", pageIndex: 1 },
    ]);
    assert.equal(index.length, 1);
    assert.equal(index[0].charStart, pageTwoStart);
  });

  it("drops headings that cannot be placed at a strictly increasing offset", () => {
    const { sourceText, pageChars } = buildSyntheticPaper();
    const index = buildOutlineSectionIndex(sourceText, pageChars, [
      { title: "2 Motivating Example", pageIndex: 1 },
      // Same page, heading line resolves before the previous section start.
      { title: "1 Introduction", pageIndex: 0 },
    ]);
    // Outline order is preserved as given; the Introduction (earlier offset)
    // cannot follow Motivating Example and is dropped instead of inverting.
    assert.deepEqual(
      index.map((entry) => entry.heading),
      ["2 Motivating Example"],
    );
    assert.equal(index[0].charEnd, sourceText.length);
  });

  it("returns empty for empty inputs or out-of-range pages", () => {
    const { sourceText, pageChars } = buildSyntheticPaper();
    assert.deepEqual(buildOutlineSectionIndex("", pageChars, []), []);
    assert.deepEqual(buildOutlineSectionIndex(sourceText, [], []), []);
    assert.deepEqual(
      buildOutlineSectionIndex(sourceText, pageChars, [
        { title: "Beyond", pageIndex: 99 },
      ]),
      [],
    );
    assert.deepEqual(
      buildOutlineSectionIndex(sourceText, pageChars, [
        { title: "   ", pageIndex: 0 },
      ]),
      [],
    );
  });
});
