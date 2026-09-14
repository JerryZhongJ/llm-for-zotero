import { assert } from "chai";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { checkImportCycles, formatCycle } =
  require("../scripts/check-import-cycles.cjs") as {
    checkImportCycles: (root?: string) => {
      unexpectedRuntime: string[][];
      staleAllowedRuntime: string[][];
      unexpectedStatic: string[][];
      staleAllowedStatic: string[][];
    };
    formatCycle: (cycle: string[]) => string;
  };

function formatCycles(cycles: string[][]): string[] {
  return cycles.map((cycle) => formatCycle(cycle));
}

describe("import cycles", function () {
  it("does not introduce cycles outside the current allowlist", function () {
    // The check synchronously walks and parses the whole source tree; a
    // cold CI filesystem can blow past mocha's 2s default even though the
    // cycle graph is clean. The ceiling costs nothing when the scan is fast.
    this.timeout(60000);
    const result = checkImportCycles(process.cwd());
    assert.deepEqual(formatCycles(result.unexpectedRuntime), []);
    assert.deepEqual(formatCycles(result.unexpectedStatic), []);
    assert.deepEqual(formatCycles(result.staleAllowedRuntime), []);
    assert.deepEqual(formatCycles(result.staleAllowedStatic), []);
  });
});
