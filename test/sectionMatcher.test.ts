import { assert } from "chai";
import {
  matchSectionName,
  normalizeSectionName,
  suggestSections,
} from "../src/agent/tools/read/sectionMatcher";

describe("sectionMatcher", function () {
  describe("normalizeSectionName", function () {
    it("strips leading numbering", function () {
      assert.equal(
        normalizeSectionName("3.2 Ablation Study"),
        normalizeSectionName("Ablation Study"),
      );
    });

    it("collapses case, punctuation, and whitespace", function () {
      assert.equal(normalizeSectionName("  Related—Work! "), "related work");
    });

    it("lowercases and trims unicode punctuation", function () {
      assert.equal(normalizeSectionName("Conclusion:"), "conclusion");
    });
  });

  describe("matchSectionName", function () {
    const candidates = [
      "Abstract",
      "1 Introduction",
      "2 Related Work",
      "3 Method",
      "3.2 Ablation Study",
      "4 Experiments and Results",
      "5 Conclusion",
      "References",
    ];

    it("matches exactly ignoring numbering and case", function () {
      const match = matchSectionName("related work", candidates);
      assert.isDefined(match);
      assert.equal(match!.candidate, "2 Related Work");
      assert.equal(match!.score, 1);
    });

    it("matches a numbered subsection without its number", function () {
      const match = matchSectionName("Ablation Study", candidates);
      assert.isDefined(match);
      assert.equal(match!.candidate, "3.2 Ablation Study");
    });

    it("matches when the request adds words the heading lacks", function () {
      const match = matchSectionName("experimental results", candidates);
      assert.isDefined(match);
      assert.equal(match!.candidate, "4 Experiments and Results");
    });

    it("tolerates a one-character typo via fuzzy tokens", function () {
      const match = matchSectionName("Conclustion", candidates);
      assert.isDefined(match);
      assert.equal(match!.candidate, "5 Conclusion");
    });

    it("returns null for an unrelated name", function () {
      assert.isNull(matchSectionName("System Architecture", candidates));
    });

    it("returns null for an empty request", function () {
      assert.isNull(matchSectionName("  ", candidates));
    });
  });

  describe("suggestSections", function () {
    it("ranks near misses first", function () {
      const suggestions = suggestSections("Mthods", ["Abstract", "Method", "Conclusion"]);
      assert.include(suggestions, "Method");
    });

    it("returns empty for an empty request", function () {
      assert.isEmpty(suggestSections("", ["Method"]));
    });
  });
});
