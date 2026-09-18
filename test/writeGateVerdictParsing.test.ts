import { assert } from "chai";
import { judgeIrreversibleWrite } from "../src/agent/writeGate";

/**
 * The gate prompt asks for bare JSON, but the gate model sees the operation's
 * source — for zotero_script that is 2400 chars of brace-bearing JavaScript —
 * and routinely quotes it back. The verdict parser has to find the one real
 * JSON object inside that prose; a failure mode here refuses every
 * irreversible write with "the gate could not interpret its verdict".
 */
describe("write gate verdict parsing", function () {
  const baseRequest = {
    userText: "rename all attachments",
    model: "test-model",
    apiBase: "https://example.test/v1",
    apiKey: "key",
    authMode: "api_key",
    providerProtocol: "openai_chat_compat",
  } as Parameters<typeof judgeIrreversibleWrite>[0]["request"];

  async function judgeWithReply(reply: string) {
    return judgeIrreversibleWrite({
      request: baseRequest,
      toolName: "zotero_script",
      operationSummary: "Mode: write\nScript source:\nfor (const item of items) { item.setField('title', x); }",
      llmCall: async () => reply,
    });
  }

  it("parses a bare JSON verdict", async function () {
    const verdict = await judgeWithReply('{"allow": true, "reason": "covered"}');
    assert.deepEqual(verdict, { kind: "allow", reason: "covered" });
  });

  it("parses the verdict when the reply quotes brace-bearing script source around it", async function () {
    const verdict = await judgeWithReply(
      'The script `for (const item of items) { env.snapshot(item); }` matches the request.\n' +
        'Final answer: {"allow": true, "reason": "batch rename was requested"}',
    );
    assert.equal(verdict.kind, "allow");
  });

  it("parses a fenced JSON verdict", async function () {
    const verdict = await judgeWithReply(
      '```json\n{"allow": false, "reason": "deletes items beyond the request"}\n```',
    );
    assert.equal(verdict.kind, "refuse");
    assert.equal(verdict.reason, "deletes items beyond the request");
  });

  it("accepts a string-typed allow value", async function () {
    const verdict = await judgeWithReply('{"allow": "true", "reason": "ok"}');
    assert.equal(verdict.kind, "allow");
  });

  it("prefers the last object when the reply contains more than one", async function () {
    const verdict = await judgeWithReply(
      '{"allow": false, "reason": "draft"} … {"allow": true, "reason": "final"}',
    );
    assert.equal(verdict.kind, "allow");
    assert.equal(verdict.reason, "final");
  });

  it("does not confuse braces inside JSON strings as object boundaries", async function () {
    const verdict = await judgeWithReply(
      '{"allow": false, "reason": "the pattern {delete} is destructive"}',
    );
    assert.equal(verdict.kind, "refuse");
    assert.equal(verdict.reason, "the pattern {delete} is destructive");
  });

  it("refuses when no verdict object is interpretable", async function () {
    const verdict = await judgeWithReply("I cannot decide this one.");
    assert.equal(verdict.kind, "refuse");
    assert.equal(verdict.reason, "the gate could not interpret its verdict");
  });

  it("refuses when the JSON parses but carries no allow field", async function () {
    const verdict = await judgeWithReply('{"verdict": "maybe"}');
    assert.equal(verdict.kind, "refuse");
    assert.equal(verdict.reason, "the gate could not interpret its verdict");
  });
});
