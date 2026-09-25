import { assert } from "chai";
import { composePdfFetchNoticeMessage } from "../src/modules/contextPanel/pdfFetchNotice";

describe("pdfFetchNotice message composition", function () {
  it("returns empty when nothing was attempted", function () {
    assert.equal(
      composePdfFetchNoticeMessage({ attemptedTitles: [], attachedTitles: [] }),
      "",
    );
  });

  it("lists downloaded titles, capped at two with a remainder", function () {
    const message = composePdfFetchNoticeMessage({
      attemptedTitles: ["Paper A", "Paper B", "Paper C"],
      attachedTitles: ["Paper A", "Paper B", "Paper C"],
    });
    assert.equal(message, "PDF downloaded: Paper A, Paper B (+1 more)");
  });

  it("reports failures when nothing landed", function () {
    const message = composePdfFetchNoticeMessage({
      attemptedTitles: ["Paper A"],
      attachedTitles: [],
    });
    assert.equal(message, "PDF download failed: Paper A");
  });

  it("combines partial success with the failed remainder", function () {
    const message = composePdfFetchNoticeMessage({
      attemptedTitles: ["Paper A", "Paper B", "Paper C"],
      attachedTitles: ["Paper B"],
    });
    assert.equal(message, "PDF 1/3 downloaded · failed: Paper A, Paper C");
  });

  it("shortens long titles", function () {
    const long = "A Very Long Paper Title That Goes On And On Forever";
    const message = composePdfFetchNoticeMessage({
      attemptedTitles: [long],
      attachedTitles: [],
    });
    assert.include(message, "…");
    assert.isAtMost(message.length, "PDF download failed: ".length + 48);
  });
});
