import assert from "node:assert/strict";
import { test } from "node:test";
import { movedOption, tagOptions, tagProblem } from "../src/features/notes/tagOptions.ts";

const choices = ["制御", "機械学習", "Control theory", "深層学習"];

test("every tag is offered while nothing is typed, the paper's own ones marked", () => {
  assert.deepEqual(tagOptions(choices, ["深層学習", "古いタグ"], ""), [
    { kind: "tag", name: "制御", selected: false },
    { kind: "tag", name: "機械学習", selected: false },
    { kind: "tag", name: "Control theory", selected: false },
    { kind: "tag", name: "深層学習", selected: true },
    { kind: "tag", name: "古いタグ", selected: true },
  ]);
});

test("typing filters the tags, those it begins first, and offers a new tag last", () => {
  assert.deepEqual(tagOptions(choices, [], "学習").map((o) => o.name), ["機械学習", "深層学習", "学習"]);
  assert.deepEqual(tagOptions(choices, [], "control").map((o) => [o.kind, o.name]), [["tag", "Control theory"], ["create", "control"]]);
  assert.deepEqual(tagOptions(["theory of control", "Control"], [], "cont").map((o) => o.name), ["Control", "theory of control", "cont"]);
  // A tag with exactly that name is not offered again as new; spaces around it do not count.
  assert.deepEqual(tagOptions(choices, [], "  制御 "), [{ kind: "tag", name: "制御", selected: false }]);
  assert.deepEqual(tagOptions(choices, [], "新しい"), [{ kind: "create", name: "新しい" }]);
});

test("what the sidecar would refuse is said before saving", () => {
  assert.equal(tagProblem("x".repeat(80), []), null);
  assert.match(tagProblem("x".repeat(81), []) ?? "", /80文字/);
  const full = Array.from({ length: 100 }, (_, i) => `t${i}`);
  assert.match(tagProblem("new", full) ?? "", /100個/);
  assert.equal(tagProblem("t1", full), null); // Taking one off.
});

test("the arrows go round the options, Home and End to either end", () => {
  assert.equal(movedOption(-1, "ArrowDown", 3), 0);
  assert.equal(movedOption(2, "ArrowDown", 3), 0);
  assert.equal(movedOption(-1, "ArrowUp", 3), 2);
  assert.equal(movedOption(0, "ArrowUp", 3), 2);
  assert.equal(movedOption(1, "Home", 3), 0);
  assert.equal(movedOption(1, "End", 3), 2);
  assert.equal(movedOption(1, "ArrowDown", 0), -1);
});
