import { assert } from "chai";
import { createEditCurrentNoteTool } from "../src/agent/tools/write/editCurrentNote";
import type { AgentToolContext } from "../src/agent/types";

/**
 * The plan must rate reversibility exactly what execution will record —
 * a "full" the executor cannot honor is the silent-downgrade bug the
 * coordinator now rejects, and a "partial" is no longer a valid rating.
 */
describe("edit_current_note plan reversibility", function () {
  const context = {
    request: { conversationKey: 7, mode: "agent", userText: "", libraryID: 1 },
    item: null,
    currentAnswerText: "",
    modelName: "test",
  } as AgentToolContext;

  const tool = createEditCurrentNoteTool({} as never);

  function planFor(input: Record<string, unknown>) {
    const validated = tool.validate(input);
    assert.isTrue(validated.ok, JSON.stringify(validated));
    if (!validated.ok) throw new Error("unreachable");
    return tool.planMutation!(validated.value, context);
  }

  const localImageContent = "See figure: ![fig](file:///C:/data/fig.png)";

  it("rates create as fully reversible even with local images", function () {
    const plan = planFor({
      mode: "create",
      target: "standalone",
      content: localImageContent,
    });
    assert.equal(plan.reversibility, "full");
  });

  it("rates an edit with local images as irreversible", function () {
    const plan = planFor({
      mode: "edit",
      noteId: 12,
      content: localImageContent,
    });
    assert.equal(plan.reversibility, "none");
    assert.isOk(plan.reason);
  });

  it("rates a plain edit as fully reversible", function () {
    const plan = planFor({
      mode: "edit",
      noteId: 12,
      content: "Just text.",
    });
    assert.equal(plan.reversibility, "full");
  });
});
