import { assert } from "chai";
import {
  computeReaderPanelInsets,
  computeSidebarRailInsets,
} from "../src/modules/contextPanel/readerPanelGeometry";

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

  it("a trusted DOM measurement collapses the inset even against a stale fallback", function () {
    // The sidebar just closed (viewLeft 0) but the state-based fallbackLeft
    // still carries the old sidebar width — the measurement must win.
    assert.deepEqual(
      computeReaderPanelInsets({
        hostRect: rect(100, 1000),
        frameRect: rect(100, 1000),
        viewRect: rect(0, 1000),
        fallbackLeft: 220,
        trusted: true,
      }),
      { left: 0, right: 0 },
    );
  });

  it("a trusted DOM measurement reports the live sidebar inset", function () {
    assert.deepEqual(
      computeReaderPanelInsets({
        hostRect: rect(100, 1000),
        frameRect: rect(100, 1000),
        viewRect: rect(240, 760),
        fallbackLeft: 0,
        trusted: true,
      }),
      { left: 240, right: 0 },
    );
  });
});

describe("sidebar rail insets", function () {
  it("an open sidebar insets by its right edge, frame offset included", function () {
    assert.deepEqual(
      computeSidebarRailInsets({
        hostRect: rect(100, 1000),
        frameRect: rect(102, 996),
        sidebarRect: { left: 0, right: 240, width: 240, height: 500 },
        splitViewRect: rect(240, 756),
      }),
      { left: 242, right: 2 },
    );
  });

  it("a closed sidebar (element absent) collapses to exactly 0 despite frame residue", function () {
    // .split-view previously reported left: 0 in iframe coords, and the
    // 2px frame offset drifted the panel right after closing. The right
    // edge keeps its measured residue so the panel stays aligned with the
    // pages area's right edge.
    assert.deepEqual(
      computeSidebarRailInsets({
        hostRect: rect(100, 1000),
        frameRect: rect(102, 996),
        splitViewRect: rect(0, 996),
      }),
      { left: 0, right: 2 },
    );
  });

  it("the hidden sidebar state (parked at negative left) does not inset", function () {
    // Callers filter this via rect.left < 0, but the geometry also holds if
    // such a rect slips through with a negative right edge contribution.
    assert.deepEqual(
      computeSidebarRailInsets({
        hostRect: rect(100, 1000),
        frameRect: rect(100, 1000),
        splitViewRect: rect(0, 1000),
      }),
      { left: 0, right: 0 },
    );
  });

  it("the right edge stops at the pages area and the context splitter", function () {
    assert.deepEqual(
      computeSidebarRailInsets({
        hostRect: rect(100, 1000),
        frameRect: rect(100, 900),
        sidebarRect: { left: 0, right: 200, width: 200, height: 500 },
        splitViewRect: rect(200, 700),
        splitterRect: rect(950, 5),
      }),
      { left: 200, right: 150 },
    );
  });

  it("degenerate inputs collapse to zero insets", function () {
    assert.deepEqual(
      computeSidebarRailInsets({
        hostRect: rect(100, 0),
        frameRect: rect(100, 0),
        sidebarRect: { left: 0, right: 240, width: 240, height: 0 },
      }),
      { left: 0, right: 0 },
    );
  });
});
