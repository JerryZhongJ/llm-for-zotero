import { assert } from "chai";
import { computeReaderPanelInsets } from "../src/modules/contextPanel/readerPanelGeometry";

function rect(left: number, width: number, height = 500) {
  return { left, right: left + width, width, height };
}

describe("reader panel geometry", function () {
  it("converts the iframe view to tab coordinates and stops at the context pane", function () {
    assert.deepEqual(
      computeReaderPanelInsets({
        hostRect: rect(100, 1000),
        frameRect: rect(120, 940),
        viewRect: rect(210, 680),
        splitterRect: rect(850, 5),
        fallbackLeft: 200,
      }),
      { left: 230, right: 250 },
    );
  });

  it("follows the reader view when the sidebars close", function () {
    assert.deepEqual(
      computeReaderPanelInsets({
        hostRect: rect(100, 1000),
        frameRect: rect(100, 1000),
        viewRect: rect(0, 1000),
        splitterRect: rect(1100, 0),
        fallbackLeft: 0,
      }),
      { left: 0, right: 0 },
    );
  });

  it("uses the Zotero sidebar width if the internal view does not expose it", function () {
    assert.deepEqual(
      computeReaderPanelInsets({
        hostRect: rect(100, 1000),
        frameRect: rect(100, 1000),
        viewRect: rect(0, 1000),
        fallbackLeft: 220,
      }),
      { left: 220, right: 0 },
    );
  });
});
